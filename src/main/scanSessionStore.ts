import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SCAN_CONTRACT_VERSION,
  assertClientPoint,
  assertScanGridCell,
  assertScanSessionContext,
  isUtcTimestamp,
  parseJsonlWithPartialRecovery,
  toUtcTimestamp,
  type JsonlParseIssue,
  type ScanSessionContext,
  type ScanSlotDraft,
  type ScanSlotRecord,
  type ScanSlotStatus,
} from "../core/scanContracts.js";
import {
  restoreScanPlannerSnapshot,
  type ScanPlannerSnapshot,
} from "../core/scanPlanner.js";

export const SCAN_SESSION_JOURNAL_VERSION = 1 as const;
export const DEFAULT_MAX_SCAN_SLOT_RECORDS = 2_304;
export const DEFAULT_MAX_SCAN_TEXT_CHARS = 65_536;
export const DEFAULT_MAX_SCAN_SNAPSHOT_CHARS = 1_048_576;

export type ScanSessionStatus = "active" | "finished" | "aborted" | "failed";
export type ScanSessionTerminalStatus = Exclude<ScanSessionStatus, "active">;

export interface ScanSessionSummary {
  totalRecords: number;
  uniqueCoordinates: number;
  statuses: Record<ScanSlotStatus, number>;
}

export interface ScanSession {
  id: string;
  status: ScanSessionStatus;
  context: ScanSessionContext;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  terminalReason?: string;
  terminalError?: string;
  slots: ScanSlotRecord[];
  plannerSnapshot?: ScanPlannerSnapshot;
  summary?: ScanSessionSummary;
  nextSessionSequence: number;
}

interface JournalBase {
  journalVersion: typeof SCAN_SESSION_JOURNAL_VERSION;
  journalSequence: number;
  sessionSequence: number;
  sessionId: string;
  at: string;
}

export interface ScanSessionStartedEvent extends JournalBase {
  recordType: "scan-session-started";
  context: ScanSessionContext;
}

export interface ScanSlotAppendedEvent extends JournalBase {
  recordType: "scan-slot-appended";
  slot: ScanSlotRecord;
}

export interface ScanSnapshotSavedEvent extends JournalBase {
  recordType: "scan-snapshot-saved";
  snapshot: ScanPlannerSnapshot;
}

export interface ScanSessionResumedEvent extends JournalBase {
  recordType: "scan-session-resumed";
  reason: string;
}

export interface ScanSessionTerminalEvent extends JournalBase {
  recordType:
    | "scan-session-finished"
    | "scan-session-aborted"
    | "scan-session-failed";
  reason: string;
  error?: string;
  summary: ScanSessionSummary;
}

export type ScanSessionJournalEvent =
  | ScanSessionStartedEvent
  | ScanSlotAppendedEvent
  | ScanSnapshotSavedEvent
  | ScanSessionResumedEvent
  | ScanSessionTerminalEvent;

export interface ScanSessionNotification {
  event: ScanSessionJournalEvent;
  session: ScanSession;
}

export type ScanSessionSubscriber = (
  notification: ScanSessionNotification,
) => void | Promise<void>;

/**
 * Minimal append-only storage boundary. Implementations must never rewrite or
 * truncate existing session data when append is called.
 */
export interface ScanSessionStorage {
  readAll(): Promise<string>;
  appendLine(line: string): Promise<void>;
}

function normalizeJournalLine(line: string): string {
  if (/[\r\n]/.test(line)) throw new Error("scan-journal-line-must-be-single-line");
  return line;
}

/**
 * Test/replay storage with the same partial-tail separation semantics as the
 * file implementation.
 */
export class InMemoryScanSessionStorage implements ScanSessionStorage {
  private text: string;

  constructor(seed = "") {
    this.text = seed;
  }

  async readAll(): Promise<string> {
    return this.text;
  }

  async appendLine(line: string): Promise<void> {
    const normalized = normalizeJournalLine(line);
    if (this.text.length > 0 && !/(?:\r\n|\n)$/.test(this.text)) {
      this.text += "\n";
    }
    this.text += `${normalized}\n`;
  }

  contents(): string {
    return this.text;
  }
}

/** Append-only JSONL storage. A damaged partial tail is separated, not erased. */
export class JsonlScanSessionStorage implements ScanSessionStorage {
  private prepared = false;
  private prefix = "";

