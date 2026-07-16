import {
  canonicalBytes,
  formatHandleEpoch,
  fromBase64url,
  parseHandleEpoch,
  verifyReceipt,
  verifyRotation,
  type Envelope,
  type SignedReceipt,
  type SignedRotation,
} from "@openclaw/reef-protocol";
import { canonicalSize, randomFriendCode, randomToken, sha256Hex, verifyEd25519, verifyEnvelopeForRelay } from "./crypto.js";
import { LIMITS } from "./limits.js";
import type {
  AcknowledgeResult,
  DeviceIdentity,
  EnqueueResult,
  FriendView,
  FriendshipRow,
  HandleRow,
  InboxEntry,
  InboxEntryKind,
  RequestPolicy,
} from "./types.js";

export { canonicalSize, randomFriendCode, randomToken, sha256Hex, verifyEd25519, verifyEnvelopeForRelay } from "./crypto.js";
export { LIMITS } from "./limits.js";
export type * from "./types.js";

export interface RelayStore {
  startAuth(input: { email: string; emailHash: string; accountId: string; tokenHash: string; tokenExpires: number; now: number }): Promise<void>;
  completeAuth(input: { tokenHash: string; sessionHash: string; sessionExpires: number; now: number }): Promise<boolean>;
  createHandle(row: HandleRow): Promise<boolean>;
  listOwnHandles(accountId: string): Promise<Array<Omit<HandleRow, "account_id">>>;
  getHandle(handle: string): Promise<HandleRow | null>;
  rotateHandle(input: { handle: string; oldEpoch: number; oldEd25519: string; newEpoch: number; newEd25519: string; newX25519: string }): Promise<boolean>;
  recoverHandle(input: { handle: string; oldEpoch: number; oldEd25519: string; newEpoch: number; newEd25519: string; newX25519: string }): Promise<string[] | null>;
  createFriendCode(input: { handle: string; codeHash: string; expires: number }): Promise<void>;
  consumeFriendCode(input: { handle: string; codeHash: string; now: number }): Promise<boolean>;
  getFriendship(pair: readonly [string, string]): Promise<FriendshipRow | null>;
  findMutualFriend(a: string, b: string): Promise<string | null>;
  upsertFriendRequest(input: { pair: readonly [string, string]; initiatedBy: string; vouchHandle: string | null; created: number }): Promise<void>;
  respondFriend(input: {
    pair: readonly [string, string];
    current: FriendshipRow;
    peer: string;
    expectedKeyEpoch: number;
    expectedEd25519: string;
    expectedX25519: string;
    status: "active" | "blocked";
  }): Promise<boolean>;
  listFriends(handle: string): Promise<FriendView[]>;
  blockFriend(pair: readonly [string, string]): Promise<boolean>;
  addReport(input: { id: string; reporter: string; peer: string; reason: string; created: number }): Promise<void>;
  accountForSession(sessionHash: string, now: number): Promise<string | null>;
  consumeRequestReplay(replayKey: string, expires: number, now: number): Promise<boolean>;
  incrementRate(bucket: string, window: number): Promise<number>;
}

export interface MailboxStore {
  enqueue(handle: string, peer: string, id: string, kind: InboxEntryKind, payloadJson: string, now: number): Promise<EnqueueResult>;
  pull(handle: string, after: number): Promise<{ entries: InboxEntry[]; cursor: number }>;
  acknowledge(handle: string, peer: string, id: string, receiptJson: string, now: number): Promise<AcknowledgeResult>;
  deletePeer(handle: string, peer: string): Promise<void>;
  destroy(handle: string): Promise<void>;
}

