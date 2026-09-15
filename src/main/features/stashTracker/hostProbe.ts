/**
 * One passive read of the Path of Exile window rectangle.
 *
 * THE ONLY game-facing call in this package. `{ op: "rect" }` is a query:
 * it never focuses a window, never moves the cursor and sends no input, so
 * it runs before the host's foreground gate (docs/QA_AUTOMATION_BOUNDARY.md,
 * playbook §7.1). It is issued ONLY on a user gesture (the hotkey, the tool
 * button, the legend's refresh) — never from a timer — and the caller
 * refuses it while the emergency stop is latched.
 *
 * The host is closed in `finally` so a PowerShell process is never left
 * behind, and every failure comes back as data (`{ ok: false, error }`)
 * rather than an exception.
 *
 * `tests/input-boundary.test.ts` treats this file as the one allowed
 * `startWinHost` import outside the chat-commands package: it must never
 * gain a `click`/`hotkey`/`type`/`focus`/`drag`/`move` op.
 */
import { startWinHost } from "../../../adapters/winHost.js";
import { resolvePhysicalClient, type ScreenRect } from "../../../core/screenLayout.js";

export type ClientProbe =
  | { ok: true; client: ScreenRect; hwnd: string; title: string; process: string }
  | { ok: false; error: string };

/** The slice of the win host this probe uses. */
export interface WinHostLike {
  send(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export type WinHostFactory = (options: { requestTimeoutMs: number }) => WinHostLike;

const PROBE_TIMEOUT_MS = 10_000;

function numberOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function probePoeClient(
  hostFactory: WinHostFactory = (options) => startWinHost(options) as WinHostLike,
): Promise<ClientProbe> {
  let host: WinHostLike | undefined;
  try {
    host = hostFactory({ requestTimeoutMs: PROBE_TIMEOUT_MS });
    const reply = await host.send({ op: "rect" });
    if (!reply.ok) {
      return { ok: false, error: String(reply.error ?? "no-poe-window") };
    }
    const reported: ScreenRect = {
      left: numberOf(reply.left),
      top: numberOf(reply.top),
      width: numberOf(reply.width),
      height: numberOf(reply.height),
    };
    if (reported.width <= 0 || reported.height <= 0) {
      return { ok: false, error: "poe-window-has-no-size" };
    }
    const client = resolvePhysicalClient(
      reported,
      numberOf(reply.monitorWidth),
      numberOf(reply.monitorHeight),
      { left: numberOf(reply.monitorLeft), top: numberOf(reply.monitorTop) },
    );
    return {
      ok: true,
      client,
      hwnd: String(reply.hwnd ?? ""),
      title: String(reply.title ?? "Path of Exile 2"),
      process: String(reply.process ?? "PathOfExile"),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await host?.close();
    } catch {
      // A host that already died cannot be closed twice; nothing to report.
    }
  }
}
