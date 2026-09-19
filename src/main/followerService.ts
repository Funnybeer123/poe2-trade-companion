import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, type ClientRequest, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultFollowerConfig, isLocalAddress, parseFollowerConfig, type FollowerConfig } from "../core/follower.js";
import { followerDemo } from "../core/followerReplay.js";
import type { FollowerStatus } from "../shared/follower.js";

const ENDPOINT = "/v1/follower";
const signature = (key: string, body: string) => createHmac("sha256", Buffer.from(key, "hex")).update(body).digest("hex");
const authentic = (key: string, body: string, supplied: unknown) => typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(signature(key, body), "hex"), Buffer.from(supplied, "hex"));
export function followerAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(i => i.family === "IPv4" && !i.internal && isLocalAddress(i.address)).map(i => i.address)))];
}
/** Authenticated connection health only. No remote command endpoint or input sink. */
export class FollowerService {
  private config = defaultFollowerConfig();
  private connection: FollowerStatus["connection"] = "stopped";
  private reason = "Set up both PCs, or try the route preview.";
  private server?: Server;
  private pending?: ClientRequest;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private lastSeenAt?: number;
  private roundTripMs?: number;
  private peerName?: string;
  constructor(private readonly directory: string, private readonly blocked: () => string | undefined = () => undefined) {
    try { const file = path.join(directory, "settings.json"); if (existsSync(file)) this.config = parseFollowerConfig(JSON.parse(readFileSync(file, "utf8"))); }
    catch { this.reason = "Saved follower settings are invalid. Review and save them again."; }
  }
  /** Cheap read for per-capture loops: status() enumerates network adapters and deep-clones. */
  get followTarget(): { targetName: string; followDistance: number; confidence: number; lootEnabled: boolean; lootLeash: number } { const c = this.config; return { targetName: c.targetName, followDistance: c.followDistance, confidence: c.confidence, lootEnabled: c.lootEnabled, lootLeash: c.lootLeash }; }
  status(): FollowerStatus {
    const stale = this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt > 2000;
    return structuredClone({ config: this.config, connection: stale && this.connection === "connected" ? "disconnected" : this.connection,
      reason: stale && this.connection === "connected" ? "Peer heartbeat expired. Waiting for reconnection." : this.reason,
      lastSeenAt: this.lastSeenAt, roundTripMs: stale ? undefined : this.roundTripMs, peerName: stale ? undefined : this.peerName,
      addresses: followerAddresses(), capability: "connection-preview" });
  }
  configure(raw: unknown): FollowerStatus {
    const config = parseFollowerConfig(raw);
    this.stop();
    mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, "settings.json"), temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(config, null, 2)); renameSync(temporary, file);
    this.config = config; this.reason = "Settings saved. Start the connection on both PCs.";
    return this.status();
  }
  generateKey(): string { return randomBytes(32).toString("hex"); }
  stop(reason = "Connection stopped."): FollowerStatus {
    this.generation++; clearTimeout(this.timer); this.timer = undefined;
    this.pending?.destroy(); this.pending = undefined;
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined;
    this.connection = "stopped"; this.reason = reason; this.lastSeenAt = undefined; this.roundTripMs = undefined; this.peerName = undefined;
    return this.status();
  }
  demo() { return followerDemo(this.config); }
  async start(raw: unknown): Promise<FollowerStatus> {
    const blocked = this.blocked();
    if (blocked) throw new Error(blocked);
    if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) throw new Error("Generate a pairing key on the main PC and enter the same key on the follower PC.");
    this.stop();
    const generation = this.generation, key = raw;
    if (this.config.role === "leader") {
      if (this.config.address !== "127.0.0.1" && !followerAddresses().includes(this.config.address)) throw new Error("Choose this PC's local IPv4 address for the listener.");
      const server = this.server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json");
        res.setHeader("Connection", "close");
        const nonce = req.headers["x-follow-nonce"];
        if (this.blocked() || generation !== this.generation || req.headers.origin || req.method !== "GET" || req.url !== ENDPOINT || req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) !== 0 || typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce) || !authentic(key, `request:${nonce}`, req.headers["x-follow-signature"])) { res.writeHead(403).end("{}"); return; }
        const body = JSON.stringify({ version: 1, nonce, name: this.config.targetName, capability: "connection-preview" });
        res.setHeader("X-Follow-Signature", signature(key, `response:${body}`));
        this.connection = "connected"; this.lastSeenAt = Date.now(); this.reason = "Follower connected. Live route perception is not connected yet.";
        res.end(body);
      });
      server.maxConnections = 4; server.requestTimeout = 2000; server.headersTimeout = 2000; server.setTimeout(2000, socket => socket.destroy());
      this.connection = "listening"; this.reason = "Waiting for the follower PC.";
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.config.port, this.config.address, () => { server.removeListener("error", reject); resolve(); });
        });
        if (generation !== this.generation) { server.close(); return this.status(); }
        server.on("error", () => { if (generation === this.generation) { this.stop(); this.connection = "error"; this.reason = "Listener failed. Check the address and port, then restart the connection."; } });
      } catch {
        server.close();
        if (generation === this.generation) { this.stop(); this.connection = "error"; this.reason = "Cannot listen on this address and port. Check whether another app is using it."; throw new Error(this.reason); }
      }
    } else {
      this.connection = "connecting"; this.reason = "Connecting to the main PC…";
      void this.poll(key, generation);
    }
    return this.status();
  }
  private async poll(key: string, generation: number): Promise<void> {
    const blocked = this.blocked();
    if (generation !== this.generation) return;
    if (blocked) { this.stop(blocked); return; }
    const nonce = randomBytes(16).toString("hex"), started = performance.now();
    try {
      const name = await new Promise<string>((resolve, reject) => {
        const req = this.pending = request({ hostname: this.config.address, port: this.config.port, path: ENDPOINT, method: "GET", agent: false,
          headers: { "X-Follow-Nonce": nonce, "X-Follow-Signature": signature(key, `request:${nonce}`) } }, res => {
          if (res.statusCode !== 200) { res.resume(); reject(new Error("Pairing rejected. Check that both PCs use the same key.")); return; }
          let body = "";
          res.setEncoding("utf8");
          res.on("error", reject);
          res.on("data", (chunk: string) => { body += chunk; if (Buffer.byteLength(body) > 4096) { res.destroy(); reject(new Error("Peer response exceeded the size limit.")); } });
          res.on("end", () => {
            try {
              if (!authentic(key, `response:${body}`, res.headers["x-follow-signature"])) throw new Error("Peer authentication failed.");
              const payload = JSON.parse(body);
              if (payload.version !== 1 || payload.nonce !== nonce || payload.capability !== "connection-preview" || typeof payload.name !== "string" || payload.name.length > 80) throw new Error("Incompatible peer response.");
              resolve(payload.name);
            } catch (e) { reject(e); }
          });
        });
        const deadline = setTimeout(() => req.destroy(new Error("Main PC did not respond. Check its listener and local network.")), 1500);
        req.on("close", () => clearTimeout(deadline)); req.on("error", reject); req.end();
      });
      if (generation !== this.generation) return;
      this.pending = undefined; this.connection = "connected"; this.lastSeenAt = Date.now(); this.roundTripMs = Math.round(performance.now() - started); this.peerName = name;
      this.reason = "Main PC connected. Live route perception is not connected yet.";
    } catch (e) {
      if (generation !== this.generation) return;
      this.pending = undefined; this.connection = "disconnected"; this.peerName = undefined; this.roundTripMs = undefined;
      this.reason = e instanceof Error ? e.message : "Connection failed. Retrying…";
    }
    if (generation === this.generation) this.timer = setTimeout(() => void this.poll(key, generation), this.connection === "connected" ? 500 : 1500);
  }
}