export interface EmailMessage {
  to: string;
  from: { email: string; name: string };
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface RelayAssets {
  fetch(request: Request): Promise<Response>;
}

export interface RelayConfig {
  publicOrigin: string;
  emailFrom: string;
  developmentMode: boolean;
  canonicalSiteHost?: string;
  redirectHosts?: ReadonlySet<string>;
}

export interface RelayDependencies {
  store: RelayStore;
  mailboxes: MailboxStore;
  email: EmailSender;
  assets: RelayAssets;
  config: RelayConfig;
  clientIp(request: Request): string;
  connectWebSocket?: (handle: string, request: Request) => Promise<Response>;
  log?: (record: Record<string, unknown>) => void;
}

export interface WebSocketAuthentication {
  handle: string;
}

export interface RelayApp {
  fetch(request: Request): Promise<Response>;
  authenticateWebSocket(request: Request): Promise<WebSocketAuthentication | Response>;
}

interface RequestData {
  bytes: Uint8Array;
  json: unknown;
}

interface AccountSession {
  accountId: string;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createRelayApp(deps: RelayDependencies): RelayApp {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await route(request, deps);
      } catch (error) {
        return handleError(error, deps);
      }
    },
    async authenticateWebSocket(request: Request): Promise<WebSocketAuthentication | Response> {
      try {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.pathname !== "/v1/mail/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          throw new HttpError(426, "upgrade_required");
        }
        const device = await authenticateDevice(request, new Uint8Array(), deps);
        await consumeRate(deps.store, `global:${device.handle}`, 3600, LIMITS.globalHandlePerHour);
        return { handle: device.handle };
      } catch (error) {
        return handleError(error, deps);
      }
    },
  };
}

function handleError(error: unknown, deps: RelayDependencies): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  (deps.log ?? ((record) => console.error(JSON.stringify(record))))({
    event: "request_error",
    error: error instanceof Error ? error.message : String(error),
  });
  return json({ error: "internal_error" }, 500);
}

async function route(request: Request, deps: RelayDependencies): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) {
    const redirect = canonicalSiteRedirect(request, deps.config);
    return redirect ?? deps.assets.fetch(request);
  }
  const data = await readRequestData(request);

  if (request.method === "POST" && url.pathname === "/v1/auth/start") return authStart(data.json, request, deps);
  if (request.method === "POST" && url.pathname === "/v1/auth/complete") return authComplete(data.json, deps);
  if (request.method === "GET" && url.pathname === "/v1/auth/complete") return authComplete({ token: url.searchParams.get("token") }, deps);
  if (request.method === "POST" && url.pathname === "/v1/handles") {
    return createHandle(data.json, await accountSession(request, deps), deps);
  }
  if (request.method === "GET" && url.pathname === "/v1/handles") {
    return listOwnHandles(await accountSession(request, deps), deps);
  }

  const rotationMatch = /^\/v1\/handles\/([^/]+)\/rotate$/.exec(url.pathname);
  if (request.method === "POST" && rotationMatch) {
    return rotateHandle(decodeURIComponent(rotationMatch[1]!), data, request, sessionToken(request), deps);
  }

  if (!isDeviceRoute(request.method, url.pathname)) throw new HttpError(404, "not_found");
  const device = await authenticateDevice(request, data.bytes, deps);
  await consumeRate(deps.store, `global:${device.handle}`, 3600, LIMITS.globalHandlePerHour);

  if (request.method === "POST" && url.pathname === "/v1/friend-codes") return mintCode(device, deps);
  if (request.method === "POST" && url.pathname === "/v1/friends/request") return requestFriend(data.json, device, deps);
  if (request.method === "POST" && url.pathname === "/v1/friends/respond") return respondFriend(data.json, device, deps);
  if (request.method === "GET" && url.pathname === "/v1/friends") return listFriends(device, deps);

  const friendDelete = /^\/v1\/friends\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && friendDelete) return removeFriend(decodeURIComponent(friendDelete[1]!), device, deps);

  if (request.method === "GET" && url.pathname === "/v1/mail/ws") return connectMailbox(device, request, deps);
  if (request.method === "GET" && url.pathname === "/v1/mail") return pullMail(url, device, deps);
  const mailAck = /^\/v1\/mail\/([^/]+)\/ack$/.exec(url.pathname);
  if (request.method === "POST" && mailAck) return acknowledgeMail(decodeURIComponent(mailAck[1]!), data.json, device, deps);
  const mail = /^\/v1\/mail\/([^/]+)$/.exec(url.pathname);
  if (mail && request.method === "POST") return sendMail(decodeURIComponent(mail[1]!), data.json, device, deps);
  if (request.method === "POST" && url.pathname === "/v1/report") return reportPeer(data.json, device, deps);
  throw new HttpError(404, "not_found");
}