  constructor(readonly filePath: string) {}

  async readAll(): Promise<string> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async appendLine(line: string): Promise<void> {
    const normalized = normalizeJournalLine(line);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (!this.prepared) {
      const current = await this.readAll();
      this.prefix =
        current.length > 0 && !/(?:\r\n|\n)$/.test(current) ? "\n" : "";
      this.prepared = true;
    }
    const prefix = this.prefix;
    this.prefix = "";
    await appendFile(this.filePath, `${prefix}${normalized}\n`, "utf8");
  }
}

export interface ScanSessionStoreLimits {
  maxSlotRecordsPerSession: number;
  maxTextChars: number;
  maxSnapshotChars: number;
}

export interface ScanSessionStoreOptions {
  clock?: () => string | number | Date;
  idFactory?: () => string;
  limits?: Partial<ScanSessionStoreLimits>;
}

export interface CreateScanSessionInput {
  id?: string;
  context: ScanSessionContext;
  startedAt?: string | number | Date;
}

export interface ScanSessionReloadReport {
  recoveredPartialLine: boolean;
  partialLine?: string;
  issues: JsonlParseIssue[];
  sessionsLoaded: number;
  eventsLoaded: number;
}

interface InternalSession extends ScanSession {
  latestByCoordinate: Map<string, ScanSlotRecord>;
}

function cellKey(slot: Pick<ScanSlotDraft, "cell">): string {
  return `${slot.cell.row},${slot.cell.col}`;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSession(session: InternalSession): ScanSession {
  return {
    id: session.id,
    status: session.status,
    context: cloneValue(session.context),
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    ...(session.endedAt == null ? {} : { endedAt: session.endedAt }),
    ...(session.terminalReason == null
      ? {}
      : { terminalReason: session.terminalReason }),
    ...(session.terminalError == null
      ? {}
      : { terminalError: session.terminalError }),
    slots: cloneValue(session.slots),
    ...(session.plannerSnapshot == null
      ? {}
      : { plannerSnapshot: cloneValue(session.plannerSnapshot) }),
    ...(session.summary == null ? {} : { summary: cloneValue(session.summary) }),
    nextSessionSequence: session.nextSessionSequence,
  };
}

function emptyStatusCounts(): Record<ScanSlotStatus, number> {
  return {
    copied: 0,
    empty: 0,
    "skipped-footprint": 0,
    "copy-timeout": 0,
    blocked: 0,
    cancelled: 0,
  };
}

function summarize(session: InternalSession): ScanSessionSummary {
  const statuses = emptyStatusCounts();
  for (const slot of session.slots) statuses[slot.status] += 1;
  return {
    totalRecords: session.slots.length,
    uniqueCoordinates: session.latestByCoordinate.size,
    statuses,
  };
}

function assertJournalCounter(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`invalid-${label}`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scan-journal-record-must-be-object");
  }
  return value as Record<string, unknown>;
}

function assertSlotRecord(slot: ScanSlotRecord): void {
  if (
    slot.schemaVersion !== SCAN_CONTRACT_VERSION ||
    slot.recordType !== "scan-slot" ||
    !slot.id.trim() ||
    !slot.sessionId.trim()
  ) {
    throw new Error("invalid-scan-slot-contract");
  }
  assertScanSessionContext(slot.context);
  assertScanGridCell(slot.cell, slot.context.grid);
  if (slot.clientPoint) assertClientPoint(slot.clientPoint);
  if (!isUtcTimestamp(slot.observedAt)) throw new Error("scan-slot-timestamp-not-utc");
  if (
    ![
      "copied",
      "empty",
      "skipped-footprint",
      "copy-timeout",
      "blocked",
      "cancelled",
    ].includes(slot.status)
  ) {
    throw new Error("invalid-scan-slot-status");
  }
  if (!Number.isInteger(slot.sequence) || slot.sequence < 0) {
    throw new Error("invalid-scan-slot-sequence");
  }
  if (!Number.isInteger(slot.attempt) || slot.attempt < 1) {
    throw new Error("invalid-scan-slot-attempt");
  }
  if (slot.claimedBy) assertScanGridCell(slot.claimedBy, slot.context.grid);
}

