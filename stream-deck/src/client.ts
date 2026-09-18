import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DeckActionId, DeckAck, DeckStatus } from "../../src/shared/deckActions.js";

export class AppClient {
  status?: DeckStatus;
  private connection?: { port: number; token: string; session: string };
  private pressed = new Set<DeckActionId>();
  constructor(private file = path.join(process.env.APPDATA ?? "", "poe2-trade-companion", "stream-deck", "connection.json"), private request: typeof fetch = fetch) {}
  async poll(): Promise<DeckStatus | undefined> {
    try {
      const c = JSON.parse(await readFile(this.file, "utf8"));
      if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || !/^[a-f0-9]{64}$/.test(c.token)) throw new Error("Invalid local connection");
      const response = await this.request(`http://127.0.0.1:${c.port}/v1/status`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error("App unavailable");
      const status = await response.json() as DeckStatus;
      if (status.version !== 1 || status.session !== c.session || !status.buttons) throw new Error("Incompatible app");
      this.connection = c; this.status = status;
    } catch { this.connection = undefined; this.status = undefined; }
    return this.status;
  }
  async press(action: DeckActionId): Promise<DeckAck> {
    const id = randomUUID();
    if (this.pressed.has(action)) return { id, ok: false, phase: "rejected", reason: "Command acknowledgement pending" };
    const c = this.connection;
    if (!c || !this.status) return { id, ok: false, phase: "rejected", reason: "App disconnected. Open PoE2 Companion, then press again." };
    this.pressed.add(action);
    try {
      const response = await this.request(`http://127.0.0.1:${c.port}/v1/command`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, id, session: c.session, action, parameters: {} }), signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error("Connection failed");
      const ack = await response.json() as DeckAck;
      if (ack.id !== id || typeof ack.ok !== "boolean") throw new Error("Invalid acknowledgement");
      return ack;
    } catch {
      // An ambiguous outcome MUST NOT be retried. Status polling is the only reconnect operation.
      return { id, ok: false, phase: "rejected", reason: "Acknowledgement lost. Check the app before pressing again; command was not retried." };
    } finally { this.pressed.delete(action); }
  }
}
