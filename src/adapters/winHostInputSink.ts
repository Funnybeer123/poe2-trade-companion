import type { InputBatchOptions, InputSink } from "../core/inputSink.js";
import type { InputAction } from "../core/types.js";
import type { WinReply } from "./winHost.js";

export interface WinHostTransport {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

export interface WinHostInputOptions {
  allowedProcesses: string[];
  requireForeground?: boolean;
  actionGuard?: (action: InputAction) => { ok: boolean; reason?: string };
}

function normalizedProcess(name: unknown): string {
  return String(name ?? "").trim().replace(/\.exe$/i, "").toLowerCase();
}

function normalizedHotkey(keys: unknown): string {
  return String(keys ?? "").trim().replace(/[+\s]/g, "").toLowerCase();
}

export class WinHostInputSink implements InputSink {
  private pinnedHwnd: string | undefined;

  constructor(
    private readonly host: WinHostTransport,
    private readonly options: WinHostInputOptions,
  ) {}

  private assertActionAllowed(action: InputAction): void {
    const validation = this.options.actionGuard?.(action);
    if (validation && !validation.ok) {
      throw new Error(validation.reason ?? "input-action-rejected");
    }
  }

  private async guard(requireForeground = this.options.requireForeground !== false): Promise<void> {
    const state = await this.host.send({ op: "rect" });
    if (!state.ok) throw new Error(String(state.error ?? "target-window-missing"));
    const process = normalizedProcess(state.process);
    const allowed = this.options.allowedProcesses.some((entry) => {
      const candidate = normalizedProcess(entry).trim();
      return candidate.length > 0 && process === candidate;
    });
    if (!allowed) throw new Error("process-not-allowlisted");
    const hwnd = String(state.hwnd ?? "").trim();
    if (!hwnd) throw new Error("target-window-unpinned");
    if (this.pinnedHwnd && hwnd !== this.pinnedHwnd) throw new Error("target-window-changed");
    this.pinnedHwnd = hwnd;
    if (requireForeground && !state.foregroundIsPoe) {
      throw new Error("focus-lost");
    }
  }

  private async checkedSend(payload: Record<string, unknown>): Promise<void> {
    await this.guard();
    const result = await this.host.send({
      ...payload,
      ...(this.pinnedHwnd ? { expectedHwnd: this.pinnedHwnd } : {}),
      requireForeground: this.options.requireForeground !== false,
    });
    if (!result.ok) {
      const emitted = Number(result.count ?? 0);
      const reason = String(result.error ?? "win-input-failed");
      if (Number.isFinite(emitted) && emitted > 0) {
        throw new Error(`partial-input:${emitted}:${reason}`);
      }
      throw new Error(reason);
    }
    if (this.options.requireForeground !== false && result.focused === false) {
      throw new Error("focus-lost");
    }
  }

  async emit(action: InputAction): Promise<void> {
    this.assertActionAllowed(action);
    if (action.kind === "focus") {
      await this.guard(false);
      const result = await this.host.send({
        op: "focus",
        ...(this.pinnedHwnd ? { expectedHwnd: this.pinnedHwnd } : {}),
      });
      if (!result.ok || !result.focused) throw new Error(String(result.error ?? "focus-failed"));
      return;
    }
    if (action.kind === "wait") {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, action.durationMs ?? 0)));
      return;
    }
    if (action.kind === "key") {
      await this.checkedSend({ op: "hotkey", keys: normalizedHotkey(action.key) });
      return;
    }
    if (action.kind === "type") {
      await this.checkedSend({ op: "type", text: action.text ?? "" });
      return;
    }
    if (action.kind === "move") {
      await this.checkedSend({ op: "move", x: action.x, y: action.y });
      return;
    }
    if (action.kind === "drag") {
      await this.checkedSend({ op: "drag", x: action.x, y: action.y, x2: action.x2, y2: action.y2 });
      return;
    }
    await this.checkedSend({
      op: action.button === "right" ? "rightclick" : "click",
      x: action.x,
      y: action.y,
    });
  }

  async emitBatch(actions: InputAction[], options: InputBatchOptions = {}): Promise<void> {
    for (const action of actions) this.assertActionAllowed(action);
    const clicks = actions.filter((action) => action.kind === "click");
    if (options.ctrl && clicks.length === actions.length && clicks.length > 0) {
      await this.checkedSend({
        op: "ctrlburst",
        points: clicks.map((action) => ({ x: action.x, y: action.y })),
        shift: Boolean(options.shift),
      });
      return;
    }
    for (const action of actions) await this.emit(action);
  }

  clear(): void {
    // The PowerShell host has no buffered input queue.
  }
}
