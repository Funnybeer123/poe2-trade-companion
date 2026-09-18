import { FollowerPlanner, type FollowerConfig, type FollowObservation, type FollowReplayStep } from "./follower.js";

/** Synthetic observations, deliberately separate from the live peer connection. */
export function followerDemo(config: FollowerConfig): FollowReplayStep[] {
  const targetName = config.targetName || "MainCharacter";
  const planner = new FollowerPlanner({ ...config, targetName });
  const cells = ["############", "#..........#", "#....#.....#", "#....#.....#", "#....#.....#", "#..........#", "############"];
  const base: FollowObservation = { capturedAt: 1000, area: "Demo area", player: { x: 2, y: 3 }, confidence: 1, gameplay: true, inventoryFull: false,
    leader: { name: targetName, area: "Demo area", position: { x: 4, y: 1 }, visible: true, confidence: 1 }, map: { aligned: true, cells }, loot: [], confirmedPickupIds: [] };
  const loot = { id: "demo-orb", label: "Exalted Orb", position: { x: 3, y: 3 }, score: 95, confidence: 1 };
  const frames: Array<[string, Partial<FollowObservation>]> = [
    ["Acquire and follow", {}],
    ["Nearby eligible loot", { loot: [loot] }],
    ["Verify the pickup", { loot: [loot] }],
    ["Pickup confirmed; resume following", { player: { x: 3, y: 3 }, confirmedPickupIds: [loot.id] }],
    ["Leader off screen; route around the wall", { leader: { ...base.leader!, position: { x: 9, y: 3 }, visible: false } }],
    ["Inventory full; continue following", { inventoryFull: true }],
    ["Leader identity uncertain", { leader: undefined }],
    ["Loading screen; pause", { gameplay: false }],
  ];
  return frames.map(([title, changes], i) => {
    const observation = structuredClone({ ...base, ...changes, capturedAt: 1000 + i * 200 });
    return { title, observation, decision: planner.decide(observation, observation.capturedAt) };
  });
}
