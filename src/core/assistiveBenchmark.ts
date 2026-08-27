import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type AssistiveSkillId = "deposit-bag-to-stash" | "fill-bag-from-stash";

export interface AssistiveBenchmark {
  id: string;
  skill: AssistiveSkillId;
  startedAt: string;
  elapsedMs: number;
  identifyMs: number;
  actMs: number;
  bagBefore: number;
  bagAfter: number;
  stashBefore: number;
  stashAfter: number;
  actions: number;
  result: string;
  complete: boolean;
  cycle?: number;
}

export function assistiveBenchmarkPath(root = process.cwd()): string {
  return path.join(root, "fixtures", "benchmarks", "assistive-runs.jsonl");
}

export function depositComplete(bagAfter: number): boolean {
  return bagAfter === 0;
}

export function fillComplete(bagAfter: number): boolean {
  return bagAfter >= 60;
}

export function skillComplete(skill: AssistiveSkillId, bagAfter: number): boolean {
  return skill === "deposit-bag-to-stash" ? depositComplete(bagAfter) : fillComplete(bagAfter);
}

export function loadBenchmarks(root = process.cwd()): AssistiveBenchmark[] {
  const file = assistiveBenchmarkPath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AssistiveBenchmark);
}

export function appendBenchmark(root: string, run: AssistiveBenchmark): string {
  const file = assistiveBenchmarkPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(run)}\n`);
  return file;
}

export function summarizeBenchmark(run: AssistiveBenchmark, previous?: AssistiveBenchmark): string {
  const delta =
    previous && previous.skill === run.skill
      ? `, vs last ${previous.elapsedMs}ms (${run.elapsedMs - previous.elapsedMs >= 0 ? "+" : ""}${run.elapsedMs - previous.elapsedMs}ms)`
      : "";
  const cycle = run.cycle != null ? ` c${run.cycle}` : "";
  return `${run.skill}${cycle} ${run.complete ? "complete" : "incomplete"} ${run.elapsedMs}ms bag ${run.bagBefore}->${run.bagAfter} actions=${run.actions} ${run.result}${delta}`;
}