async function authStart(value: unknown, request: Request, deps: RelayDependencies): Promise<Response> {
  const body = exactObject(value, ["email"]);
  const email = stringField(body, "email").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_request");
  const now = nowSeconds();
  const emailHash = await sha256Hex(email);
  await consumeRate(deps.store, `auth-email:${emailHash}`, 3600, LIMITS.authStartsPerEmailHour);
  await consumeRate(deps.store, `auth-ip:${deps.clientIp(request)}`, 3600, LIMITS.authStartsPerIpHour);
  const token = randomToken();
  await deps.store.startAuth({
    email,
    emailHash,
    accountId: crypto.randomUUID(),
    tokenHash: await sha256Hex(token),
    tokenExpires: now + LIMITS.magicTokenTtlSeconds,
    now,
  });
  const link = `${deps.config.publicOrigin.replace(/\/$/, "")}/welcome#token=${encodeURIComponent(token)}`;
  await deps.email.send(magicLinkMessage(email, link, deps.config.emailFrom));
  return deps.config.developmentMode ? json({ status: "sent", magicLink: link }) : json({ status: "sent" });
}

async function authComplete(value: unknown, deps: RelayDependencies): Promise<Response> {
  const token = stringField(exactObject(value, ["token"]), "token");
  const now = nowSeconds();
  const session = randomToken();
  const completed = await deps.store.completeAuth({
    tokenHash: await sha256Hex(token),
    sessionHash: await sha256Hex(session),
    sessionExpires: now + LIMITS.sessionTtlSeconds,
    now,
  });
  if (!completed) throw new HttpError(401, "invalid_or_expired_token");
  return json({ session, expires: now + LIMITS.sessionTtlSeconds });
}

async function createHandle(value: unknown, session: AccountSession, deps: RelayDependencies): Promise<Response> {
  const body = exactObject(value, ["handle", "ed25519_pub", "x25519_pub", "request_policy"]);
  const handle = stringField(body, "handle").toLowerCase();
  validateHandle(handle);
  const row: HandleRow = {
    handle,
    account_id: session.accountId,
    ed25519_pub: publicKeyField(body, "ed25519_pub"),
    x25519_pub: publicKeyField(body, "x25519_pub"),
    key_epoch: 1,
    request_policy: policyField(body.request_policy),
    created: nowSeconds(),
  };
  if (!await deps.store.createHandle(row)) throw new HttpError(409, "handle_unavailable");
  return json({ handle, key_epoch: 1, request_policy: row.request_policy }, 201);
}

async function listOwnHandles(session: AccountSession, deps: RelayDependencies): Promise<Response> {
  return json({ handles: await deps.store.listOwnHandles(session.accountId) });
}

