/**
 * A deliberately tiny markdown subset for cheat-sheet notes.
 *
 * The output is dropped into the overlay with `v-html`, so the rule is
 * escape-first: every `<`, `>`, `&`, `"` and `'` is escaped BEFORE any tag of
 * ours is added. Raw HTML in a note is therefore displayed as text and can
 * never execute. Links keep their href in `data-href` (the panel opens them
 * through main, which validates the URL again) and only http/https survive.
 *
 * Supported: `#`/`##`/`###` headings, paragraphs, `-`/`*` bullets, `1.`
 * ordered lists, ``` fences, `>` quotes, `---` rules, `**bold**`, `*em*`,
 * `_em_`, `` `code` ``, `[text](https://…)`. Tables and image syntax are NOT
 * supported (an image URL would be a remote fetch from the overlay).
 */

export interface RenderedNote {
  html: string;
  /** Every http(s) link the note contains, in order. */
  links: string[];
  truncated: boolean;
}

export interface RenderNoteOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 20_000;
const LINK_URL = /^https?:\/\/[^\s<>"')]+$/;
/**
 * Placeholder for a code span while the bold/em/link passes run. A raw "<"
 * cannot occur in the escaped text, so "<n>" is unambiguous; the passes
 * that follow never produce one either.
 */
const CODE_TOKEN = /<([0-9]+)>/g;

export function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline pass over an ALREADY ESCAPED string. */
function renderInline(escaped: string, links: string[]): string {
  const codes: string[] = [];
  // Code spans first, tokenised out so bold/em/link passes leave them alone.
  let text = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `<${codes.length - 1}>`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, rawUrl: string) => {
    // The url arrives escaped; &amp; must go back to & before validation.
    const url = rawUrl.replace(/&amp;/g, "&");
    if (!LINK_URL.test(url)) return match;
    links.push(url);
    return `<a href="#" data-href="${escapeHtml(url)}" rel="noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  text = text.replace(CODE_TOKEN, (_match, index: string) => `<code>${codes[Number(index)] ?? ""}</code>`);
  return text;
}

function renderParagraph(lines: string[], links: string[]): string {
  const body = lines.map((line) => renderInline(escapeHtml(line), links)).join("<br>");
  return `<p>${body}</p>`;
}

function renderBlock(lines: string[], links: string[]): string {
  const first = lines[0] ?? "";
  const heading = /^(#{1,3})\s+(.*)$/.exec(first);
  if (heading && lines.length === 1) {
    const level = heading[1]!.length;
    return `<h${level}>${renderInline(escapeHtml(heading[2]!.trim()), links)}</h${level}>`;
  }
  if (lines.length === 1 && /^---+\s*$/.test(first)) return "<hr>";
  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    const items = lines
      .map((line) => `<li>${renderInline(escapeHtml(line.replace(/^[-*]\s+/, "")), links)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    const items = lines
      .map((line) => `<li>${renderInline(escapeHtml(line.replace(/^\d+\.\s+/, "")), links)}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  }
  if (lines.every((line) => /^>\s?/.test(line))) {
    const body = lines.map((line) => renderInline(escapeHtml(line.replace(/^>\s?/, "")), links)).join("<br>");
    return `<blockquote>${body}</blockquote>`;
  }
  if (heading) {
    // A heading followed by more lines: render the heading, then the rest.
    const level = heading[1]!.length;
    const rest = lines.slice(1);
    const head = `<h${level}>${renderInline(escapeHtml(heading[2]!.trim()), links)}</h${level}>`;
    return rest.length > 0 ? head + renderBlock(rest, links) : head;
  }
  return renderParagraph(lines, links);
}

/**
 * Renders the note. Fenced code is never inline-parsed and keeps its escaped
 * text verbatim, so a fence is a safe place to paste anything.
 */
export function renderNoteMarkdown(markdown: string, options: RenderNoteOptions = {}): RenderedNote {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const source = String(markdown ?? "").replace(/\r\n/g, "\n");
  const truncated = source.length > maxChars;
  const text = truncated ? source.slice(0, maxChars) : source;
  const links: string[] = [];
  const lines = text.split("\n");
  const parts: string[] = [];
  let block: string[] = [];

  const flush = (): void => {
    if (block.length === 0) return;
    parts.push(renderBlock(block, links));
    block = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^```/.test(line.trim())) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!.trim())) {
        code.push(lines[index]!);
        index += 1;
      }
      parts.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    block.push(line);
  }
  flush();
  return { html: parts.join(""), links, truncated };
}
