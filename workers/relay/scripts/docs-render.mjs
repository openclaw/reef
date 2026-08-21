import { Marked } from "marked";

export function renderMarkdown(source) {
  const used = new Map();
  const parser = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const slug = headingText(tokens).toLowerCase()
          .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const base = slug || "section";
        const count = used.get(base) ?? 0;
        used.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count + 1}`;
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
    },
  });
  return parser.parse(source);
}

export function rewriteDocLinks(html) {
  return html.replace(/href="([A-Za-z0-9_-]+)\.md(#[^"]*)?"/g, (_match, name, hash = "") => {
    const slug = name.toLowerCase() === "readme" ? "" : `${name.toLowerCase()}/`;
    return `href="/docs/${slug}${hash}"`;
  });
}

function headingText(tokens) {
  return tokens.map((token) => {
    if (token.type === "html") return "";
    if (Array.isArray(token.tokens)) return headingText(token.tokens);
    return typeof token.text === "string" ? token.text : "";
  }).join("");
}