async function rotateHandle(
  handle: string,
  data: RequestData,
  request: Request,
  bearer: string | undefined,
  deps: RelayDependencies,
): Promise<Response> {
  validateHandle(handle);
  const current = await deps.store.getHandle(handle);
  if (!current) throw new HttpError(404, "not_found");
  const body = exactObject(data.json, ["signedRotation", "recovery"], true);
  if (body.signedRotation !== undefined) {
    const device = await authenticateDevice(request, data.bytes, deps);
    if (device.handle !== handle) throw new HttpError(403, "forbidden");
    const rotation = body.signedRotation as SignedRotation;
    if (!verifyRotation(rotation, current.ed25519_pub) || rotation.newEpoch !== current.key_epoch + 1) throw new HttpError(400, "invalid_rotation");
    const updated = await deps.store.rotateHandle({
      handle,
      oldEpoch: current.key_epoch,
      oldEd25519: current.ed25519_pub,
      newEpoch: rotation.newEpoch,
      newEd25519: rotation.newEd25519Pub,
      newX25519: rotation.newX25519Pub,
    });
    if (!updated) throw new HttpError(409, "rotation_conflict");
    return json({ handle, key_epoch: rotation.newEpoch, recovery: false });
  }
  if (!bearer) throw new HttpError(401, "unauthorized");
  const session = await accountSession(request, deps);
  if (session.accountId !== current.account_id) throw new HttpError(403, "forbidden");
  const recovery = exactObject(body.recovery, ["newEd25519Pub", "newX25519Pub"]);
  const nextEpoch = current.key_epoch + 1;
  const peers = await deps.store.recoverHandle({
    handle,
    oldEpoch: current.key_epoch,
    oldEd25519: current.ed25519_pub,
    newEpoch: nextEpoch,
    newEd25519: publicKeyField(recovery, "newEd25519Pub"),
    newX25519: publicKeyField(recovery, "newX25519Pub"),
  });
  if (!peers) throw new HttpError(409, "rotation_conflict");
  await deps.mailboxes.destroy(handle);
  await Promise.all(peers.map((peer) => deps.mailboxes.deletePeer(peer, handle)));
  return json({ handle, key_epoch: nextEpoch, recovery: true, reapproval_required: peers.length });
}

async function mintCode(device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  const code = randomFriendCode();
  const expires = nowSeconds() + LIMITS.friendCodeTtlSeconds;
  await deps.store.createFriendCode({ handle: device.handle, codeHash: await sha256Hex(code), expires });
  return json({ code, expires });
}

async function requestFriend(value: unknown, device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  const body = exactObject(value, ["to", "code"], true);
  const to = stringField(body, "to").toLowerCase();
  const generic = () => json({ status: "pending" }, 202);
  await consumeRate(deps.store, `friend-requester:${device.handle}`, 3600, LIMITS.friendRequestsPerRequesterHour);
  await consumeRate(deps.store, `friend-target:${to}`, 3600, LIMITS.friendRequestsPerTargetHour);
  if (!isHandle(to) || to === device.handle) return generic();
  const target = await deps.store.getHandle(to);
  if (!target) return generic();
  const pair = sortedPair(device.handle, to);
  const existing = await deps.store.getFriendship(pair);
  if (existing && ["blocked", "active", "pending"].includes(existing.status)) return generic();
  let allowed = target.request_policy === "open";
  let vouch: string | null = null;
  if (target.request_policy === "code-only" && typeof body.code === "string") {
    allowed = await deps.store.consumeFriendCode({ handle: to, codeHash: await sha256Hex(body.code), now: nowSeconds() });
  }
  if (target.request_policy === "friends-of-friends") {
    vouch = await deps.store.findMutualFriend(device.handle, to);
    allowed = vouch !== null;
  }
  if (!allowed) return generic();
  await deps.store.upsertFriendRequest({ pair, initiatedBy: device.handle, vouchHandle: vouch, created: nowSeconds() });
  return generic();
}

async function respondFriend(value: unknown, device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  const body = exactObject(value, ["peer", "accept", "expected_key_epoch", "expected_ed25519_pub", "expected_x25519_pub"]);
  const peer = stringField(body, "peer").toLowerCase();
  const expectedKeyEpoch = body.expected_key_epoch;
  const expectedEd25519 = publicKeyField(body, "expected_ed25519_pub");
  const expectedX25519 = publicKeyField(body, "expected_x25519_pub");
  if (typeof body.accept !== "boolean" || !isHandle(peer) || !Number.isSafeInteger(expectedKeyEpoch) || (expectedKeyEpoch as number) < 1) {
    throw new HttpError(400, "invalid_request");
  }
  const pair = sortedPair(device.handle, peer);
  const friendship = await deps.store.getFriendship(pair);
  if (!friendship || !["pending", "reapprove_required"].includes(friendship.status)) throw new HttpError(404, "not_found");
  if (friendship.status === "pending" && friendship.initiated_by === device.handle) throw new HttpError(403, "requester_cannot_respond");
  if (friendship.status === "reapprove_required" && friendship.reapprove_handle === device.handle) throw new HttpError(403, "peer_reapproval_required");
  const status = body.accept ? "active" : "blocked";
  const updated = await deps.store.respondFriend({
    pair,
    current: friendship,
    peer,
    expectedKeyEpoch: expectedKeyEpoch as number,
    expectedEd25519,
    expectedX25519,
    status,
  });
  if (!updated) throw new HttpError(409, "friendship_changed");
  if (!body.accept) await purgeFriendshipMailboxes(device.handle, peer, deps);
  return json({ peer, status });
}

