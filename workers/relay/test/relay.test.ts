import { SELF, env, listDurableObjectIds } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { generateIdentity, seal, signRotation } from "@openclaw/reef-protocol";
import { randomFriendCode } from "../src/crypto.js";
import worker from "../src/index.js";
import { api, becomeFriends, bodyOf, createUser, deviceApi, makeDeviceRequest, mintCode, nextId, receiptFor } from "./helpers.js";

describe("friend code generation", () => {
  it("uses the Crockford alphabet for every random index", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(randomFriendCode(32, () => bytes)).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  });
});

describe("relay integration", () => {
  it("serves the site outside the API namespace", async () => {
    const response = await SELF.fetch("https://example.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain("guarded, end-to-end-encrypted side channel");
    await expect((await SELF.fetch("https://example.test/welcome")).text()).resolves.toContain("Email verified");
    expect((await SELF.fetch("https://example.test/v1/unknown")).status).toBe(404);
  });

  it("redirects alternate site hosts but leaves API requests host-agnostic", async () => {
    for (const host of [
      "reefwire.dev",
      "reefwire.io",
      "reef.openclaw.ai",
      "www.reefwire.ai",
      "reef-relay.services-91b.workers.dev",
    ]) {
      const response = await SELF.fetch(`https://${host}/docs/getting-started/?source=test`, { redirect: "manual" });
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("https://reefwire.ai/docs/getting-started/?source=test");
    }
    const head = await SELF.fetch("https://reefwire.dev/welcome", { method: "HEAD", redirect: "manual" });
    expect(head.status).toBe(301);
    expect(head.headers.get("location")).toBe("https://reefwire.ai/welcome");
    expect((await SELF.fetch("https://reefwire.dev/v1/unknown", { redirect: "manual" })).status).toBe(404);
    expect((await SELF.fetch("https://reefwire.ai/", { redirect: "manual" })).status).toBe(200);
  });

  it("sends the production magic link through the EMAIL binding", async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder): Promise<EmailSendResult> => ({ messageId: "test-message" }));
    const prodEnv = { ...env, DEV_MODE: "0", EMAIL: { send } } as Env;
    const email = `signup-${crypto.randomUUID()}@example.test`;
    const response = await worker.fetch(new Request("https://reefwire.ai/v1/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": `test-${crypto.randomUUID()}` },
      body: JSON.stringify({ email }),
    }), prodEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "sent" });
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0]![0];
    expect(message).toMatchObject({
      to: email,
      from: { email: "hello@reefwire.ai", name: "Reef" },
      subject: "Your Reef sign-in link",
    });
    expect(message.html).toMatch(/https:\/\/reefwire\.ai\/welcome#token=[A-Za-z0-9_-]+/);
    expect(message.text).toMatch(/https:\/\/reefwire\.ai\/welcome#token=[A-Za-z0-9_-]+/);
  });

  it("runs signup, code pairing, WS/poll delivery, ack, receipt passthrough, and deletion", async () => {
    const alice = await createUser("alice", "open");
    const bob = await createUser("bob", "code-only");
    const code = await mintCode(bob);
    await becomeFriends(alice, bob, code);

    const wsResponse = await deviceApi(bob, "/v1/mail/ws", { websocket: true });
    expect(wsResponse.status).toBe(101);
    const socket = wsResponse.webSocket;
    expect(socket).toBeTruthy();
    socket!.accept();
    const pushed = new Promise<string>((resolve) => socket!.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));

    const id = nextId();
    const envelope = seal({
      id, from: `${alice.handle}#1`, to: `${bob.handle}#1`, body: { text: "encrypted hello" },
      senderSigningSecretKey: alice.identity.signing.secretKey,
      recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
    });
    expect((await deviceApi(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: envelope })).status).toBe(202);
    await expect(pushed).resolves.toContain(id);

    const polled = await deviceApi(bob, "/v1/mail?after=0");
    const inbox = await bodyOf<{ entries: Array<{ seq: number; peer: string; id: string; kind: string }>; cursor: number }>(polled);
    expect(inbox.entries).toMatchObject([{ peer: alice.handle, id, kind: "message" }]);
    const afterCursor = await bodyOf<{ entries: unknown[] }>(await deviceApi(bob, `/v1/mail?after=${inbox.cursor}`));
    expect(afterCursor.entries).toEqual([]);

    const receipt = receiptFor(bob, id);
    const ack = await deviceApi(bob, `/v1/mail/${alice.handle}/ack`, { method: "POST", body: { id, receipt } });
    expect(ack.status).toBe(200);
    const duplicateAck = await deviceApi(bob, `/v1/mail/${alice.handle}/ack`, { method: "POST", body: { id, receipt } });
    expect(await bodyOf<{ result: string }>(duplicateAck)).toMatchObject({ result: "cached" });

    const senderPoll = await deviceApi(alice, "/v1/mail?after=0");
    const senderInbox = await bodyOf<{ entries: Array<{ peer: string; id: string; kind: string }> }>(senderPoll);
    expect(senderInbox.entries).toMatchObject([{ peer: bob.handle, id, kind: "receipt" }]);
    const afterAck = await bodyOf<{ entries: unknown[] }>(await deviceApi(bob, "/v1/mail?after=0"));
    expect(afterAck.entries).toEqual([]);
    socket!.close();
  });

  it("uses one recipient inbox and socket for messages from distinct peers", async () => {
    const alice = await createUser("alice", "open");
    const bob = await createUser("bob", "open");
    const carol = await createUser("carol", "open");
    await becomeFriends(alice, bob);
    await becomeFriends(carol, bob);

    const wsResponse = await deviceApi(bob, "/v1/mail/ws", { websocket: true });
    const socket = wsResponse.webSocket!;
    socket.accept();
    const pushed = new Promise<Array<{ peer: string; kind: string }>>((resolve) => {
      const entries: Array<{ peer: string; kind: string }> = [];
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as { entry: { peer: string; kind: string } };
        entries.push(frame.entry);
        if (entries.length === 2) resolve(entries);
      });
    });

    for (const sender of [alice, carol]) {
      const envelope = seal({
        id: nextId(), from: `${sender.handle}#1`, to: `${bob.handle}#1`, body: { text: `from ${sender.handle}` },
        senderSigningSecretKey: sender.identity.signing.secretKey, recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
      });
      expect((await deviceApi(sender, `/v1/mail/${bob.handle}`, { method: "POST", body: envelope })).status).toBe(202);
    }
    const frames = await pushed;
    expect(new Set(frames.map((entry) => entry.peer))).toEqual(new Set([alice.handle, carol.handle]));
    expect(frames.every((entry) => entry.kind === "message")).toBe(true);
    const inbox = await bodyOf<{ entries: Array<{ peer: string }> }>(await deviceApi(bob, "/v1/mail?after=0"));
    expect(new Set(inbox.entries.map((entry) => entry.peer))).toEqual(new Set([alice.handle, carol.handle]));
    const ids = await listDurableObjectIds(env.MAILBOX);
    expect(ids.some((id) => id.equals(env.MAILBOX.idFromName(bob.handle)))).toBe(true);
    expect(ids.some((id) => id.equals(env.MAILBOX.idFromName(alice.handle)))).toBe(false);
    expect(ids.some((id) => id.equals(env.MAILBOX.idFromName(carol.handle)))).toBe(false);

    expect((await deviceApi(bob, `/v1/friends/${alice.handle}`, { method: "DELETE" })).status).toBe(204);
    const afterRemoval = await bodyOf<{ entries: Array<{ peer: string }> }>(await deviceApi(bob, "/v1/mail?after=0"));
    expect(afterRemoval.entries.map((entry) => entry.peer)).toEqual([carol.handle]);
    socket.close();
  });

  it("returns identical anti-enumeration responses", async () => {
    const alice = await createUser("alice", "open");
    const closed = await createUser("closed", "code-only");
    const missing = await deviceApi(alice, "/v1/friends/request", { method: "POST", body: { to: "does-not-exist" } });
    const badCode = await deviceApi(alice, "/v1/friends/request", { method: "POST", body: { to: closed.handle, code: "WRONG" } });
    expect(missing.status).toBe(202);
    expect(badCode.status).toBe(202);
    expect(await missing.text()).toBe(await badCode.text());
  });

  it("enforces code-only, friends-of-friends, and open policies", async () => {
    const alice = await createUser("alice", "open");
    const open = await createUser("open-user", "open");
    await becomeFriends(alice, open);

    const codeOnly = await createUser("code-user", "code-only");
    const denied = await deviceApi(alice, "/v1/friends/request", { method: "POST", body: { to: codeOnly.handle } });
    expect((await bodyOf<{ status: string }>(denied)).status).toBe("pending");
    expect((await deviceApi(codeOnly, "/v1/friends/respond", { method: "POST", body: { peer: alice.handle, accept: true } })).status).toBe(404);
    await becomeFriends(alice, codeOnly, await mintCode(codeOnly));

    const mutual = await createUser("mutual", "open");
    const fof = await createUser("fof-user", "open");
    await becomeFriends(alice, mutual);
    await becomeFriends(mutual, fof);
    await env.DB.prepare("UPDATE handles SET request_policy = 'friends-of-friends' WHERE handle = ?").bind(fof.handle).run();
    const fofRequest = await deviceApi(alice, "/v1/friends/request", { method: "POST", body: { to: fof.handle } });
    expect(fofRequest.status).toBe(202);
    expect((await deviceApi(fof, "/v1/friends/respond", { method: "POST", body: { peer: alice.handle, accept: true } })).status).toBe(200);
    const friends = await bodyOf<{ friendships: Array<{ peer: string; vouching_mutual: string | null }> }>(await deviceApi(alice, "/v1/friends"));
    expect(friends.friendships.find((item) => item.peer === fof.handle)?.vouching_mutual).toBe(mutual.handle);
  });

  it("supports planned rotation and blocks recovery mail until peer reapproval", async () => {
    const alice = await createUser("alice", "open");
    const bob = await createUser("bob", "open");
    await becomeFriends(alice, bob);
    const planned = generateIdentity();
    const signedRotation = signRotation({
      newEd25519Pub: planned.signing.publicKey, newX25519Pub: planned.encryption.publicKey, newEpoch: 2,
    }, alice.identity.signing.secretKey);
    const plannedResponse = await deviceApi(alice, `/v1/handles/${alice.handle}/rotate`, { method: "POST", body: { signedRotation } });
    expect(plannedResponse.status).toBe(200);
    alice.identity = planned;

    const recovered = generateIdentity();
    const recovery = await api(`/v1/handles/${alice.handle}/rotate`, {
      method: "POST", session: alice.session,
      body: { recovery: { newEd25519Pub: recovered.signing.publicKey, newX25519Pub: recovered.encryption.publicKey } },
    });
    expect(await bodyOf<{ key_epoch: number; reapproval_required: number }>(recovery)).toMatchObject({ key_epoch: 3, reapproval_required: 1 });
    alice.identity = recovered;
    const blockedEnvelope = seal({
      id: nextId(), from: `${alice.handle}#3`, to: `${bob.handle}#1`, body: { text: "blocked during recovery" },
      senderSigningSecretKey: alice.identity.signing.secretKey, recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
    });
    expect((await deviceApi(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: blockedEnvelope })).status).toBe(403);
    expect((await deviceApi(alice, "/v1/friends/respond", { method: "POST", body: { peer: bob.handle, accept: true } })).status).toBe(403);
    expect((await deviceApi(bob, "/v1/friends/respond", { method: "POST", body: { peer: alice.handle, accept: true } })).status).toBe(200);
    expect((await deviceApi(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: blockedEnvelope })).status).toBe(202);
    expect((await deviceApi(bob, "/v1/mail?after=0")).status).toBe(200);
  });

  it("returns 429 at the per-pair burst limit", async () => {
    const alice = await createUser("alice", "open");
    const bob = await createUser("bob", "open");
    await becomeFriends(alice, bob);
    for (let index = 0; index < 20; index++) {
      const envelope = seal({
        id: nextId(), from: `${alice.handle}#1`, to: `${bob.handle}#1`, body: { text: `mail ${index}` },
        senderSigningSecretKey: alice.identity.signing.secretKey, recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
      });
      expect((await deviceApi(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: envelope })).status).toBe(202);
    }
    const overflow = seal({
      id: nextId(), from: `${alice.handle}#1`, to: `${bob.handle}#1`, body: { text: "overflow" },
      senderSigningSecretKey: alice.identity.signing.secretKey, recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
    });
    expect((await deviceApi(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: overflow })).status).toBe(429);
  });

  it("rejects oversized envelopes before crypto verification", async () => {
    const alice = await createUser("alice", "open");
    const bob = await createUser("bob", "open");
    await becomeFriends(alice, bob);
    const envelope = seal({
      id: nextId(), from: `${alice.handle}#1`, to: `${bob.handle}#1`, body: { text: "small" },
      senderSigningSecretKey: alice.identity.signing.secretKey, recipientEncryptionPublicKey: bob.identity.encryption.publicKey,
    });
    expect((await deviceApi(alice, `/v1/mail/${bob.handle}`, { method: "POST", body: { ...envelope, ct: "A".repeat(50_000) } })).status).toBe(413);
  });

  it("rejects unsigned, badly signed, and replayed device requests", async () => {
    const alice = await createUser("alice", "open");
    expect((await SELF.fetch("https://example.test/v1/friends")).status).toBe(401);
    expect((await SELF.fetch("https://example.test/v1/unknown")).status).toBe(404);
    const other = generateIdentity();
    expect((await deviceApi(alice, "/v1/friends", { identity: other })).status).toBe(401);
    const request = await makeDeviceRequest(alice, "/v1/friends");
    const replay = request.clone();
    expect((await SELF.fetch(request)).status).toBe(200);
    expect((await SELF.fetch(replay.url, { method: replay.method, headers: replay.headers })).status).toBe(409);
  });
});