function decodeJournalEvent(
  value: unknown,
  _lineNumber: number,
): ScanSessionJournalEvent {
  const object = asObject(value);
  if (object.journalVersion !== SCAN_SESSION_JOURNAL_VERSION) {
    throw new Error("unsupported-scan-journal-version");
  }
  assertJournalCounter(object.journalSequence, "scan-journal-sequence");
  assertJournalCounter(object.sessionSequence, "scan-session-sequence");
  if (typeof object.sessionId !== "string" || !object.sessionId.trim()) {
    throw new Error("scan-session-id-required");
  }
  if (!isUtcTimestamp(object.at)) throw new Error("scan-event-timestamp-not-utc");
  const recordType = object.recordType;
  if (
    ![
      "scan-session-started",
      "scan-slot-appended",
      "scan-snapshot-saved",
      "scan-session-resumed",
      "scan-session-finished",
      "scan-session-aborted",
      "scan-session-failed",
    ].includes(String(recordType))
  ) {
    throw new Error("unsupported-scan-journal-record");
  }

  const event = object as unknown as ScanSessionJournalEvent;
  if (event.recordType === "scan-session-started") {
    assertScanSessionContext(event.context);
  } else if (event.recordType === "scan-slot-appended") {
    assertSlotRecord(event.slot);
  } else if (event.recordType === "scan-snapshot-saved") {
    event.snapshot = restoreScanPlannerSnapshot(event.snapshot);
  } else if (event.recordType === "scan-session-resumed") {
    if (typeof event.reason !== "string" || !event.reason.trim()) {
      throw new Error("scan-resume-reason-required");
    }
  } else {
    if (typeof event.reason !== "string" || !event.reason.trim()) {
      throw new Error("scan-terminal-reason-required");
    }
    if (!event.summary || typeof event.summary !== "object") {
      throw new Error("scan-terminal-summary-required");
    }
  }
  return event;
}