async function listFriends(device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  const rows = await deps.store.listFriends(device.handle);
  return json({ friendships: rows.map((row) => ({
    peer: row.handle,
    status: row.status,
    initiated_by: row.initiated_by,
    vouching_mutual: row.vouch_handle,
    ed25519_pub: row.ed25519_pub,
    x25519_pub: row.x25519_pub,
    key_epoch: row.key_epoch,
  })) });
}

async function removeFriend(peer: string, device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  if (!isHandle(peer)) throw new HttpError(404, "not_found");
  if (!await deps.store.blockFriend(sortedPair(device.handle, peer))) throw new HttpError(404, "not_found");
  await purgeFriendshipMailboxes(device.handle, peer, deps);
  return new Response(null, { status: 204 });
}

async function sendMail(peer: string, value: unknown, device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  const pair = await requireActiveFriend(peer, device.handle, deps);
  if (canonicalSize(value) > LIMITS.envelopeBytes) throw new HttpError(413, "envelope_too_large");
  const envelope = value as Envelope;
  if (envelope.from !== formatHandleEpoch(device.handle, device.row.key_epoch)) throw new HttpError(400, "invalid_envelope_peers");
  const peerRow = await deps.store.getHandle(peer);
  if (!peerRow || envelope.to !== formatHandleEpoch(peer, peerRow.key_epoch)) throw new HttpError(400, "invalid_envelope_peers");
  if (!await verifyEnvelopeForRelay(value, device.row.ed25519_pub)) throw new HttpError(400, "invalid_envelope");
  const rateKey = pairName(pair[0], pair[1]);
  await consumeRate(deps.store, `mail-hour:${rateKey}`, 3600, LIMITS.mailPerPairHour);
  await consumeRate(deps.store, `mail-minute:${rateKey}`, 60, LIMITS.mailBurstPerMinute);
  const result = await deps.mailboxes.enqueue(peer, device.handle, envelope.id, "message", JSON.stringify(envelope), nowSeconds());
  if (result.result === "capacity") throw new HttpError(429, "mailbox_full");
  return json({ id: envelope.id, status: result.result }, result.result === "queued" ? 202 : 200);
}

async function pullMail(url: URL, device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  const after = Number(url.searchParams.get("after") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "invalid_after");
  return json(await deps.mailboxes.pull(device.handle, after));
}

async function connectMailbox(device: DeviceIdentity, request: Request, deps: RelayDependencies): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required");
  if (!deps.connectWebSocket) throw new HttpError(426, "upgrade_required");
  return deps.connectWebSocket(device.handle, request);
}

async function acknowledgeMail(peer: string, value: unknown, device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  await requireActiveFriend(peer, device.handle, deps);
  const body = exactObject(value, ["id", "receipt"]);
  const id = stringField(body, "id");
  const receipt = body.receipt as SignedReceipt;
  if (receipt?.id !== id || !verifyReceipt(receipt, device.row.ed25519_pub)) throw new HttpError(400, "invalid_receipt");
  const result = await deps.mailboxes.acknowledge(device.handle, peer, id, JSON.stringify(receipt), nowSeconds());
  if (result.result === "missing") throw new HttpError(404, "not_found");
  const forwarded = await deps.mailboxes.enqueue(peer, device.handle, id, "receipt", result.receiptJson!, nowSeconds());
  if (forwarded.result === "capacity") throw new HttpError(429, "mailbox_full");
  return json({ result: result.result, receipt: result.receiptJson ? JSON.parse(result.receiptJson) as unknown : undefined });
}

