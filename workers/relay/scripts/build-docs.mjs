import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { marked } from "marked";

const relayDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(relayDir, "../..");
const docsDir = path.join(repoRoot, "docs");
const outputDir = path.join(relayDir, "public/docs");
const preferredOrder = ["README.md", "overview.md", "getting-started.md", "friendship.md", "security.md", "guards.md", "self-hosting.md", "DESIGN.md"];
const available = new Set((await readdir(docsDir)).filter((name) => name.endsWith(".md")));
const sourceFiles = [...preferredOrder.filter((name) => available.delete(name)), ...[...available].sort()];

marked.use({ gfm: true });
await mkdir(outputDir, { recursive: true });

const pages = await Promise.all(sourceFiles.map(async (sourceFile) => {
  const markdown = await readFile(path.join(docsDir, sourceFile), "utf8");
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? sourceFile.replace(/\.md$/i, "");
  const slug = sourceFile === "README.md" ? "" : sourceFile.replace(/\.md$/i, "").toLowerCase();
  return { sourceFile, title, slug, markdown };
}));

for (const page of pages) {
  let content = await marked.parse(page.markdown);
  content = addHeadingIds(rewriteDocLinks(content));
  const directory = page.slug ? path.join(outputDir, page.slug) : outputDir;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), pageShell(page, pages, content));
}

console.log(`Generated ${pages.length} Reef documentation pages in ${outputDir}`);

function rewriteDocLinks(html) {
  return html.replace(/href="([A-Za-z0-9_-]+)\.md(#[^"]*)?"/g, (_match, name, hash = "") => {
    const slug = name.toLowerCase() === "readme" ? "" : `${name.toLowerCase()}/`;
    return `href="/docs/${slug}${hash}"`;
  });
}

function addHeadingIds(html) {
  const used = new Map();
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, level, inner) => {
    const base = inner.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

function pageShell(page, pages, content) {
  const nav = pages.map((item) => {
    const href = item.slug ? `/docs/${item.slug}/` : "/docs/";
    const current = item.slug === page.slug ? " aria-current=\"page\"" : "";
    const label = item.sourceFile === "README.md" ? "Documentation home" : item.title;
    return `<a href="${href}"${current}>${escapeHtml(label)}</a>`;
  }).join("\n        ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#06232b">
  <meta name="description" content="${escapeHtml(page.title)} — Reef documentation">
  <title>${escapeHtml(page.title)} — Reef docs</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=Instrument+Serif:ital@0;1&amp;family=Manrope:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="docs-page">
  <a class="skip" href="#main">Skip to content</a>
  <header>
    <a class="brand" href="/" aria-label="Reef home"><svg aria-hidden="true" viewBox="0 0 52 52"><path d="M8 34c7-10 13-10 19-2 6 8 11 7 17-2"/><path class="claw" d="M27 14c8-5 16-1 16 8-8 2-13 0-16-8Zm0 0c-3 7-2 13 3 19"/></svg><span>Reef</span></a>
    <nav aria-label="Primary"><a href="/#how">How it works</a><a href="/#safety">Safety</a><a href="/docs/">Docs</a><a class="git" href="https://github.com/openclaw/reef">GitHub ↗</a></nav>
  </header>
  <main id="main" class="docs-main">
    <nav class="docs-nav" aria-label="Documentation"><p>Reef documentation</p>${nav}</nav>
    <article class="docs-article">${content}</article>
  </main>
  <footer><a class="brand" href="/">Reef</a><p>Guarded, end-to-end-encrypted claw-to-claw communication.</p><nav><a href="https://github.com/openclaw/reef">GitHub</a><a href="/docs/">Docs</a><a href="/docs/design/">Design</a></nav></footer>
</body>
</html>\n`;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
