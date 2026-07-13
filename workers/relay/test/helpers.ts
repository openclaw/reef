import { SELF } from "cloudflare:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  base64url,
  canonicalBytes,
  createMonotonicUlidFactory,
  fromBase64url,
  generateIdentity,
  signReceipt,
  type IdentityKeyPair,
} from "@openclaw/reef-protocol";

let timestampOffset = 0;
let handleOffset = 0;
const ulid = createMonotonicUlidFactory();

export interface TestUser {
  email: string;
  handle: string;
  session: string;
  identity: IdentityKeyPair;
  policy: "code-only" | "friends-of-friends" | "open";
}

export async function createUser(handle: string, policy: TestUser["policy"] = "open"): Promise<TestUser> {
  handle = `${handle}-${++handleOffset}`;
  const email = `${handle}-${crypto.randomUUID()}@example.test`;
  const start = await api("/v1/auth/start", { method: "POST", body: { email } });
  const startBody = await bodyOf<{ magicLink: string }>(start);
  const token = new URL(startBody.magicLink).searchParams.get("token");
  if (!token) throw new Error("missing magic token");
  const complete = await api("/v1/auth/complete", { method: "POST", body: { token } });
  const { session } = await bodyOf<{ session: string }>(complete);
  const identity = generateIdentity();
  const claimed = await api("/v1/handles", {
    method: "POST",
    session,
    body: {
      handle,
      ed25519_pub: identity.signing.publicKey,
      x25519_pub: identity.encryption.publicKey,
      request_policy: policy,
    },
  });
  if (claimed.status !== 201) throw new Error(`claim failed: ${claimed.status}`);
  return { email, handle, session, identity, policy };
}

export async function becomeFriends(requester: TestUser, target: TestUser, code?: string): Promise<void> {
  const requested = await deviceApi(requester, "/v1/friends/request", { method: "POST", body: { to: target.handle, ...(code ? { code } : {}) } });
  if (requested.status !== 202) throw new Error(`request failed: ${requested.status}`);
  const accepted = await deviceApi(target, "/v1/friends/respond", { method: "POST", body: { peer: requester.handle, accept: true } });
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status}`);
}

export async function mintCode(user: TestUser): Promise<string> {
  const response = await deviceApi(user, "/v1/friend-codes", { method: "POST", body: {} });
  return (await bodyOf<{ code: string }>(response)).code;
}

export async function deviceApi(
  user: TestUser,
  path: string,
  options: { method?: string; body?: unknown; identity?: IdentityKeyPair; websocket?: boolean } = {},
): Promise<Response> {
  return SELF.fetch(await makeDeviceRequest(user, path, options));
}

export async function makeDeviceRequest(
  user: TestUser,
  path: string,
  options: { method?: string; body?: unknown; identity?: IdentityKeyPair; websocket?: boolean } = {},
): Promise<Request> {
  const method = options.method ?? "GET";
  const bodyText = options.body === undefined ? "" : JSON.stringify(options.body);
  const url = new URL(`https://example.test${path}`);
  const ts = Math.floor(Date.now() / 1000) + (++timestampOffset % 200);
  const signature = await signRequest(options.identity ?? user.identity, method, signedPath(url), ts, bodyText);
  if (options.websocket) {
    url.searchParams.set("handle", user.handle);
    url.searchParams.set("ts", String(ts));
    url.searchParams.set("sig", signature);
  }
  const headers = new Headers();
  if (!options.websocket) {
    headers.set("x-reef-handle", user.handle);
    headers.set("x-reef-ts", String(ts));
    headers.set("x-reef-sig", signature);
  } else {
    headers.set("Upgrade", "websocket");
  }
  if (bodyText) headers.set("Content-Type", "application/json");
  return new Request(url, { method, headers, body: bodyText || null });
}

export async function api(path: string, options: { method?: string; body?: unknown; session?: string } = {}): Promise<Response> {
  const headers = new Headers();
  if (options.session) headers.set("Authorization", `Bearer ${options.session}`);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body) headers.set("Content-Type", "application/json");
  return SELF.fetch(`https://example.test${path}`, { method: options.method ?? "GET", headers, body: body ?? null });
}

export function nextId(): string {
  return ulid();
}

export function receiptFor(user: TestUser, id: string) {
  return signReceipt({ id, bodyHash: "a".repeat(64), auditHead: "b".repeat(64), status: "accepted" }, user.identity.signing.secretKey);
}

export async function bodyOf<T>(response: Response): Promise<T> {
  return response.json<T>();
}

async function signRequest(identity: IdentityKeyPair, method: string, path: string, ts: number, body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const bodySha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return base64url(ed25519.sign(canonicalBytes({ method, path, ts, bodySha256 }), fromBase64url(identity.signing.secretKey)));
}

function signedPath(url: URL): string {
  return url.search ? `${url.pathname}${url.search}` : url.pathname;
}