async function reportPeer(value: unknown, device: DeviceIdentity, deps: RelayDependencies): Promise<Response> {
  const body = exactObject(value, ["peer", "reason-category"]);
  const peer = stringField(body, "peer").toLowerCase();
  const reason = stringField(body, "reason-category");
  if (!isHandle(peer) || !/^[a-z0-9_-]{1,64}$/.test(reason)) throw new HttpError(400, "invalid_request");
  await deps.store.addReport({ id: crypto.randomUUID(), reporter: device.handle, peer, reason, created: nowSeconds() });
  return json({ status: "recorded" }, 202);
}

async function authenticateDevice(request: Request, body: Uint8Array, deps: RelayDependencies): Promise<DeviceIdentity> {
  const url = new URL(request.url);
  const handle = (request.headers.get("x-reef-handle") ?? url.searchParams.get("handle") ?? "").toLowerCase();
  const tsRaw = request.headers.get("x-reef-ts") ?? url.searchParams.get("ts") ?? "";
  const signature = request.headers.get("x-reef-sig") ?? url.searchParams.get("sig") ?? "";
  const ts = Number(tsRaw);
  if (!isHandle(handle) || !Number.isSafeInteger(ts) || Math.abs(nowSeconds() - ts) > LIMITS.deviceClockSkewSeconds || signature.length > 128) {
    throw new HttpError(401, "invalid_device_signature");
  }
  const row = await deps.store.getHandle(handle);
  if (!row) throw new HttpError(401, "invalid_device_signature");
  const message = canonicalBytes({ method: request.method.toUpperCase(), path: canonicalSignedPath(url), ts, bodySha256: await sha256Hex(body) });
  if (!await verifyEd25519(row.ed25519_pub, signature, message)) throw new HttpError(401, "invalid_device_signature");
  const replayKey = `${handle}:${ts}:${signature.slice(0, 24)}`;
  if (!await deps.store.consumeRequestReplay(replayKey, nowSeconds() + LIMITS.replayTtlSeconds, nowSeconds())) {
    throw new HttpError(409, "replayed_request");
  }
  return { handle, row };
}

export function canonicalSignedPath(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("sig");
  params.delete("ts");
  params.delete("handle");
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

export function canonicalSiteRedirect(request: Request, config: RelayConfig): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/") || !config.canonicalSiteHost || !config.redirectHosts?.has(url.hostname.toLowerCase())) return undefined;
  url.protocol = "https:";
  url.hostname = config.canonicalSiteHost;
  url.port = "";
  return Response.redirect(url.toString(), 301);
}

function isDeviceRoute(method: string, path: string): boolean {
  if (method === "POST" && ["/v1/friend-codes", "/v1/friends/request", "/v1/friends/respond", "/v1/report"].includes(path)) return true;
  if (method === "GET" && path === "/v1/friends") return true;
  if (method === "DELETE" && /^\/v1\/friends\/[^/]+$/.test(path)) return true;
  if (method === "GET" && (path === "/v1/mail" || path === "/v1/mail/ws")) return true;
  return method === "POST" && /^\/v1\/mail\/[^/]+(?:\/ack)?$/.test(path);
}

async function accountSession(request: Request, deps: RelayDependencies): Promise<AccountSession> {
  const token = sessionToken(request);
  if (!token) throw new HttpError(401, "unauthorized");
  const accountId = await deps.store.accountForSession(await sha256Hex(token), nowSeconds());
  if (!accountId) throw new HttpError(401, "unauthorized");
  return { accountId };
}

function sessionToken(request: Request): string | undefined {
  return /^Bearer ([A-Fa-f0-9]{64})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
}

