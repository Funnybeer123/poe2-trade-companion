import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { FollowerService } from "../../src/main/followerService.js";

const services: FollowerService[] = [], directories: string[] = [];
function service(blocked?: () => string | undefined) {
  const directory = mkdtempSync(path.join(tmpdir(), "poe-follower-test-")); directories.push(directory);
  const s = new FollowerService(directory, blocked); services.push(s); return s;
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); return address.port;
}
afterEach(() => { services.splice(0).forEach(s => s.stop()); directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
describe("two-PC follower service", () => {
  it("pairs over real sockets, reports latency, detects loss, and reconnects", async () => {
    const leader = service(), follower = service(), p = await port(), key = leader.generateKey();
    leader.configure({ ...leader.status().config, role: "leader", port: p, targetName: "MyMain" });
    follower.configure({ ...follower.status().config, port: p });
    await leader.start(key); await follower.start(key);
    await expect.poll(() => follower.status().connection).toBe("connected");
    expect(follower.status()).toMatchObject({ peerName: "MyMain", capability: "connection-preview", roundTripMs: expect.any(Number) });
    expect(leader.status().connection).toBe("connected");
    leader.stop();
    await expect.poll(() => follower.status().connection).toBe("disconnected");
    expect(follower.status().peerName).toBeUndefined();
    await leader.start(key);
    await expect.poll(() => follower.status().connection, { timeout: 5000 }).toBe("connected");
  });
  it("rejects a mismatched key and never reports an authenticated peer", async () => {
    const leader = service(), follower = service(), p = await port();
    leader.configure({ ...leader.status().config, role: "leader", port: p });
    follower.configure({ ...follower.status().config, port: p });
    await leader.start(leader.generateKey()); await follower.start(follower.generateKey());
    await expect.poll(() => follower.status().connection).toBe("disconnected");
    expect(follower.status().reason).toContain("Pairing rejected");
    expect(leader.status().connection).toBe("listening");
  });
  it("persists preferences but never the pairing key or running state", async () => {
    const s = service(), key = s.generateKey();
    s.configure({ ...s.status().config, targetName: "Main", pairingKey: key });
    const file = readFileSync(path.join(directories[0], "settings.json"), "utf8");
    expect(file).not.toContain(key);
    const restored = new FollowerService(directories[0]); services.push(restored);
    expect(restored.status()).toMatchObject({ connection: "stopped", config: { targetName: "Main" } });
  });
  it("stop cancels a connecting request and late completion cannot reconnect it", async () => {
    const s = service(); s.configure({ ...s.status().config, port: await port() });
    await s.start(s.generateKey()); s.stop();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(s.status()).toMatchObject({ connection: "stopped", peerName: undefined });
  });
  it("enforces the emergency latch while keeping the input-free demo available", async () => {
    const s = service(() => "Emergency stop");
    await expect(s.start(s.generateKey())).rejects.toThrow("Emergency stop");
    expect(s.demo()).toHaveLength(8);
  });
  it("reports port conflicts and invalid pairing data", async () => {
    const a = service(), b = service(), p = await port();
    for (const s of [a, b]) s.configure({ ...s.status().config, role: "leader", port: p });
    await a.start(a.generateKey());
    await expect(b.start(b.generateKey())).rejects.toThrow("Cannot listen");
    expect(b.status().connection).toBe("error");
    await expect(service().start("short")).rejects.toThrow("pairing key");
  });
});
