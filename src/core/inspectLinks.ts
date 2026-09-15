/**
 * Wiki / poe2db links for the inspected item.
 *
 * Two rules keep this safe: the URL is BUILT here from the item's own name
 * (never taken from anything the item text says), and it is validated again
 * in main before `shell.openExternal` — an allowlist of two hosts, https
 * only, no credentials, no query string, no traversal. A hand-edited
 * settings file or a malformed payload can therefore never turn a link
 * button into "open an arbitrary URL".
 *
 * Pure: no HTTP, no fs.
 */

import { magicBaseType } from "./tradeComps.js";
import type { ParsedItem } from "./types.js";

export interface InspectLink {
  id: "wiki" | "poe2db" | "wiki-base" | "poe2db-base";
  label: string;
  url: string;
}

export const ALLOWED_LINK_HOSTS: readonly string[] = ["www.poe2wiki.net", "poe2db.tw"];

/** Spaces become underscores the way both sites title their pages. */
function pageSlug(pageName: string): string {
  return encodeURIComponent(pageName.trim().replace(/\s+/g, "_"));
}

export function wikiUrl(pageName: string): string {
  return `https://www.poe2wiki.net/wiki/${pageSlug(pageName)}`;
}

export function poe2dbUrl(pageName: string): string {
  return `https://poe2db.tw/us/${pageSlug(pageName)}`;
}

/**
 * Which page names are worth a link: a unique's own name (plus its base
 * type as a second pair), and the base type for everything else. A magic
 * item's name carries its prefix and suffix, so the base is derived with
 * `magicBaseType` — a three-word name mis-derives, which is why the base
 * type from the parser is preferred when it exists.
 */
export function linkTargets(
  parsed: Pick<ParsedItem, "rarity" | "name" | "baseType" | "itemClass">,
): InspectLink[] {
  const rarity = (parsed.rarity ?? "").trim().toLowerCase();
  const name = (parsed.name ?? "").trim();
  const baseType = (parsed.baseType ?? "").trim();
  const links: InspectLink[] = [];

  if (rarity === "unique" && name) {
    links.push({ id: "wiki", label: `Wiki: ${name}`, url: wikiUrl(name) });
    links.push({ id: "poe2db", label: `poe2db: ${name}`, url: poe2dbUrl(name) });
    if (baseType && baseType.toLowerCase() !== name.toLowerCase()) {
      links.push({ id: "wiki-base", label: `Wiki: ${baseType}`, url: wikiUrl(baseType) });
      links.push({ id: "poe2db-base", label: `poe2db: ${baseType}`, url: poe2dbUrl(baseType) });
    }
    return links;
  }

  const derived =
    rarity === "magic" && (!baseType || baseType.toLowerCase() === name.toLowerCase())
      ? magicBaseType(name)
      : baseType || name;
  const page = derived.trim();
  if (!page) return links;
  links.push({ id: "wiki", label: `Wiki: ${page}`, url: wikiUrl(page) });
  links.push({ id: "poe2db", label: `poe2db: ${page}`, url: poe2dbUrl(page) });
  return links;
}

/** Encoded control characters have no business in a wiki page name. */
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

/**
 * The gate main checks before opening anything externally: https, one of
 * two hosts, no credentials, no query or fragment, no `..` traversal and no
 * encoded control characters.
 */
export function isAllowedInspectLink(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  // Checked on the RAW string: `new URL` resolves "/us/../../etc" away, so
  // a traversal attempt would look clean by the time the parser is done.
  if (/\.\.|%2e/i.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (!ALLOWED_LINK_HOSTS.includes(parsed.hostname.toLowerCase())) return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.search || parsed.hash) return false;
  if (parsed.pathname.includes("..")) return false;
  if (ENCODED_CONTROL.test(parsed.pathname)) return false;
  return true;
}
