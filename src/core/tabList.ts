/**
 * Stash tab-list dropdown model: snaps OCR lines to evenly-pitched row slots,
 * interpolates rows the OCR engine missed, and aligns a visible window
 * against the canonical tab list so scrolled states stay addressable.
 */

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ListRow {
  /** Slot position within the visible window (0 = top visible row). */
  slot: number;
  label: string;
  readable: boolean;
  clickY: number;
}

export const DEFAULT_ROW_PITCH = 47.5;

export function normalizeTabLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/**
 * Loose match that survives OCR garble: exact, containment, or one side being
 * a subsequence of the other covering most of it ("Ma s" matches "Maps",
 * "O Rune" matches "Rune" via containment after normalization).
 */
/**
 * Fold characters OCR reliably confuses so both sides compare in the same
 * alphabet: "lh Mace" is the 1h Mace tab, "B00ts" is Boots. Applied to both
 * inputs, so real labels never drift — only their comparison form does.
 */
function foldOcrConfusables(s: string): string {
  return s.replace(/[li]/g, "1").replace(/o/g, "0");
}

/**
 * Strict equality up to OCR confusables and punctuation — "lh Mace" equals
 * "1h Mace", but "QuarterStaff" never equals "Staff". Navigation must prefer
 * this over labelsSimilar: containment matching once sent every "Staff"
 * deposit into QuarterStaff (whose label CONTAINS "staff" and sits higher in
 * the list), boomeranging the withdrawn staves straight back.
 */
export function labelsEqualFolded(a: string, b: string): boolean {
  const na = foldOcrConfusables(normalizeTabLabel(a));
  const nb = foldOcrConfusables(normalizeTabLabel(b));
  return na.length > 0 && na === nb;
}

export function labelsSimilar(a: string, b: string): boolean {
  const na = foldOcrConfusables(normalizeTabLabel(a));
  const nb = foldOcrConfusables(normalizeTabLabel(b));
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.includes(na)) return true;
  if (nb.length >= 4 && na.includes(nb)) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 3 && short.length >= long.length * 0.6 && isSubsequence(short, long);
}

export function snapRows(lines: OcrLine[], pitch = DEFAULT_ROW_PITCH): ListRow[] {
  const sorted = [...lines].filter((line) => line.text.trim().length > 0).sort((a, b) => a.y - b.y);
  if (sorted.length === 0) return [];
  const gaps = sorted.slice(1).map((line, i) => line.y - sorted[i]!.y).filter((gap) => gap > pitch * 0.6 && gap < pitch * 1.5);
  const measured = gaps.length >= 3 ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : pitch;
  // Slots step per-gap so pitch error never ACCUMULATES: a globally applied
  // `top + slot * measured` once drifted slot 8+ of a 20-row list a full row
  // down, and a click meant for Weapons landed on Rings (one-row-low
  // misdeposits, watched live). Each gap rounds independently instead.
  const bySlot = new Map<number, OcrLine>();
  let cursor = 0;
  bySlot.set(0, sorted[0]!);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i]!.y - sorted[i - 1]!.y;
    const step = Math.round(gap / measured);
    if (step <= 0) continue; // same visual row (icon fragment) — first line wins
    cursor += step;
    if (!bySlot.has(cursor)) bySlot.set(cursor, sorted[i]!);
  }
  const maxSlot = Math.max(...bySlot.keys());
  const rows: ListRow[] = [];
  for (let slot = 0; slot <= maxSlot; slot += 1) {
    const line = bySlot.get(slot);
    // A readable row is clicked at ITS OWN OCR position; only invisible
    // slots are interpolated, and from the nearest readable row above them,
    // never from a global anchor.
    let clickY: number;
    if (line) {
      clickY = Math.round(line.y + line.h / 2);
    } else {
      let ref = slot - 1;
      while (ref >= 0 && !bySlot.has(ref)) ref -= 1;
      const refLine = ref >= 0 ? bySlot.get(ref) : undefined;
      clickY = refLine
        ? Math.round(refLine.y + (slot - ref) * measured + 16)
        : Math.round(sorted[0]!.y + slot * measured + 16);
    }
    rows.push({
      slot,
      label: line ? line.text.trim() : "(unreadable)",
      readable: Boolean(line),
      clickY,
    });
  }
  return rows;
}

/**
 * Find where the visible window sits within the canonical label list.
 * Returns the canonical index of the window's first row, or undefined when
 * no shift matches enough readable labels to be trustworthy.
 */
export function alignWindow(window: ListRow[], canonical: string[]): number | undefined {
  const readable = window.filter((row) => row.readable);
  if (readable.length < 3 || canonical.length === 0) return undefined;
  let best: { shift: number; score: number } | undefined;
  for (let shift = 0; shift <= Math.max(0, canonical.length - 1); shift += 1) {
    let score = 0;
    let comparable = 0;
    for (const row of readable) {
      const target = canonical[shift + row.slot];
      if (target === undefined) continue;
      comparable += 1;
      if (labelsSimilar(row.label, target)) score += 1;
    }
    if (comparable < 3) continue;
    // A correct shift matches most readable labels; wrong shifts only hit
    // duplicates. Require a solid absolute score plus a modest ratio so a few
    // badly garbled rows cannot sink the alignment.
    const ratio = score / comparable;
    if ((ratio >= 0.55 || (score >= 6 && ratio >= 0.45)) && score >= Math.min(3, comparable) && (best === undefined || score > best.score)) {
      best = { shift, score };
    }
  }
  return best?.shift;
}

/** Merge a newly visible window into the canonical list given its alignment shift. */
export function extendCanonical(canonical: string[], window: ListRow[], shift: number): string[] {
  const next = [...canonical];
  for (const row of window) {
    const index = shift + row.slot;
    const existing = next[index];
    if (existing === undefined) {
      next[index] = row.label;
    } else if ((existing === "(unreadable)" || !existing.trim()) && row.readable) {
      next[index] = row.label;
    }
  }
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] === undefined) next[i] = "(unreadable)";
  }
  return next;
}
