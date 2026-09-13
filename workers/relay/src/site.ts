const CANONICAL_SITE_HOST = "reefwire.ai";
const SITE_REDIRECT_HOSTS = new Set([
  "reefwire.dev",
  "reefwire.io",
  "reef.openclaw.ai",
  "www.reefwire.ai",
  "reef-relay.services-91b.workers.dev",
]);

export function canonicalSiteRedirect(request: Request): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/") || !SITE_REDIRECT_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  url.protocol = "https:";
  url.hostname = CANONICAL_SITE_HOST;
  url.port = "";
  return Response.redirect(url.toString(), 301);
}
