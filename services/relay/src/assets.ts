import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { RelayAssets } from "@openclaw/reef-relay-core";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export class FileAssets implements RelayAssets {
  constructor(private readonly root: string) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const requested = pathname === "/" ? "index.html" : pathname === "/welcome" ? "welcome.html" : pathname.replace(/^\//, "");
    let path = resolve(this.root, requested);
    if (relative(this.root, path).startsWith(`..${sep}`) || path === this.root) return new Response("not found", { status: 404 });
    try {
      const info = await stat(path);
      if (info.isDirectory()) path = resolve(path, "index.html");
      await stat(path);
    } catch {
      path = resolve(this.root, "index.html");
    }
    const body = await readFile(path);
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" },
    });
  }
}
