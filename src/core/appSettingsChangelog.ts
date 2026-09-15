/**
 * CHANGELOG.md parsing for the Settings → Changelog disclosure (pure).
 *
 * Keep-a-Changelog shaped, but deliberately tolerant: a release heading may
 * bracket its version or not, date it with a dash or parentheses or not at
 * all, and bullets may appear before any `###` section. We never throw on a
 * malformed file — the section renders whatever it understood and keeps the
 * original lines so a "show raw" fallback stays possible.
 */

export interface ChangelogEntry {
  /** "Added" | "Changed" | "Fixed" | … ; "Changes" when bullets precede any `###`. */
  section: string;
  text: string;
}

export interface ChangelogRelease {
  /** "0.2.0", "Unreleased", … exactly as written (minus the brackets). */
  version: string;
  date?: string;
  entries: ChangelogEntry[];
  /** The release's original lines, heading included. */
  raw: string;
}

const RELEASE_HEADING =
  /^##\s+(?:\[(?<bracketed>[^\]]+)\]|(?<bare>\S+))(?:\s*[-–—]\s*(?<dash>\d{4}-\d{2}-\d{2})|\s*\((?<paren>\d{4}-\d{2}-\d{2})\))?\s*$/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.+?)\s*$/;
/** `[0.1.0]: https://…` link definitions carry no content. */
const LINK_REFERENCE = /^\s*\[[^\]]+\]:\s*\S+/;
const DEFAULT_SECTION = "Changes";
/** Sorts above every numeric version. */
export const UNRELEASED = "Unreleased";

/**
 * Splits the markdown into releases. Text before the first `##` (the
 * "# Changelog" title and any preamble) is dropped.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  if (typeof markdown !== "string" || !markdown) return [];
  // A UTF-8 BOM (Notepad, `Out-File`, several editors on Windows) would
  // otherwise sit in front of the first `##` and hide that whole release.
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const releases: ChangelogRelease[] = [];
  let current: { release: ChangelogRelease; lines: string[]; section: string } | undefined;

  const flush = (): void => {
    if (!current) return;
    current.release.raw = current.lines.join("\n");
    releases.push(current.release);
    current = undefined;
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      flush();
      const groups = heading.groups ?? {};
      const version = (groups.bracketed ?? groups.bare ?? "").trim();
      const date = groups.dash ?? groups.paren;
      current = {
        release: { version, ...(date ? { date } : {}), entries: [], raw: "" },
        lines: [line],
        section: DEFAULT_SECTION,
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);

    const section = SECTION_HEADING.exec(line);
    if (section) {
      current.section = section[1] ?? DEFAULT_SECTION;
      continue;
    }
    if (LINK_REFERENCE.test(line)) continue;
    const bullet = BULLET.exec(line);
    if (bullet) {
      current.release.entries.push({ section: current.section, text: bullet[1] ?? "" });
      continue;
    }
    // A non-blank, non-bullet line right after an entry continues it.
    const continuation = line.trim();
    const last = current.release.entries.at(-1);
    if (continuation && last && /^\s/.test(line)) {
      last.text = `${last.text} ${continuation}`;
    }
  }
  flush();
  return releases;
}

function versionParts(value: string): { numbers: number[]; suffix: string } {
  const cleaned = value.trim().replace(/^v/i, "");
  const [head = "", ...rest] = cleaned.split(/[-+]/);
  const numbers = head.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { numbers, suffix: rest.join("-") };
}

/**
 * Numeric dotted compare ("0.10.0" > "0.9.1"), missing parts count as 0, a
 * pre-release suffix compares lexically and ranks below the bare version.
 * "Unreleased" sorts above every number; "" below everything.
 */
export function compareVersions(a: string, b: string): number {
  const left = (a ?? "").trim();
  const right = (b ?? "").trim();
  if (left === right) return 0;
  const leftUnreleased = left.toLowerCase() === UNRELEASED.toLowerCase();
  const rightUnreleased = right.toLowerCase() === UNRELEASED.toLowerCase();
  if (leftUnreleased || rightUnreleased) return leftUnreleased ? (rightUnreleased ? 0 : 1) : -1;
  if (!left || !right) return left ? 1 : -1;

  const first = versionParts(left);
  const second = versionParts(right);
  const length = Math.max(first.numbers.length, second.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (first.numbers[index] ?? 0) - (second.numbers[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (first.suffix === second.suffix) return 0;
  if (!first.suffix) return 1;
  if (!second.suffix) return -1;
  return first.suffix > second.suffix ? 1 : -1;
}

export interface ReleasesSinceOptions {
  /** Dev builds show the in-progress section; packaged builds do not. */
  includeUnreleased?: boolean;
}

/** Releases newer than `lastSeen` ("" = everything is new). */
export function releasesSince(
  releases: readonly ChangelogRelease[],
  lastSeen: string,
  opts: ReleasesSinceOptions = {},
): ChangelogRelease[] {
  const includeUnreleased = opts.includeUnreleased === true;
  return releases.filter((release) => {
    const unreleased = release.version.toLowerCase() === UNRELEASED.toLowerCase();
    if (unreleased && !includeUnreleased) return false;
    return compareVersions(release.version, lastSeen ?? "") > 0;
  });
}

/** The newest version that is not "Unreleased" — what "mark as seen" stores. */
export function newestReleasedVersion(releases: readonly ChangelogRelease[]): string | undefined {
  let newest: string | undefined;
  for (const release of releases) {
    if (release.version.toLowerCase() === UNRELEASED.toLowerCase()) continue;
    if (!release.version) continue;
    if (newest === undefined || compareVersions(release.version, newest) > 0) newest = release.version;
  }
  return newest;
}
