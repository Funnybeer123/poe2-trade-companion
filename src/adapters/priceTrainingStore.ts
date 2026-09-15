/** Shared app/CLI price lessons. Edits and removals append history, never erase it. */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { trainingIdentity, validatePriceLessonInput, type PriceLesson, type PriceLessonInput } from "../core/priceTraining.js";
import type { PriceReviewItem } from "../shared/priceTraining.js";
import type { EvaluateWithAppraisalOptions } from "../core/appraisal.js";
import type { TierVerdict } from "../core/valueTiers.js";
export type { PriceReviewItem } from "../shared/priceTraining.js";

export const PRICE_TRAINING_FILE = "price-training.jsonl";
export function loadPriceTrainingContext(dir: string, league?: string, now?: Date):
  Pick<EvaluateWithAppraisalOptions, "training" | "trainingError"> {
  try {
    const lessons = new PriceTrainingStore(dir).list();
    if (!league || /^(auto|unassigned)$/i.test(league)) return {};
    return { training: { league, lessons, ...(now ? { now } : {}) } };
  } catch (error) { return { trainingError: String(error) }; }
}

export function needsPriceReview(verdict: TierVerdict): boolean {
  if (verdict.source === "safety") return false;
  if (verdict.training?.status === "stale" || verdict.training?.status === "conflict") return true;
  // A decision resolves keep/list/discard locally; only a review outcome asks for a human.
  if (verdict.decision) return verdict.decision.outcome === "review";
  return verdict.tier === "unknown" || (verdict.source === "heuristic" && !verdict.appraisal?.estimatedValue);
}

/** The queue reason, priority-tagged ("[P1] …") when a decision explains the need. */
export function reviewReasonFor(verdict: TierVerdict): string {
  const need = verdict.decision?.review;
  if (need) return `[P${need.priority}] ${need.reason}`;
  return verdict.reasons.join(" ");
}

type Event = { version: 1; at: string } & (
  | { kind: "lesson-save"; lesson: PriceLesson }
  | { kind: "lesson-remove"; id: string }
  | { kind: "review-save"; item: PriceReviewItem }
  | { kind: "review-dismiss"; id: string }
);
const leagueKey = (league: string): string => league.trim().toLowerCase();
const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 128;
const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export class PriceTrainingStore {
  private readonly file: string;
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(dir, PRICE_TRAINING_FILE);
  }

  private read(): { lessons: Map<string, PriceLesson>; review: Map<string, PriceReviewItem> } {
    const lessons = new Map<string, PriceLesson>();
    const review = new Map<string, PriceReviewItem>();
    if (!existsSync(this.file)) return { lessons, review };
    const lines = readFileSync(this.file, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Event;
        if (event.version !== 1 || !validDate(event.at)) throw new Error("invalid event");
        if (event.kind === "lesson-save") {
          const check = validatePriceLessonInput(event.lesson);
          if (!check.valid || !validId(event.lesson.id) || !validDate(event.lesson.createdAt) ||
              !validDate(event.lesson.updatedAt)) throw new Error("invalid lesson");
          lessons.set(event.lesson.id, { ...check.value, id: event.lesson.id,
            createdAt: event.lesson.createdAt, updatedAt: event.lesson.updatedAt });
        } else if (event.kind === "lesson-remove" && validId(event.id)) {
          lessons.delete(event.id);
        } else if (event.kind === "review-save") {
          const item = event.item;
          const identity = trainingIdentity(item.itemText);
          if (!validId(item.id) || typeof item.league !== "string" || typeof item.reason !== "string" ||
              item.fingerprint !== identity.fingerprint || item.groupKey !== identity.groupKey ||
              !Number.isInteger(item.seenCount) || item.seenCount < 1 ||
              !validDate(item.firstSeen) || !validDate(item.lastSeen)) {
            throw new Error("invalid review item");
          }
          review.set(item.id, item);
        } else if (event.kind === "review-dismiss" && validId(event.id)) {
          review.delete(event.id);
        } else throw new Error("unknown event");
      } catch {
        throw new Error(`Price training history is unreadable at line ${index + 1}; preserve ${this.file} for repair.`);
      }
    }
    return { lessons, review };
  }

  private append(event: Event): void {
    mkdirSync(this.dir, { recursive: true });
    const previous = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
    const separator = previous && !previous.endsWith("\n") ? "\n" : "";
    appendFileSync(this.file, `${separator}${JSON.stringify(event)}\n`, "utf8");
  }

  list(league?: string): PriceLesson[] {
    return [...this.read().lessons.values()].filter((lesson) => !league || leagueKey(lesson.league) === leagueKey(league))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(input: PriceLessonInput, id?: string): PriceLesson {
    const check = validatePriceLessonInput(input);
    if (!check.valid) throw new Error(check.errors.join(" "));
    const state = this.read();
    const identity = trainingIdentity(check.value.itemText);
    const previous = id ? state.lessons.get(id) : [...state.lessons.values()].find((lesson) =>
      leagueKey(lesson.league) === leagueKey(check.value.league) &&
      trainingIdentity(lesson.itemText).fingerprint === identity.fingerprint);
    if (id && !previous) throw new Error("That price lesson no longer exists.");
    if (id && [...state.lessons.values()].some((lesson) => lesson.id !== id &&
        leagueKey(lesson.league) === leagueKey(check.value.league) &&
        trainingIdentity(lesson.itemText).fingerprint === identity.fingerprint)) {
      throw new Error("This item already has a price lesson in that league; edit that lesson instead.");
    }
    if (!previous && state.lessons.size >= 1000) throw new Error("The lesson library is full; remove an obsolete lesson first.");
    const at = this.now().toISOString();
    const lesson: PriceLesson = { ...check.value, observedAt: check.value.observedAt ?? at,
      id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? at, updatedAt: at };
    this.append({ version: 1, at, kind: "lesson-save", lesson });
    for (const item of state.review.values()) {
      if (leagueKey(item.league) === leagueKey(lesson.league) && item.fingerprint === identity.fingerprint) {
        this.append({ version: 1, at, kind: "review-dismiss", id: item.id });
      }
    }
    return lesson;
  }

  remove(id: string): void {
    if (this.read().lessons.has(id)) this.append({ version: 1, at: this.now().toISOString(), kind: "lesson-remove", id });
  }

  enqueue(league: string, itemText: string, reason: string): void {
    const assignedLeague = league.trim() || "Unassigned";
    const identity = trainingIdentity(itemText);
    const state = this.read();
    const previous = [...state.review.values()].find((item) => leagueKey(item.league) === leagueKey(assignedLeague) &&
      item.fingerprint === identity.fingerprint);
    if (!previous && state.review.size >= 500) throw new Error("Price review queue is full; review or dismiss older items.");
    const at = this.now().toISOString();
    const item: PriceReviewItem = { id: previous?.id ?? randomUUID(), league: assignedLeague,
      itemText, fingerprint: identity.fingerprint, groupKey: identity.groupKey, reason: reason.slice(0, 2000),
      firstSeen: previous?.firstSeen ?? at, lastSeen: at, seenCount: (previous?.seenCount ?? 0) + 1 };
    this.append({ version: 1, at, kind: "review-save", item });
  }

  review(league?: string): PriceReviewItem[] {
    return [...this.read().review.values()].filter((item) => !league || leagueKey(item.league) === leagueKey(league))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  dismissReview(id: string): void {
    if (this.read().review.has(id)) this.append({ version: 1, at: this.now().toISOString(), kind: "review-dismiss", id });
  }
}
