import {
  createMonotonicUlidFactory,
  generateIdentity,
  seal,
  sha256Hex,
  signDeviceRequest,
  signReceipt,
  type IdentityKeyPair,
} from "@openclaw/reef-protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { registerRelayContractTests } from "../../../packages/relay-core/test/contract.js";

const relayUrl = process.env.TEST_RELAY_URL;
const secondRelayUrl = process.env.TEST_RELAY_URL_SECOND;
const integration = relayUrl ? describe : describe.skip;
const ulid = createMonotonicUlidFactory();
let offset = 0;

if (relayUrl) {
  registerRelayContractTests("PostgreSQL", { baseUrl: relayUrl, fetch: (request) => fetch(request) });
}

interface TestUser {
  handle: string;
  session: string;
  identity: IdentityKeyPair;
}

integration("PostgreSQL relay integration", () => {
  it("runs signup, pairing, WebSocket/poll delivery, acknowledgement, and replay rejection", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const alice = await createUser(`alice-${suffix}`);
    const bob = await createUser(`bob-${suffix}`);

    expect((await deviceFetch(alice, "/v1/friends/request", { method: "POST", body: { to: bob.handle } })).status).toBe(202);
    expect((await deviceFetch(bob, "/v1/friends/respond", {
      method: "POST",
      body: {
        peer: alice.handle,
        accept: true,
        expected_key_epoch: 1,
        expected_ed25519_pub: alice.identity.signing.publicKey,
        expected_x25519_pub: alice.identity.encryption.publicKey,
      },
    })).status).toBe(200);

    const socket = await connectWebSocket(bob);
    const id = ulid();
    const envelope = seal({
      id,
      from: `${alice.handle}#1`,
      to: `${bob.handle}#1`,
      body: { text: "encrypted hello" },
      senderSigningSecretKey: alice.identity.signing.secretKey,
      recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
    });
    const pushed = new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString())));
    expect((await deviceFetch(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: envelope })).status).toBe(202);
    await expect(pushed).resolves.toContain(id);

    const inboxResponse = await deviceFetch(bob, "/v1/mail?after=0");
    const inbox = await inboxResponse.json() as { entries: Array<{ id: string; kind: string }>; cursor: number };
    expect(inbox.entries).toMatchObject([{ id, kind: "message" }]);
    const receipt = signReceipt({
      id,
      bodyHash: "a".repeat(64),
      auditHead: "b".repeat(64),
      status: "accepted",
    }, bob.identity.signing.secretKey);
    expect((await deviceFetch(bob, `/v1/mail/${alice.handle}/ack`, { method: "POST", body: { id, receipt } })).status).toBe(200);
    const senderInbox = await (await deviceFetch(alice, "/v1/mail?after=0")).json() as { entries: Array<{ id: string; kind: string }> };
    expect(senderInbox.entries).toMatchObject([{ id, kind: "receipt" }]);

    const signed = await makeDeviceRequest(alice, "/v1/friends");
    expect((await fetch(signed.clone())).status).toBe(200);
    expect((await fetch(signed.clone())).status).toBe(409);
    socket.close();
  });

  it.skipIf(!secondRelayUrl)("replaces an older handle socket across relay replicas", async () => {
    const user = await createUser(`socket-${crypto.randomUUID().slice(0, 8)}`);
    const first = await connectWebSocket(user, relayUrl!);
    const closed = new Promise<number>((resolve) => first.once("close", (code) => resolve(code)));
    const second = await connectWebSocket(user, secondRelayUrl!);
    await expect(closed).resolves.toBe(1012);
    second.close();
  });
});

async function createUser(handle: string): Promise<TestUser> {
  const email = `${handle}@example.test`;
  const started = await api("/v1/auth/start", { method: "POST", body: { email } });
  const { magicLink } = await started.json() as { magicLink: string };
  const token = new URLSearchParams(new URL(magicLink).hash.slice(1)).get("token");
  if (!token) throw new Error("missing magic token");
  const completed = await api("/v1/auth/complete", { method: "POST", body: { token } });
  const { session } = await completed.json() as { session: string };
  const identity = generateIdentity();
  const claimed = await api("/v1/handles", {
    method: "POST",
    session,
    body: {
      handle,
      ed25519_pub: identity.signing.publicKey,
      x25519_pub: identity.encryption.publicKey,
      request_policy: "open",
    },
  });
  expect(claimed.status).toBe(201);
  return { handle, session, identity };
}

async function api(path: string, options: { method?: string; body?: unknown; session?: string } = {}): Promise<Response> {
  const headers = new Headers();
  if (options.session) headers.set("Authorization", `Bearer ${options.session}`);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body) headers.set("Content-Type", "application/json");
  return fetch(`${relayUrl}${path}`, { method: options.method ?? "GET", headers, ...(body ? { body } : {}) });
}

async function deviceFetch(
  user: TestUser,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(await makeDeviceRequest(user, path, options));
}

async function makeDeviceRequest(
  user: TestUser,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Request> {
  const method = options.method ?? "GET";
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const ts = Math.floor(Date.now() / 1000) + (++offset % 200);
  const signature = signDeviceRequest({ method, path, ts, bodySha256: bodyDigest(body) }, user.identity.signing.secretKey);
  const headers = new Headers({ "x-reef-handle": user.handle, "x-reef-ts": String(ts), "x-reef-sig": signature });
  if (body) headers.set("Content-Type", "application/json");
  return new Request(`${relayUrl}${path}`, { method, headers, ...(body ? { body } : {}) });
}

async function connectWebSocket(user: TestUser, baseUrl = relayUrl!): Promise<WebSocket> {
  const path = "/v1/mail/ws";
  const ts = Math.floor(Date.now() / 1000) + (++offset % 200);
  const signature = signDeviceRequest({ method: "GET", path, ts, bodySha256: bodyDigest("") }, user.identity.signing.secretKey);
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("handle", user.handle);
  url.searchParams.set("ts", String(ts));
  url.searchParams.set("sig", signature);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function bodyDigest(body: string): string {
  return sha256Hex(new TextEncoder().encode(body));
}