async function requireActiveFriend(peer: string, handle: string, deps: RelayDependencies): Promise<readonly [string, string]> {
  if (!isHandle(peer) || peer === handle) throw new HttpError(404, "not_found");
  const pair = sortedPair(handle, peer);
  if ((await deps.store.getFriendship(pair))?.status !== "active") throw new HttpError(403, "friendship_not_active");
  return pair;
}

async function consumeRate(store: RelayStore, bucket: string, seconds: number, limit: number): Promise<void> {
  const count = await store.incrementRate(bucket, Math.floor(nowSeconds() / seconds));
  if (count > limit) throw new HttpError(429, "rate_limited");
}

async function readRequestData(request: Request): Promise<RequestData> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > LIMITS.requestBodyBytes) throw new HttpError(413, "request_too_large");
  if (request.method === "GET" || request.method === "DELETE") return { bytes: new Uint8Array(), json: undefined };
  const reader = request.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), json: undefined };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > LIMITS.requestBodyBytes) {
      await reader.cancel();
      throw new HttpError(413, "request_too_large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return { bytes, json: undefined };
  try {
    return { bytes, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function exactObject(value: unknown, allowed: string[], optional = false): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => allowed.includes(key))) throw new HttpError(400, "invalid_request");
  if (!optional && !allowed.every((key) => Object.hasOwn(record, key))) throw new HttpError(400, "invalid_request");
  return record;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "invalid_request");
  return value;
}

function publicKeyField(record: Record<string, unknown>, field: string): string {
  const value = stringField(record, field);
  try {
    if (fromBase64url(value).length !== 32) throw new Error();
  } catch {
    throw new HttpError(400, "invalid_public_key");
  }
  return value;
}

function policyField(value: unknown): RequestPolicy {
  if (value !== "code-only" && value !== "friends-of-friends" && value !== "open") throw new HttpError(400, "invalid_policy");
  return value;
}

function isHandle(value: string): boolean {
  try {
    return parseHandleEpoch(`${value}#1`).handle === value;
  } catch {
    return false;
  }
}

function validateHandle(value: string): void {
  if (!isHandle(value)) throw new HttpError(400, "invalid_handle");
}

function sortedPair(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}

function pairName(a: string, b: string): string {
  return sortedPair(a, b).join("|");
}

async function purgeFriendshipMailboxes(a: string, b: string, deps: RelayDependencies): Promise<void> {
  await Promise.all([deps.mailboxes.deletePeer(a, b), deps.mailboxes.deletePeer(b, a)]);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function magicLinkMessage(to: string, link: string, from: string): EmailMessage {
  return {
    to,
    from: { email: from, name: "Reef" },
    subject: "Your Reef sign-in link",
    html: `<!doctype html>
<html lang="en"><body style="margin:0;background:#061d24;color:#eaf4f2;font-family:Manrope,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:48px 24px">
<div style="border-top:1px solid rgba(168,213,204,.35);border-bottom:1px solid rgba(168,213,204,.35);padding:36px 0">
<p style="margin:0 0 18px;color:#a8d5cc;font:12px monospace;letter-spacing:.12em;text-transform:uppercase">Reef · guarded claw channel</p>
<h1 style="margin:0 0 18px;color:#eaf4f2;font:400 38px/1.05 Georgia,serif">Sign in to Reef</h1>
<p style="margin:0 0 28px;color:#a6bdb9;font-size:16px;line-height:1.65">Verify your email to continue setting up your Reef handle.</p>
<a href="${link}" style="display:inline-block;padding:14px 22px;background:#ff7a59;color:#10262b;text-decoration:none;font-size:14px;font-weight:700">Continue to Reef&nbsp;&nbsp;→</a>
<p style="margin:28px 0 0;color:#789792;font:12px/1.6 monospace">This link expires soon and can only be used once.</p>
</div>
</div></body></html>`,
    text: `Sign in to Reef\n\nOpen this link to verify your email and continue setup:\n${link}\n\nThis link expires soon and can only be used once.`,
  };
}