function sameContext(
  left: ScanSessionContext,
  right: ScanSessionContext,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canRetry(status: ScanSlotStatus): boolean {
  return ["copy-timeout", "blocked", "cancelled"].includes(status);
}

function assertSlotCanAppend(
  session: InternalSession,
  slot: ScanSlotRecord,
  limits: ScanSessionStoreLimits,
): void {
  if (session.status !== "active") {
    throw new Error(`scan-session-terminal:${session.status}`);
  }
  if (session.slots.length >= limits.maxSlotRecordsPerSession) {
    throw new Error("scan-session-slot-cap-reached");
  }
  if (slot.sessionId !== session.id || !sameContext(slot.context, session.context)) {
    throw new Error("scan-slot-session-context-mismatch");
  }
  if (slot.sequence !== session.slots.length) {
    throw new Error("scan-slot-sequence-mismatch");
  }
  const prior = session.latestByCoordinate.get(cellKey(slot));
  if (!prior) {
    if (slot.attempt !== 1) throw new Error("scan-slot-first-attempt-must-be-one");
    return;
  }
  if (!canRetry(prior.status)) {
    throw new Error(`duplicate-final-slot-coordinate:${cellKey(slot)}`);
  }
  if (slot.attempt !== prior.attempt + 1) {
    throw new Error(`scan-slot-attempt-gap:${cellKey(slot)}`);
  }
}

function assertEventCanApply(
  event: ScanSessionJournalEvent,
  sessions: Map<string, InternalSession>,
  limits: ScanSessionStoreLimits,
): void {
  if (event.recordType === "scan-session-started") {
    if (event.sessionSequence !== 0) {
      throw new Error("scan-session-start-sequence-must-be-zero");
    }
    if (sessions.has(event.sessionId)) throw new Error("duplicate-scan-session-id");
    return;
  }
  const session = sessions.get(event.sessionId);
  if (!session) throw new Error("scan-session-not-found");
  if (event.sessionSequence !== session.nextSessionSequence) {
    throw new Error("scan-session-event-sequence-mismatch");
  }
  if (event.recordType === "scan-slot-appended") {
    assertSlotCanAppend(session, event.slot, limits);
    return;
  }
  if (
    event.recordType === "scan-snapshot-saved" ||
    event.recordType === "scan-session-resumed"
  ) {
    if (session.status !== "active") {
      throw new Error(`scan-session-terminal:${session.status}`);
    }
    return;
  }
  if (session.status !== "active") {
    throw new Error(`scan-session-terminal:${session.status}`);
  }
}

function terminalStatus(
  event: ScanSessionTerminalEvent,
): ScanSessionTerminalStatus {
  if (event.recordType === "scan-session-finished") return "finished";
  if (event.recordType === "scan-session-aborted") return "aborted";
  return "failed";
}

function applyEvent(
  event: ScanSessionJournalEvent,
  sessions: Map<string, InternalSession>,
): InternalSession {
  if (event.recordType === "scan-session-started") {
    const session: InternalSession = {
      id: event.sessionId,
      status: "active",
      context: cloneValue(event.context),
      startedAt: event.at,
      updatedAt: event.at,
      slots: [],
      nextSessionSequence: 1,
      latestByCoordinate: new Map(),
    };
    sessions.set(session.id, session);
    return session;
  }
  const session = sessions.get(event.sessionId);
  if (!session) throw new Error("scan-session-not-found");
  session.updatedAt = event.at;
  session.nextSessionSequence = event.sessionSequence + 1;
  if (event.recordType === "scan-slot-appended") {
    const slot = cloneValue(event.slot);
    session.slots.push(slot);
    session.latestByCoordinate.set(cellKey(slot), slot);
  } else if (event.recordType === "scan-snapshot-saved") {
    session.plannerSnapshot = cloneValue(event.snapshot);
  } else if (
    event.recordType === "scan-session-finished" ||
    event.recordType === "scan-session-aborted" ||
    event.recordType === "scan-session-failed"
  ) {
    session.status = terminalStatus(event);
    session.endedAt = event.at;
    session.terminalReason = event.reason;
    session.summary = cloneValue(event.summary);
    if (event.error != null) session.terminalError = event.error;
  }
  return session;
}

function validLimit(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid-${label}`);
  return value;
}

export class ScanSessionStore {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly subscribers = new Map<number, ScanSessionSubscriber>();
  private readonly clock: () => string | number | Date;
  private readonly idFactory: () => string;
  private readonly limits: ScanSessionStoreLimits;
  private operationTail: Promise<void> = Promise.resolve();
  private nextSubscriberId = 1;
  private nextJournalSequence = 0;
  private loaded = false;
  private reloadReport: ScanSessionReloadReport = {
    recoveredPartialLine: false,
    issues: [],
    sessionsLoaded: 0,
    eventsLoaded: 0,
  };

  constructor(
    private readonly storage: ScanSessionStorage,
    options: ScanSessionStoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.limits = {
      maxSlotRecordsPerSession: validLimit(
        options.limits?.maxSlotRecordsPerSession ??
          DEFAULT_MAX_SCAN_SLOT_RECORDS,
        "max-scan-slot-records",
      ),
      maxTextChars: validLimit(
        options.limits?.maxTextChars ?? DEFAULT_MAX_SCAN_TEXT_CHARS,
        "max-scan-text-chars",
      ),
      maxSnapshotChars: validLimit(
        options.limits?.maxSnapshotChars ?? DEFAULT_MAX_SCAN_SNAPSHOT_CHARS,
        "max-scan-snapshot-chars",
      ),
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private now(value?: string | number | Date): string {
    return toUtcTimestamp(value ?? this.clock());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reloadUnsafe();
  }

  private async reloadUnsafe(): Promise<ScanSessionReloadReport> {
    const text = await this.storage.readAll();
    const parsed = parseJsonlWithPartialRecovery(text, decodeJournalEvent);
    const issues = [...parsed.issues];
    this.sessions.clear();
    this.nextJournalSequence = 0;
    let eventsLoaded = 0;
    let priorJournalSequence = -1;
    for (const event of parsed.records) {
      try {
        if (event.journalSequence <= priorJournalSequence) {
          throw new Error("scan-journal-event-order-invalid");
        }
        priorJournalSequence = event.journalSequence;
        this.nextJournalSequence = Math.max(
          this.nextJournalSequence,
          event.journalSequence + 1,
        );
        assertEventCanApply(event, this.sessions, this.limits);
        applyEvent(event, this.sessions);
        eventsLoaded += 1;
      } catch (error) {
        issues.push({
          lineNumber: 0,
          message: error instanceof Error ? error.message : "invalid-scan-journal-event",
          line: JSON.stringify(event),
        });
      }
    }
    this.loaded = true;
    this.reloadReport = {
      recoveredPartialLine: parsed.recoveredPartialLine,
      ...(parsed.partialLine == null ? {} : { partialLine: parsed.partialLine }),
      issues,
      sessionsLoaded: this.sessions.size,
      eventsLoaded,
    };
    return cloneValue(this.reloadReport);
  }

  async reload(): Promise<ScanSessionReloadReport> {
    return this.enqueue(() => this.reloadUnsafe());
  }

  get lastReloadReport(): ScanSessionReloadReport {
    return cloneValue(this.reloadReport);
  }

  subscribe(subscriber: ScanSessionSubscriber): () => void {
    const id = this.nextSubscriberId;
    this.nextSubscriberId += 1;
    this.subscribers.set(id, subscriber);
    return () => {
      this.subscribers.delete(id);
    };
  }

  private async publish(
    event: ScanSessionJournalEvent,
    session: InternalSession,
  ): Promise<void> {
    const notification: ScanSessionNotification = {
      event: cloneValue(event),
      session: cloneSession(session),
    };
    await Promise.allSettled(
      [...this.subscribers.values()].map((subscriber) =>
        Promise.resolve().then(() => subscriber(cloneValue(notification))),
      ),
    );
  }

  private async persist(
    event: ScanSessionJournalEvent,
  ): Promise<InternalSession> {
    assertEventCanApply(event, this.sessions, this.limits);
    await this.storage.appendLine(JSON.stringify(event));
    const session = applyEvent(event, this.sessions);
    this.nextJournalSequence = event.journalSequence + 1;
    await this.publish(event, session);
    return session;
  }

  private uniqueId(requested?: string): string {
    if (requested != null) {
      const id = requested.trim();
      if (!id) throw new Error("scan-session-id-required");
      if (this.sessions.has(id)) throw new Error("duplicate-scan-session-id");
      return id;
    }
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.idFactory().trim();
      if (id && !this.sessions.has(id)) return id;
    }
    throw new Error("unable-to-allocate-unique-scan-session-id");
  }

  async createSession(input: CreateScanSessionInput): Promise<ScanSession> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      assertScanSessionContext(input.context);
      const id = this.uniqueId(input.id);
      const at = this.now(input.startedAt);
      const event: ScanSessionStartedEvent = {
        journalVersion: SCAN_SESSION_JOURNAL_VERSION,
        recordType: "scan-session-started",
        journalSequence: this.nextJournalSequence,
        sessionSequence: 0,
        sessionId: id,
        at,
        context: cloneValue(input.context),
      };
      return cloneSession(await this.persist(event));
    });
  }

  async appendSlot(
    sessionId: string,
    draft: ScanSlotDraft,
  ): Promise<ScanSlotRecord> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error("scan-session-not-found");
      assertScanGridCell(draft.cell, session.context.grid);
      if (draft.clientPoint) assertClientPoint(draft.clientPoint);
      if (!Number.isInteger(draft.attempt) || draft.attempt < 1) {
        throw new Error("invalid-scan-slot-attempt");
      }
      const expectedSequence = session.slots.length;
      if (draft.sequence !== expectedSequence) {
        throw new Error("scan-slot-sequence-mismatch");
      }
      const rawText =
        draft.rawText == null
          ? undefined
          : draft.rawText.slice(0, this.limits.maxTextChars);
      const textTruncated =
        draft.rawText != null && draft.rawText.length > this.limits.maxTextChars;
      const slot: ScanSlotRecord = {
        schemaVersion: SCAN_CONTRACT_VERSION,
        recordType: "scan-slot",
        id: `${sessionId}:slot:${String(expectedSequence)}`,
        sessionId,
        context: cloneValue(session.context),
        ...cloneValue(draft),
        sequence: expectedSequence,
        observedAt: this.now(draft.observedAt),
        ...(rawText == null ? {} : { rawText }),
        ...(textTruncated || draft.textTruncated
          ? { textTruncated: true }
          : {}),
      };
      const event: ScanSlotAppendedEvent = {
        journalVersion: SCAN_SESSION_JOURNAL_VERSION,
        recordType: "scan-slot-appended",
        journalSequence: this.nextJournalSequence,
        sessionSequence: session.nextSessionSequence,
        sessionId,
        at: slot.observedAt,
        slot,
      };
      await this.persist(event);
      return cloneValue(slot);
    });
  }

  async savePlannerSnapshot(
    sessionId: string,
    value: ScanPlannerSnapshot,
    at?: string | number | Date,
  ): Promise<ScanPlannerSnapshot> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error("scan-session-not-found");
      const snapshot = restoreScanPlannerSnapshot(value);
      if (
        JSON.stringify(snapshot).length > this.limits.maxSnapshotChars
      ) {
        throw new Error("scan-planner-snapshot-cap-reached");
      }
      if (
        snapshot.grid.kind !== session.context.grid.kind ||
        snapshot.grid.cols !== session.context.grid.cols ||
        snapshot.grid.rows !== session.context.grid.rows
      ) {
        throw new Error("scan-planner-session-grid-mismatch");
      }
      const event: ScanSnapshotSavedEvent = {
        journalVersion: SCAN_SESSION_JOURNAL_VERSION,
        recordType: "scan-snapshot-saved",
        journalSequence: this.nextJournalSequence,
        sessionSequence: session.nextSessionSequence,
        sessionId,
        at: this.now(at),
        snapshot,
      };
      await this.persist(event);
      return cloneValue(snapshot);
    });
  }

  async resumeSession(
    sessionId: string,
    reason = "resume-after-reload",
    at?: string | number | Date,
  ): Promise<ScanSession> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error("scan-session-not-found");
      if (!reason.trim()) throw new Error("scan-resume-reason-required");
      const event: ScanSessionResumedEvent = {
        journalVersion: SCAN_SESSION_JOURNAL_VERSION,
        recordType: "scan-session-resumed",
        journalSequence: this.nextJournalSequence,
        sessionSequence: session.nextSessionSequence,
        sessionId,
        at: this.now(at),
        reason,
      };
      return cloneSession(await this.persist(event));
    });
  }

  private async terminate(
    sessionId: string,
    status: ScanSessionTerminalStatus,
    reason: string,
    error: string | undefined,
    at: string | number | Date | undefined,
  ): Promise<ScanSession> {
    await this.ensureLoaded();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("scan-session-not-found");
    if (!reason.trim()) throw new Error("scan-terminal-reason-required");
    const recordType =
      status === "finished"
        ? "scan-session-finished"
        : status === "aborted"
          ? "scan-session-aborted"
          : "scan-session-failed";
    const event: ScanSessionTerminalEvent = {
      journalVersion: SCAN_SESSION_JOURNAL_VERSION,
      recordType,
      journalSequence: this.nextJournalSequence,
      sessionSequence: session.nextSessionSequence,
      sessionId,
      at: this.now(at),
      reason: reason.slice(0, this.limits.maxTextChars),
      ...(error == null
        ? {}
        : { error: error.slice(0, this.limits.maxTextChars) }),
      summary: summarize(session),
    };
    return cloneSession(await this.persist(event));
  }

  async finishSession(
    sessionId: string,
    reason = "scan-complete",
    at?: string | number | Date,
  ): Promise<ScanSession> {
    return this.enqueue(() =>
      this.terminate(sessionId, "finished", reason, undefined, at),
    );
  }

  async abortSession(
    sessionId: string,
    reason = "scan-aborted",
    at?: string | number | Date,
  ): Promise<ScanSession> {
    return this.enqueue(() =>
      this.terminate(sessionId, "aborted", reason, undefined, at),
    );
  }

  async failSession(
    sessionId: string,
    error: unknown,
    reason = "scan-failed",
    at?: string | number | Date,
  ): Promise<ScanSession> {
    const detail = error instanceof Error ? error.message : String(error);
    return this.enqueue(() =>
      this.terminate(sessionId, "failed", reason, detail, at),
    );
  }

  async getSession(sessionId: string): Promise<ScanSession | undefined> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const session = this.sessions.get(sessionId);
      return session ? cloneSession(session) : undefined;
    });
  }

  async listSessions(): Promise<ScanSession[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return [...this.sessions.values()]
        .sort(
          (left, right) =>
            left.startedAt.localeCompare(right.startedAt) ||
            left.id.localeCompare(right.id),
        )
        .map(cloneSession);
    });
  }
}
