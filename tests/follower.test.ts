import { describe, expect, it } from "vitest";
import { defaultFollowerConfig, FollowerPlanner, followRoute, isLocalAddress, parseFollowerConfig, validFollowObservation } from "../src/core/follower.js";
import { followerDemo } from "../src/core/followerReplay.js";

const config = () => ({ ...defaultFollowerConfig(), targetName: "MainCharacter" });
const frame = () => structuredClone(followerDemo(config())[0].observation);
describe("follower planner", () => {
  it("replays follow, loot, verification, resume, and off-screen map recovery deterministically", () => {
    const first = followerDemo(config());
    expect(first).toEqual(followerDemo(config()));
    expect(first.map(s => s.decision.phase)).toEqual(["following", "looting", "verifying-loot", "following", "rejoining", "following", "acquiring", "paused"]);
    const route = first[4].decision.route;
    expect(route.length).toBeGreaterThan(8);
    expect(route.every(p => first[4].observation.map!.cells[p.y][p.x] === ".")).toBe(true);
    expect(route[route.length - 1]).toEqual({ x: 9, y: 3 });
  });
  it("never traverses unknown cells, walls, or a diagonal corner", () => {
    expect(followRoute([".#", "#."], { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([]);
    expect(followRoute([".?."], { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual([]);
  });
  it("does not infer a shared coordinate system or route from a leader marker", () => {
    const f = frame(); f.leader!.visible = false; f.map!.aligned = false;
    expect(new FollowerPlanner(config()).decide(f, 1000)).toMatchObject({ phase: "paused", route: [], reason: expect.stringContaining("aligned") });
    f.map!.aligned = true; f.map!.cells = ["############", "############", "############", "############", "############", "############", "############"];
    expect(new FollowerPlanner(config()).decide(f, 1000).phase).toBe("paused");
  });
  it.each(["wrong-name", "uncertain", "missing"])("waits for the correct leader: %s", mode => {
    const f = frame();
    if (mode === "wrong-name") f.leader!.name = "SomeoneElse";
    if (mode === "uncertain") f.leader!.confidence = .2;
    if (mode === "missing") f.leader = undefined;
    expect(new FollowerPlanner(config()).decide(f, 1000).phase).toBe("acquiring");
  });
  it("rejects stale, future, and duplicate observations", () => {
    expect(new FollowerPlanner(config()).decide(frame(), 1501).phase).toBe("paused");
    expect(new FollowerPlanner(config()).decide(frame(), 999).phase).toBe("paused");
    const p = new FollowerPlanner(config()); p.decide(frame(), 1000);
    expect(p.decide(frame(), 1000).phase).toBe("paused");
  });
  it("abandons a pending pickup when the leader leaves the screen", () => {
    const p = new FollowerPlanner(config()), f = followerDemo(config())[1].observation;
    expect(p.decide(f, f.capturedAt).phase).toBe("looting");
    f.capturedAt += 100; f.leader!.visible = false;
    expect(p.decide(f, f.capturedAt).phase).toBe("rejoining");
  });
  it("caps pickup attempts and does not interpret label disappearance as success", () => {
    const p = new FollowerPlanner(config()), f = followerDemo(config())[1].observation;
    expect(p.decide(f, f.capturedAt).phase).toBe("looting");
    f.capturedAt += 800;
    expect(p.decide(f, f.capturedAt).phase).toBe("looting");
    f.capturedAt += 800;
    expect(p.decide(f, f.capturedAt).phase).toBe("following");
    f.capturedAt += 800;
    expect(p.decide(f, f.capturedAt).lootId).toBeUndefined();
    const missing = new FollowerPlanner(config()); f.capturedAt += 800;
    missing.decide(f, f.capturedAt); f.capturedAt += 800; f.loot = [];
    expect(missing.decide(f, f.capturedAt).phase).toBe("following");
  });
  it("ignores low-score loot, full inventory, and unreachable loot", () => {
    for (const kind of ["score", "full", "blocked", "disabled"]) {
      const f = followerDemo(config())[1].observation;
      if (kind === "score") f.loot[0].score = 1;
      if (kind === "full") f.inventoryFull = true;
      if (kind === "blocked") f.loot[0].position = { x: 5, y: 3 };
      const p = new FollowerPlanner({ ...config(), lootEnabled: kind !== "disabled" });
      expect(p.decide(f, f.capturedAt).phase).toBe("following");
    }
  });
  it("pauses for area transitions and stalled movement", () => {
    const f = frame(); f.leader!.area = "Other area";
    expect(new FollowerPlanner(config()).decide(f, 1000).reason).toContain("changed area");
    const p = new FollowerPlanner(config()), still = frame(); p.decide(still, 1000);
    still.capturedAt = 3100;
    expect(p.decide(still, 3100).reason).toContain("No movement progress");
    still.capturedAt = 3200;
    expect(p.decide(still, 3200).reason).toContain("No movement progress");
    still.capturedAt = 3300; still.player.x += 1;
    expect(p.decide(still, 3300).phase).toBe("following");
  });
  it("validates perception before using any coordinates", () => {
    const f = frame(); f.player.x = NaN;
    expect(validFollowObservation(f)).toBe(false);
    expect(new FollowerPlanner(config()).decide(f, 1000).phase).toBe("paused");
    const oversized = frame(); oversized.map!.cells = Array(65).fill(".");
    expect(validFollowObservation(oversized)).toBe(false);
  });
});
describe("follower settings", () => {
  it("only accepts local IPv4 destinations", () => {
    for (const address of ["127.0.0.1", "192.168.1.10", "10.1.2.3", "172.31.0.1"]) expect(isLocalAddress(address)).toBe(true);
    for (const address of ["0.0.0.0", "8.8.8.8", "localhost", "192.168.1.999", "127.00.0.1", "172.32.0.1"]) expect(isLocalAddress(address)).toBe(false);
  });
  it("rejects invalid settings and drops unknown fields including secrets", () => {
    expect(() => parseFollowerConfig({ ...config(), lootLeash: 1 })).toThrow();
    expect(() => parseFollowerConfig({ ...config(), confidence: NaN })).toThrow();
    expect(parseFollowerConfig({ ...config(), pairingKey: "secret" })).not.toHaveProperty("pairingKey");
  });
});
