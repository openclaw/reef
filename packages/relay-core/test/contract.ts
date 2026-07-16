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

export interface RelayContractDriver {
  baseUrl: string;
  fetch(request: Request): Promise<Response>;
}

interface TestUser {
  handle: string;
  session: string;
  identity: IdentityKeyPair;
}

export function registerRelayContractTests(name: string, driver: RelayContractDriver): void {
  const ulid = createMonotonicUlidFactory();
  let timestampOffset = 0;

  describe(`${name} relay contract`, () => {
    it("registers, pairs, delivers, acknowledges, and forwards receipts", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const alice = await createUser(`contract-alice-${suffix}`, "open");
      const bob = await createUser(`contract-bob-${suffix}`, "open");
      await becomeFriends(alice, bob);

      const friends = await (await deviceFetch(alice, "/v1/friends")).json() as { friendships: Array<{ peer: string; status: string }> };
      expect(friends.friendships).toContainEqual(expect.objectContaining({ peer: bob.handle, status: "active" }));
      const id = ulid();
      const envelope = seal({
        id,
        from: `${alice.handle}#1`,
        to: `${bob.handle}#1`,
        body: { text: "contract hello" },
        senderSigningSecretKey: alice.identity.signing.secretKey,
        recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
      });
      expect((await deviceFetch(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: envelope })).status).toBe(202);
      const inbox = await (await deviceFetch(bob, "/v1/mail?after=0")).json() as {
        entries: Array<{ id: string; kind: string }>; cursor: number;
      };
      expect(inbox.entries).toMatchObject([{ id, kind: "message" }]);
      expect((await deviceFetch(bob, `/v1/mail?after=${inbox.cursor}`)).status).toBe(200);
      const receipt = signReceipt({
        id,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "accepted",
      }, bob.identity.signing.secretKey);
      expect((await deviceFetch(bob, `/v1/mail/${alice.handle}/ack`, { method: "POST", body: { id, receipt } })).status).toBe(200);
      const duplicate = await deviceFetch(bob, `/v1/mail/${alice.handle}/ack`, { method: "POST", body: { id, receipt } });
      expect(await duplicate.json()).toMatchObject({ result: "cached" });
      const senderInbox = await (await deviceFetch(alice, "/v1/mail?after=0")).json() as { entries: Array<{ id: string; kind: string }> };
      expect(senderInbox.entries).toMatchObject([{ id, kind: "receipt" }]);
    });

    it("keeps missing handles and invalid friend codes indistinguishable", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const alice = await createUser(`contract-requester-${suffix}`, "open");
      const closed = await createUser(`contract-closed-${suffix}`, "code-only");
      const missing = await deviceFetch(alice, "/v1/friends/request", { method: "POST", body: { to: `missing-${suffix}` } });
      const invalid = await deviceFetch(alice, "/v1/friends/request", { method: "POST", body: { to: closed.handle, code: "WRONG" } });
      expect(missing.status).toBe(202);
      expect(invalid.status).toBe(202);
      expect(await missing.text()).toBe(await invalid.text());

      const minted = await deviceFetch(closed, "/v1/friend-codes", { method: "POST", body: {} });
      const { code } = await minted.json() as { code: string };
      await becomeFriends(alice, closed, code);
    });

    it("rejects replayed device requests and oversized envelopes", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const alice = await createUser(`contract-replay-a-${suffix}`, "open");
      const bob = await createUser(`contract-replay-b-${suffix}`, "open");
      await becomeFriends(alice, bob);
      const signed = await makeDeviceRequest(alice, "/v1/friends");
      const replay = new Request(signed);
      expect((await driver.fetch(signed)).status).toBe(200);
      expect((await driver.fetch(replay)).status).toBe(409);

      const envelope = seal({
        id: ulid(),
        from: `${alice.handle}#1`,
        to: `${bob.handle}#1`,
        body: { text: "small" },
        senderSigningSecretKey: alice.identity.signing.secretKey,
        recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
      });
      const oversized = await deviceFetch(alice, `/v1/mail/${bob.handle}`, {
        method: "POST",
        body: { ...envelope, ct: "A".repeat(50_000) },
      });
      expect(oversized.status).toBe(413);
    });
  });

  async function createUser(handle: string, policy: "code-only" | "friends-of-friends" | "open"): Promise<TestUser> {
    const started = await api("/v1/auth/start", { method: "POST", body: { email: `${handle}@example.test` } });
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
        request_policy: policy,
      },
    });
    expect(claimed.status).toBe(201);
    return { handle, session, identity };
  }

  async function becomeFriends(requester: TestUser, target: TestUser, code?: string): Promise<void> {
    const requested = await deviceFetch(requester, "/v1/friends/request", {
      method: "POST",
      body: { to: target.handle, ...(code ? { code } : {}) },
    });
    expect(requested.status).toBe(202);
    const accepted = await deviceFetch(target, "/v1/friends/respond", {
      method: "POST",
      body: {
        peer: requester.handle,
        accept: true,
        expected_key_epoch: 1,
        expected_ed25519_pub: requester.identity.signing.publicKey,
        expected_x25519_pub: requester.identity.encryption.publicKey,
      },
    });
    expect(accepted.status).toBe(200);
  }

  async function api(path: string, options: { method?: string; body?: unknown; session?: string } = {}): Promise<Response> {
    const headers = new Headers();
    if (options.session) headers.set("Authorization", `Bearer ${options.session}`);
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    if (body) headers.set("Content-Type", "application/json");
    return driver.fetch(new Request(`${driver.baseUrl}${path}`, { method: options.method ?? "GET", headers, ...(body ? { body } : {}) }));
  }

  async function deviceFetch(user: TestUser, path: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
    return driver.fetch(await makeDeviceRequest(user, path, options));
  }

  async function makeDeviceRequest(user: TestUser, path: string, options: { method?: string; body?: unknown } = {}): Promise<Request> {
    const method = options.method ?? "GET";
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const ts = Math.floor(Date.now() / 1000) + (++timestampOffset % 200);
    const signature = signDeviceRequest({
      method,
      path,
      ts,
      bodySha256: sha256Hex(new TextEncoder().encode(body)),
    }, user.identity.signing.secretKey);
    const headers = new Headers({ "x-reef-handle": user.handle, "x-reef-ts": String(ts), "x-reef-sig": signature });
    if (body) headers.set("Content-Type", "application/json");
    return new Request(`${driver.baseUrl}${path}`, { method, headers, ...(body ? { body } : {}) });
  }
}
