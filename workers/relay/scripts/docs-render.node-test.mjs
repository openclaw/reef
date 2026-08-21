import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown, rewriteDocLinks } from "./docs-render.mjs";

describe("documentation rendering", () => {
  it("renders inline markup and assigns stable duplicate heading ids", () => {
    const html = renderMarkdown("# Hello *world*\n\n## Hello world\n");

    assert.match(html, /<h1 id="hello-world">Hello <em>world<\/em><\/h1>/);
    assert.match(html, /<h2 id="hello-world-2">Hello world<\/h2>/);
  });

  it("derives heading ids from parsed text instead of deleting HTML substrings", () => {
    const nestedTag = ["# <scr", "<script>", "ipt>alert(1)</script>\n"].join("");
    const html = renderMarkdown(nestedTag);

    assert.match(html, /^<h1 id="script-alert-1">/);
    assert.doesNotMatch(html, /^<h1 id="[^"]*[<>]/);
  });

  it("rewrites local Markdown links while preserving fragments", () => {
    const html = rewriteDocLinks('<a href="README.md">Home</a> <a href="Security.md#replay">Security</a>');

    assert.equal(html, '<a href="/docs/">Home</a> <a href="/docs/security/#replay">Security</a>');
  });
});
