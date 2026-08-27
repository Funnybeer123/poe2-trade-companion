import type { WorldState } from "../world-state/types.js";

export function summarizeLoot(world: WorldState): string {
  if (world.loot.value.length === 0) {
    return "loot=0";
  }
  return `loot=${world.loot.value
    .map((item) => {
      const verdict = item.skipReason === undefined ? "pickable" : `skip:${item.skipReason}`;
      return `${item.id}:${verdict}:${item.score ?? "?"}`;
    })
    .join(",")}`;
}

export function summarizeInventory(world: WorldState): string {
  const inventory = world.inventory.value;
  const mismatch = world.flags.shadowMismatch === true ? " mismatch=shadow-mismatch" : "";
  return `inventory=${String(inventory.occupied)}/${String(inventory.capacity)} full=${String(inventory.full)}${mismatch}`;
}

export function summarizeStash(world: WorldState): string {
  const stash = world.stash.value;
  const pending = world.flags.pendingStashTransfer;
  const pendingText =
    pending === undefined || pending === null
      ? ""
      : ` pending=${pending.kind}:${pending.fingerprint}->${pending.destTabId}:${String(pending.attempts)}`;
  return `stash=${stash.tabId ?? "none"} full=${String(stash.tabFull)}${pendingText}`;
}

export function summarizeWorld(world: WorldState): string {
  const identity = world.target.value?.identity;
  const targetText = identity === undefined ? "target=none" : `target=${identity}`;
  const processName = world.process.value.name ?? "unknown";
  return `${targetText} process=${processName} ui=${world.ui.value.kind} ${summarizeInventory(world)} ${summarizeStash(world)} ${summarizeLoot(world)} ${summarizeListing(world)} ${summarizeTrade(world)}`;
}

export function summarizeListing(world: WorldState): string {
  const view = world.listing.value;
  const session = world.flags.listingSession;
  const open = view?.open === true ? "open" : "closed";
  const price = view?.priceText ?? "none";
  const machine = session?.state ?? "Idle";
  return `listing=${open}:${price}:${machine}`;
}

export function summarizeTrade(world: WorldState): string {
  const view = world.trade.value;
  const session = world.flags.tradeSession;
  const open = view?.open === true ? "open" : "closed";
  const machine = session?.state ?? "Idle";
  const offer = view?.counterOfferText ?? view?.observedOffer?.currency ?? "none";
  return `trade=${open}:${machine}:${offer}`;
}

export function isoTimestampFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
