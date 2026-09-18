import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { isDeckAction, type DeckAck, type DeckActionId, type DeckStatus } from "../shared/deckActions.js";

export interface DeckCommandPort {
  status(): Omit<DeckStatus, "session">;
  execute(action: DeckActionId): unknown | Promise<unknown>;
}
/** Loopback-only capability interface. Never exposes arbitrary IPC or retries a command. */
export class DeckServer {
  readonly session = randomUUID();
  private readonly token = randomBytes(32).toString("hex");
  private readonly seen = new Set<string>();
  private server?: Server;
  private file?: string;
  constructor(private readonly port: DeckCommandPort, private readonly audit: (ack: DeckAck, action?: string) => void = () => {}) {}
  private record(ack: DeckAck, action: string): void {
    try { this.audit(ack, action); } catch { /* Optional connection logging must never prevent emergency cancellation. Services retain mandatory input traces. */ }
  }
  status(): DeckStatus { return { ...this.port.status(), session: this.session }; }
  command(raw: unknown): DeckAck {
    const request = raw as Record<string, unknown> | null;
    const id = typeof request?.id === "string" ? request.id : "invalid";
    const reject = (reason: string): DeckAck => ({ id, ok: false, phase: "rejected", reason });
    if (!request || request.version !== 1 || !/^[\w-]{8,80}$/.test(id) || request.session !== this.session || !isDeckAction(request.action)) return reject("Invalid command or expired app session. Refresh status; press again explicitly.");
    if (!request.parameters || typeof request.parameters !== "object" || Array.isArray(request.parameters) || Object.keys(request.parameters).length) return reject("This action takes an empty parameters object.");
    if (this.seen.has(id)) return reject("Duplicate command rejected; it was not executed again.");
    // Keep every ID for this app session; fail closed rather than evicting replay protection.
    if (this.seen.size >= 100000) return reject("Command session limit reached. Restart the app.");
    this.seen.add(id);
    const action = request.action;
    try {
      if (action !== "safety.estop" && action !== "workflow.stop") {
        const button = this.status().buttons[action];
        if (button.state === "unavailable") throw new Error(button.detail);
      }
      this.record({ id, ok: true, phase: "accepted", reason: "Command received" }, action);
      const result = this.port.execute(action);
      if (result instanceof Promise) {
        void result.then(() => this.record({ id, ok: true, phase: "completed", reason: "Completed" }, action), error => this.record(reject(String(error)), action));
        return { id, ok: true, phase: "accepted", reason: "Accepted; follow button state for progress and outcome." };
      }
      const ack: DeckAck = { id, ok: true, phase: "completed", reason: "Command handled; ongoing workflows publish status." };
      this.record(ack, action); return ack;
    } catch (error) { const ack = reject(error instanceof Error ? error.message : String(error)); this.record(ack, action); return ack; }
  }
  async listen(directory: string): Promise<number> {
    this.server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
      const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      const expected = Buffer.from(this.token);
      if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(JSON.stringify({ error: "Forbidden" })); return; }
      if (req.method === "GET" && req.url === "/v1/status") { res.end(JSON.stringify(this.status())); return; }
      if (req.method !== "POST" || req.url !== "/v1/command") { res.writeHead(404).end("{}"); return; }
      let body = "";
      try {
        for await (const chunk of req) { body += String(chunk); if (body.length > 4096) { res.writeHead(413).end("{}"); return; } }
        res.end(JSON.stringify(this.command(JSON.parse(body))));
      } catch { if (!res.headersSent) res.writeHead(400).end(JSON.stringify({ error: "Malformed command" })); }
    });
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("No local command port");
    mkdirSync(directory, { recursive: true }); this.file = path.join(directory, "connection.json");
    writeFileSync(this.file, JSON.stringify({ version: 1, port: address.port, token: this.token, session: this.session }), { mode: 0o600 });
    return address.port;
  }
  close(): void {
    this.server?.closeAllConnections(); this.server?.close();
    try { if (this.file && JSON.parse(readFileSync(this.file, "utf8")).session === this.session) unlinkSync(this.file); } catch { /* Already removed. */ }
  }
}
