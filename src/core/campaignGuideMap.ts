/**
 * Schematic world-map layout for the campaign guide (P8 §7.6).
 *
 * There are no vendor area previews to draw, so the map is a graph: one lane
 * per act, the main path on the lane's spine, side areas hanging under the
 * main area they connect to, `exits` as edges. Pure and deterministic (no
 * randomness, no measuring) so the renderer only has to turn the numbers
 * into <svg> and the test can snapshot the coordinates.
 */
import type { MergedRoute } from "./campaignGuide.js";

export interface MapNode {
  id: string;
  name: string;
  x: number;
  y: number;
  /** actKey of the lane it sits in. */
  act: string;
  town: boolean;
  waypoint: boolean;
  branch: boolean;
  level: number;
  hidden: boolean;
}

export interface MapEdge {
  from: string;
  to: string;
  /** Drawn dashed: the two ends live in different lanes. */
  crossAct: boolean;
}

export interface MapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  lanes: Array<{ key: string; label: string; y: number }>;
  viewBox: { width: number; height: number };
}

export interface MapLayoutOptions {
  laneHeight?: number;
  nodeGap?: number;
  branchDrop?: number;
  margin?: number;
  includeHidden?: boolean;
}

export const MAP_DEFAULTS = {
  laneHeight: 120,
  nodeGap: 118,
  branchDrop: 52,
  margin: 48,
} as const;

export function layoutCampaignMap(merged: MergedRoute, options: MapLayoutOptions = {}): MapLayout {
  const laneHeight = options.laneHeight ?? MAP_DEFAULTS.laneHeight;
  const nodeGap = options.nodeGap ?? MAP_DEFAULTS.nodeGap;
  const branchDrop = options.branchDrop ?? MAP_DEFAULTS.branchDrop;
  const margin = options.margin ?? MAP_DEFAULTS.margin;
  const includeHidden = options.includeHidden === true;

  const nodes: MapNode[] = [];
  const lanes: MapLayout["lanes"] = [];
  const laneOf = new Map<string, string>();
  let maxX = margin;

  for (const [laneIndex, act] of merged.acts.entries()) {
    const y = margin + laneIndex * laneHeight;
    lanes.push({ key: act.key, label: act.label, y });
    const areas = act.areas.filter((area) => includeHidden || !area.hidden);
    const main = areas.filter((area) => !area.branch);
    const branches = areas.filter((area) => area.branch);

    const placed = new Map<string, MapNode>();
    for (const [index, area] of main.entries()) {
      const node: MapNode = {
        id: area.id,
        name: area.name,
        x: margin + index * nodeGap,
        y,
        act: act.key,
        town: area.town === true,
        waypoint: area.waypoint === true,
        branch: false,
        level: area.level,
        hidden: area.hidden,
      };
      nodes.push(node);
      placed.set(area.id, node);
      laneOf.set(area.id, act.key);
      maxX = Math.max(maxX, node.x);
    }

    const siblings = new Map<string, number>();
    let previousMain: MapNode | undefined = main.length ? placed.get(main[0].id) : undefined;
    for (const area of branches) {
      // The parent is the first main-path area either side of the connection.
      let parent = main.find(
        (candidate) => area.exits.includes(candidate.id) || candidate.exits.includes(area.id),
      );
      const parentNode = (parent ? placed.get(parent.id) : undefined) ?? previousMain;
      const anchorX = parentNode ? parentNode.x : margin;
      const key = parentNode?.id ?? "__none";
      const seat = siblings.get(key) ?? 0;
      siblings.set(key, seat + 1);
      const node: MapNode = {
        id: area.id,
        name: area.name,
        x: anchorX + nodeGap * 0.5 + seat * nodeGap * 0.7,
        y: y + branchDrop,
        act: act.key,
        town: area.town === true,
        waypoint: area.waypoint === true,
        branch: true,
        level: area.level,
        hidden: area.hidden,
      };
      nodes.push(node);
      placed.set(area.id, node);
      laneOf.set(area.id, act.key);
      maxX = Math.max(maxX, node.x);
      previousMain = parentNode ?? previousMain;
    }
  }

  const known = new Set(nodes.map((node) => node.id));
  const edges: MapEdge[] = [];
  const seenEdges = new Set<string>();
  for (const act of merged.acts) {
    for (const area of act.areas) {
      if (!known.has(area.id)) continue;
      for (const exit of area.exits) {
        if (!known.has(exit)) continue;
        const key = `${area.id}>${exit}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push({ from: area.id, to: exit, crossAct: laneOf.get(area.id) !== laneOf.get(exit) });
      }
    }
  }

  return {
    nodes,
    edges,
    lanes,
    viewBox: {
      width: Math.round(maxX + margin),
      height: Math.round(lanes.length * laneHeight + margin),
    },
  };
}

/** Space-separated class names for one node (the renderer's only styling input). */
export function mapNodeClass(
  node: MapNode,
  state: { currentId?: string; visited: ReadonlySet<string>; selectedId?: string },
): string {
  const classes = ["node"];
  if (node.town) classes.push("town");
  else if (node.waypoint) classes.push("waypoint");
  if (node.branch) classes.push("branch");
  if (state.currentId === node.id) classes.push("current");
  if (state.visited.has(node.id)) classes.push("visited");
  if (state.selectedId === node.id) classes.push("selected");
  return classes.join(" ");
}
