/**
 * One generic, typed bridge for feature modules (src/main/features/*).
 *
 * Every feature registers its invoke channels in the main process through
 * `FeatureContext.handle("pkg:verb", handler)` and pushes events with
 * `FeatureContext.emit("pkg:event", payload)`. The preload exposes ONE
 * `window.poe2.features` object (invoke/on) guarded by the channel pattern
 * below, and the renderer binds a per-package typed client with
 * `createFeatureApi<Contract, Events>()` (src/renderer/services/featureApi.ts).
 *
 * Contracts are declared next to the feature in `src/shared/<pkg>.ts` — plain
 * interfaces, no index signature needed:
 *
 *   export interface TradeContract {
 *     "trade:offers": FeatureCall<[], TradeOffer[]>;
 *     "trade:dismiss": FeatureCall<[offerId: string], TradeOffer[]>;
 *   }
 *   export interface TradeEvents { "trade:changed": TradeOffer[] }
 *
 * Pure module: no Electron, no DOM.
 */

export interface FeatureCall<Args extends readonly unknown[] = readonly unknown[], Result = unknown> {
  args: Args;
  result: Result;
}

/** Constraint: every member of a contract is a FeatureCall (interfaces welcome). */
export type ContractShape<C> = { [K in keyof C]: FeatureCall<readonly unknown[], unknown> };
/** Constraint: every member of an events map is a payload type. */
export type EventsShape<E> = { [K in keyof E]: unknown };
/** Default events map when a package has none. */
export type NoEvents = Record<never, never>;

/** `pkg:verb` — lower-case, digits and dashes, exactly one colon. */
export const FEATURE_CHANNEL_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export function isFeatureChannel(value: unknown): value is string {
  return typeof value === "string" && FEATURE_CHANNEL_PATTERN.test(value);
}

/** The untyped surface the preload exposes as `window.poe2.features`. */
export interface FeatureBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
}

/** A typed client over the bridge for one package's contract + events. */
export interface FeatureApi<C extends ContractShape<C>, E extends EventsShape<E> = NoEvents> {
  invoke<K extends keyof C & string>(channel: K, ...args: C[K]["args"]): Promise<C[K]["result"]>;
  on<K extends keyof E & string>(channel: K, callback: (payload: E[K]) => void): () => void;
}

export function bindFeatureApi<C extends ContractShape<C>, E extends EventsShape<E> = NoEvents>(
  bridge: FeatureBridge,
): FeatureApi<C, E> {
  return {
    invoke: (channel, ...args) =>
      bridge.invoke(channel, ...(args as unknown[])) as Promise<C[typeof channel]["result"]>,
    on: (channel, callback) =>
      bridge.on(channel, (payload) => callback(payload as E[typeof channel])),
  };
}

// ---------------------------------------------------------------------------
// Channels the scaffold itself provides (src/main/features/context.ts).
// ---------------------------------------------------------------------------

/** A sanitized copy of every registered settings namespace, keyed by id. */
export type SettingsSnapshot = Record<string, unknown>;

export interface SettingsChangedEvent {
  id: string;
  value: unknown;
}

export interface AppFeatureContract {
  /** Registered feature channels, for diagnostics. */
  "app:feature-channels": FeatureCall<[], string[]>;
  /** The renderer mirrors its top-bar Dry-run switch here so hotkey-driven actions honour it. */
  "app:set-dry-run": FeatureCall<[dryRun: boolean], boolean>;
  "app:dry-run": FeatureCall<[], boolean>;
  "settings:get": FeatureCall<[], SettingsSnapshot>;
  /** Merge a patch into one namespace; the namespace's sanitizer decides what survives. */
  "settings:set": FeatureCall<[id: string, patch: unknown], unknown>;
}

export interface AppFeatureEvents {
  "settings:changed": SettingsChangedEvent;
  "app:dry-run-changed": boolean;
  /**
   * "Bring the desktop window to this route." ANY feature may
   * `ctx.emit("app:navigate", { path })` from main — typically a hotkey that
   * fronts the window (restore → show → focus) and then asks the renderer to
   * route. The integrator subscribes exactly ONCE, in `App.vue`'s
   * `onMounted`, and pushes the path onto the router; features never
   * subscribe and never drive the router from main.
   */
  "app:navigate": { path: string };
}
