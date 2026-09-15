import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { escapeHtml, renderNoteMarkdown } from "../src/core/commandsBookmarksNotesMarkdown.js";

const SAMPLE = path.join(process.cwd(), "fixtures", "commandsBookmarksNotes", "notes-sample.md");

describe("escapeHtml", () => {
  it("escapes everything a tag could be built from", () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;",
    );
  });
});

describe("renderNoteMarkdown", () => {
  it("renders the documented example exactly", () => {
    const { html, links } = renderNoteMarkdown(
      "## Ritual\n- **Omen of Whittling**: keep\n- see [poe2db](https://poe2db.tw/us/Omens)\n\n<script>x</script>",
    );
    expect(html).toBe(
      "<h2>Ritual</h2>" +
        "<ul><li><strong>Omen of Whittling</strong>: keep</li>" +
        '<li>see <a href="#" data-href="https://poe2db.tw/us/Omens" rel="noreferrer">poe2db</a></li></ul>' +
        "<p>&lt;script&gt;x&lt;/script&gt;</p>",
    );
    expect(links).toEqual(["https://poe2db.tw/us/Omens"]);
  });

  it("supports the headings, rules, lists and quotes of the subset", () => {
    expect(renderNoteMarkdown("# one").html).toBe("<h1>one</h1>");
    expect(renderNoteMarkdown("### three").html).toBe("<h3>three</h3>");
    expect(renderNoteMarkdown("---").html).toBe("<hr>");
    expect(renderNoteMarkdown("1. a\n2. b").html).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(renderNoteMarkdown("> quoted\n> more").html).toBe("<blockquote>quoted<br>more</blockquote>");
    expect(renderNoteMarkdown("a\nb").html).toBe("<p>a<br>b</p>");
    expect(renderNoteMarkdown("*soft* and _also_").html).toBe("<p><em>soft</em> and <em>also</em></p>");
  });

  it("never executes what a fence or an inline code span contains", () => {
    expect(renderNoteMarkdown("```\n<b>x</b>\n**not bold**\n```").html).toBe(
      "<pre><code>&lt;b&gt;x&lt;/b&gt;\n**not bold**</code></pre>",
    );
    expect(renderNoteMarkdown("use `**literal**` here").html).toBe("<p>use <code>**literal**</code> here</p>");
  });

  it("leaves a non-http link as plain text", () => {
    const { html, links } = renderNoteMarkdown("[x](javascript:alert(1))");
    expect(html).toContain("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(links).toEqual([]);
  });

  it("handles CRLF, emptiness and truncation", () => {
    expect(renderNoteMarkdown("a\r\n\r\nb").html).toBe("<p>a</p><p>b</p>");
    expect(renderNoteMarkdown("").html).toBe("");
    const long = renderNoteMarkdown("x".repeat(50), { maxChars: 10 });
    expect(long.truncated).toBe(true);
    expect(long.html).toBe("<p>xxxxxxxxxx</p>");
  });

  it("renders the sample note without letting the script tag through", () => {
    const markdown = readFileSync(SAMPLE, "utf8");
    const { html, links } = renderNoteMarkdown(markdown);
    expect(html).toContain("<h1>Ritual cheat sheet</h1>");
    expect(html).toContain("<ol><li>check the tribute</li>");
    expect(html).toContain("<pre><code>/hideout</code></pre>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(links).toEqual(["https://poe2db.tw/us/Omens"]);
  });
});
