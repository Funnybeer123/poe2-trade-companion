/**
 * One ticking clock for every Market row.
 *
 * `describeListing` takes a `now`, and a row that reads `Date.now()` inside
 * a computed freezes at mount: a tab left open keeps saying "3 minutes ago"
 * an hour later, and the aging/stale fade never arrives. A single shared
 * ref, refcounted so the interval exists only while rows are on screen,
 * keeps every row honest without one timer per row.
 *
 * A minute is the finest granularity the age column shows, so that is the
 * tick — nothing here polls the network or main.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

const TICK_MS = 60_000;

const clock = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
let users = 0;

function start(): void {
  users += 1;
  if (timer) return;
  clock.value = Date.now();
  timer = setInterval(() => {
    clock.value = Date.now();
  }, TICK_MS);
}

function stop(): void {
  users = Math.max(0, users - 1);
  if (users > 0 || !timer) return;
  clearInterval(timer);
  timer = undefined;
}

/** The shared "now", ticking while this component is mounted. */
export function useMarketClock(): Ref<number> {
  onMounted(start);
  onBeforeUnmount(stop);
  return clock;
}

/** Test seam: the current value without subscribing. */
export function marketClockValue(): number {
  return clock.value;
}
