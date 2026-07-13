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
import { sha256Hex, randomToken, verifyEd25519, verifyEnvelopeForRelay, canonicalSize } from "./crypto.js";
import { LIMITS } from "./limits.js";
import { Mailbox } from "./mailbox.js";
import type { DeviceIdentity, FriendshipRow, HandleRow, RequestPolicy } from "./types.js";

export { Mailbox };

interface RequestData {
  bytes: Uint8Array;
  json: unknown;
}

interface AccountSession {
  accountId: string;
}

interface EmailSender {
  sendMagicLink(email: string, link: string): Promise<void>;
}

const MAGIC_LINK_ORIGIN = "https://reefwire.ai";
const CANONICAL_SITE_HOST = "reefwire.ai";
const SITE_REDIRECT_HOSTS = new Set([
  "reefwire.dev",
  "reefwire.io",
  "reef.openclaw.ai",
  "www.reefwire.ai",
  "reef-relay.services-91b.workers.dev",
]);

class LogEmailSender implements EmailSender {
  async sendMagicLink(email: string, link: string): Promise<void> {
    console.log(JSON.stringify({ event: "magic_link", email, link }));
  }
}

class CloudflareEmailSender implements EmailSender {
  constructor(private readonly binding: SendEmail) {}

  async sendMagicLink(email: string, link: string): Promise<void> {
    await this.binding.send({
      to: email,
      from: { email: "hello@reefwire.ai", name: "Reef" },
      subject: "Your Reef sign-in link",
      html: magicLinkHtml(link),
      text: `Sign in to Reef\n\nOpen this link to verify your email and continue setup:\n${link}\n\nThis link expires soon and can only be used once.`,
    });
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: "request_error", error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) {
    const redirect = canonicalSiteRedirect(request);
    return redirect ?? env.ASSETS.fetch(request);
  }
  const data = await readRequestData(request);

  if (request.method === "POST" && url.pathname === "/v1/auth/start") return authStart(data.json, request, env);
  if (request.method === "POST" && url.pathname === "/v1/auth/complete") return authComplete(data.json, env);
  if (request.method === "GET" && url.pathname === "/v1/auth/complete") return authComplete({ token: url.searchParams.get("token") }, env);
  if (request.method === "POST" && url.pathname === "/v1/handles") {
    const session = await accountSession(request, env);
    return createHandle(data.json, session, env);
  }
  if (request.method === "GET" && url.pathname === "/v1/handles") {
    const session = await accountSession(request, env);
    return listOwnHandles(session, env);
  }

  const rotationMatch = /^\/v1\/handles\/([^/]+)\/rotate$/.exec(url.pathname);
  if (request.method === "POST" && rotationMatch) return rotateHandle(decodeURIComponent(rotationMatch[1]!), data, request, sessionToken(request), env);

  if (!isDeviceRoute(request.method, url.pathname)) throw new HttpError(404, "not_found");
  const device = await deviceIdentity(request, data.bytes, env);
  await consumeRate(env.DB, `global:${device.handle}`, 3600, LIMITS.globalHandlePerHour);

  if (request.method === "POST" && url.pathname === "/v1/friend-codes") return mintCode(device, env);
  if (request.method === "POST" && url.pathname === "/v1/friends/request") return requestFriend(data.json, device, env);
  if (request.method === "POST" && url.pathname === "/v1/friends/respond") return respondFriend(data.json, device, env);
  if (request.method === "GET" && url.pathname === "/v1/friends") return listFriends(device, env);

  const friendDelete = /^\/v1\/friends\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && friendDelete) return removeFriend(decodeURIComponent(friendDelete[1]!), device, env);

  if (request.method === "GET" && url.pathname === "/v1/mail/ws") return connectMailbox(device, request, env);
  if (request.method === "GET" && url.pathname === "/v1/mail") return pullMail(url, device, env);
  const mailAck = /^\/v1\/mail\/([^/]+)\/ack$/.exec(url.pathname);
  if (request.method === "POST" && mailAck) return acknowledgeMail(decodeURIComponent(mailAck[1]!), data.json, device, env);
  const mail = /^\/v1\/mail\/([^/]+)$/.exec(url.pathname);
  if (mail && request.method === "POST") return sendMail(decodeURIComponent(mail[1]!), data.json, device, env);
  if (request.method === "POST" && url.pathname === "/v1/report") return reportPeer(data.json, device, env);
  throw new HttpError(404, "not_found");
}

async function authStart(value: unknown, request: Request, env: Env): Promise<Response> {
  const body = exactObject(value, ["email"]);
  const email = stringField(body, "email").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_request");
  const now = nowSeconds();
  const emailHash = await sha256Hex(email);
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await consumeRate(env.DB, `auth-email:${emailHash}`, 3600, LIMITS.authStartsPerEmailHour);
  await consumeRate(env.DB, `auth-ip:${clientIp}`, 3600, LIMITS.authStartsPerIpHour);
  await env.DB.prepare("DELETE FROM auth_tokens WHERE expires < ? OR used = 1").bind(now).run();
  let account = await env.DB.prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE").bind(email).first<{ id: string }>();
  if (!account) {
    account = { id: crypto.randomUUID() };
    await env.DB.prepare("INSERT INTO accounts(id, email, email_hash, created) VALUES (?, ?, ?, ?)")
      .bind(account.id, email, emailHash, now).run();
  }
  const token = randomToken();
  await env.DB.prepare("INSERT INTO auth_tokens(token_hash, account_id, expires) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), account.id, now + LIMITS.magicTokenTtlSeconds).run();
  const link = `${MAGIC_LINK_ORIGIN}/welcome#token=${encodeURIComponent(token)}`;
  const sender = env.DEV_MODE === "1" || !env.EMAIL ? new LogEmailSender() : new CloudflareEmailSender(env.EMAIL);
  await sender.sendMagicLink(email, link);
  return env.DEV_MODE === "1" ? json({ status: "sent", magicLink: link }) : json({ status: "sent" });
}

export function canonicalSiteRedirect(request: Request): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/") || !SITE_REDIRECT_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  url.protocol = "https:";
  url.hostname = CANONICAL_SITE_HOST;
  url.port = "";
  return Response.redirect(url.toString(), 301);
}

function magicLinkHtml(link: string): string {
  return `<!doctype html>
<html lang="en"><body style="margin:0;background:#061d24;color:#eaf4f2;font-family:Manrope,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:48px 24px">
<div style="border-top:1px solid rgba(168,213,204,.35);border-bottom:1px solid rgba(168,213,204,.35);padding:36px 0">
<p style="margin:0 0 18px;color:#a8d5cc;font:12px monospace;letter-spacing:.12em;text-transform:uppercase">Reef · guarded claw channel</p>
<h1 style="margin:0 0 18px;color:#eaf4f2;font:400 38px/1.05 Georgia,serif">Sign in to Reef</h1>
<p style="margin:0 0 28px;color:#a6bdb9;font-size:16px;line-height:1.65">Verify your email to continue setting up your Reef handle.</p>
<a href="${link}" style="display:inline-block;padding:14px 22px;background:#ff7a59;color:#10262b;text-decoration:none;font-size:14px;font-weight:700">Continue to Reef&nbsp;&nbsp;→</a>
<p style="margin:28px 0 0;color:#789792;font:12px/1.6 monospace">This link expires soon and can only be used once.</p>
</div>
</div></body></html>`;
}

async function authComplete(value: unknown, env: Env): Promise<Response> {
  const body = exactObject(value, ["token"]);
  const token = stringField(body, "token");
  const hash = await sha256Hex(token);
  const now = nowSeconds();
  const row = await env.DB.prepare("SELECT account_id FROM auth_tokens WHERE token_hash = ? AND used = 0 AND expires >= ?")
    .bind(hash, now).first<{ account_id: string }>();
  if (!row) throw new HttpError(401, "invalid_or_expired_token");
  const used = await env.DB.prepare("UPDATE auth_tokens SET used = 1 WHERE token_hash = ? AND used = 0").bind(hash).run();
  if ((used.meta.changes ?? 0) !== 1) throw new HttpError(401, "invalid_or_expired_token");
  const session = randomToken();
  await env.DB.prepare("INSERT INTO sessions(token_hash, account_id, expires, created) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(session), row.account_id, now + LIMITS.sessionTtlSeconds, now).run();
  return json({ session, expires: now + LIMITS.sessionTtlSeconds });
}

async function createHandle(value: unknown, session: AccountSession, env: Env): Promise<Response> {
  const body = exactObject(value, ["handle", "ed25519_pub", "x25519_pub", "request_policy"]);
  const handle = stringField(body, "handle").toLowerCase();
  validateHandle(handle);
  const ed25519 = publicKeyField(body, "ed25519_pub");
  const x25519 = publicKeyField(body, "x25519_pub");
  const policy = policyField(body.request_policy);
  try {
    await env.DB.prepare("INSERT INTO handles(handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .bind(handle, session.accountId, ed25519, x25519, policy, nowSeconds()).run();
  } catch {
    throw new HttpError(409, "handle_unavailable");
  }
  return json({ handle, key_epoch: 1, request_policy: policy }, 201);
}

async function listOwnHandles(session: AccountSession, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT handle, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE account_id = ? ORDER BY handle")
    .bind(session.accountId).all<Omit<HandleRow, "account_id">>();
  return json({ handles: rows.results });
}

async function rotateHandle(handle: string, data: RequestData, request: Request, bearer: string | undefined, env: Env): Promise<Response> {
  validateHandle(handle);
  const current = await getHandle(env.DB, handle);
  if (!current) throw new HttpError(404, "not_found");
  const body = exactObject(data.json, ["signedRotation", "recovery"], true);
  if (body.signedRotation !== undefined) {
    const device = await deviceIdentity(request, data.bytes, env);
    if (device.handle !== handle) throw new HttpError(403, "forbidden");
    const rotation = body.signedRotation as SignedRotation;
    if (!verifyRotation(rotation, current.ed25519_pub) || rotation.newEpoch !== current.key_epoch + 1) throw new HttpError(400, "invalid_rotation");
    const updated = await env.DB.prepare("UPDATE handles SET ed25519_pub = ?, x25519_pub = ?, key_epoch = ? WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?")
      .bind(rotation.newEd25519Pub, rotation.newX25519Pub, rotation.newEpoch, handle, current.key_epoch, current.ed25519_pub).run();
    if ((updated.meta.changes ?? 0) !== 1) throw new HttpError(409, "rotation_conflict");
    return json({ handle, key_epoch: rotation.newEpoch, recovery: false });
  }
  if (!bearer) throw new HttpError(401, "unauthorized");
  const session = await accountSession(request, env);
  if (session.accountId !== current.account_id) throw new HttpError(403, "forbidden");
  const recovery = exactObject(body.recovery, ["newEd25519Pub", "newX25519Pub"]);
  const ed25519 = publicKeyField(recovery, "newEd25519Pub");
  const x25519 = publicKeyField(recovery, "newX25519Pub");
  const nextEpoch = current.key_epoch + 1;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE handles SET ed25519_pub = ?, x25519_pub = ?, key_epoch = ? WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?")
      .bind(ed25519, x25519, nextEpoch, handle, current.key_epoch, current.ed25519_pub),
    env.DB.prepare(`UPDATE friendships SET status = 'reapprove_required', reapprove_handle = ?
      WHERE (a_handle = ? OR b_handle = ?) AND status = 'active'
      AND EXISTS (SELECT 1 FROM handles WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?)`)
      .bind(handle, handle, handle, handle, nextEpoch, ed25519),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new HttpError(409, "rotation_conflict");
  const peers = await env.DB.prepare("SELECT a_handle, b_handle FROM friendships WHERE reapprove_handle = ? AND status = 'reapprove_required'")
    .bind(handle).all<{ a_handle: string; b_handle: string }>();
  await mailbox(env, handle).destroy();
  await Promise.all(peers.results.map((pair) => mailbox(env, peerFromPair(pair.a_handle, pair.b_handle, handle)).deletePeer(handle)));
  return json({ handle, key_epoch: nextEpoch, recovery: true, reapproval_required: peers.results.length });
}

async function mintCode(device: DeviceIdentity, env: Env): Promise<Response> {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32]).join("");
  const expires = nowSeconds() + LIMITS.friendCodeTtlSeconds;
  await env.DB.prepare("INSERT INTO friend_codes(handle, code_hash, expires) VALUES (?, ?, ?)")
    .bind(device.handle, await sha256Hex(code), expires).run();
  return json({ code, expires });
}

async function requestFriend(value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  const body = exactObject(value, ["to", "code"], true);
  const to = stringField(body, "to").toLowerCase();
  const generic = () => json({ status: "pending" }, 202);
  await consumeRate(env.DB, `friend-requester:${device.handle}`, 3600, LIMITS.friendRequestsPerRequesterHour);
  await consumeRate(env.DB, `friend-target:${to}`, 3600, LIMITS.friendRequestsPerTargetHour);
  if (!isHandle(to) || to === device.handle) return generic();
  const target = await getHandle(env.DB, to);
  if (!target) return generic();
  const pair = sortedPair(device.handle, to);
  const existing = await env.DB.prepare("SELECT status FROM friendships WHERE a_handle = ? AND b_handle = ?")
    .bind(pair[0], pair[1]).first<{ status: string }>();
  if (existing?.status === "blocked" || existing?.status === "active" || existing?.status === "pending") return generic();
  let allowed = false;
  let vouch: string | null = null;
  if (target.request_policy === "open") allowed = true;
  if (target.request_policy === "code-only" && typeof body.code === "string") {
    const hash = await sha256Hex(body.code);
    const burned = await env.DB.prepare("DELETE FROM friend_codes WHERE handle = ? AND code_hash = ? AND expires >= ?")
      .bind(to, hash, nowSeconds()).run();
    allowed = (burned.meta.changes ?? 0) === 1;
  }
  if (target.request_policy === "friends-of-friends") {
    vouch = await mutualFriend(env.DB, device.handle, to);
    allowed = vouch !== null;
  }
  if (!allowed) return generic();
  await env.DB.prepare(`INSERT INTO friendships(a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created)
    VALUES (?, ?, 'pending', ?, ?, NULL, ?)
    ON CONFLICT(a_handle, b_handle) DO UPDATE SET status = 'pending', initiated_by = excluded.initiated_by, vouch_handle = excluded.vouch_handle, reapprove_handle = NULL, created = excluded.created
    WHERE friendships.status = 'reapprove_required'`)
    .bind(pair[0], pair[1], device.handle, vouch, nowSeconds()).run();
  return generic();
}

async function respondFriend(value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  const body = exactObject(value, ["peer", "accept"]);
  const peer = stringField(body, "peer").toLowerCase();
  if (typeof body.accept !== "boolean" || !isHandle(peer)) throw new HttpError(400, "invalid_request");
  const pair = sortedPair(device.handle, peer);
  const friendship = await friendshipRow(env.DB, pair);
  if (!friendship || !["pending", "reapprove_required"].includes(friendship.status)) throw new HttpError(404, "not_found");
  if (friendship.status === "pending" && friendship.initiated_by === device.handle) throw new HttpError(403, "requester_cannot_respond");
  if (friendship.status === "reapprove_required" && friendship.reapprove_handle === device.handle) throw new HttpError(403, "peer_reapproval_required");
  await env.DB.prepare("UPDATE friendships SET status = ?, reapprove_handle = NULL WHERE a_handle = ? AND b_handle = ?")
    .bind(body.accept ? "active" : "blocked", pair[0], pair[1]).run();
  if (!body.accept) await purgeFriendshipMailboxes(device.handle, peer, env);
  return json({ peer, status: body.accept ? "active" : "blocked" });
}

async function listFriends(device: DeviceIdentity, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT f.status, f.initiated_by, f.vouch_handle,
    h.handle, h.ed25519_pub, h.x25519_pub, h.key_epoch
    FROM friendships f JOIN handles h ON h.handle = CASE WHEN f.a_handle = ? THEN f.b_handle ELSE f.a_handle END
    WHERE f.a_handle = ? OR f.b_handle = ? ORDER BY h.handle`)
    .bind(device.handle, device.handle, device.handle).all<{ status: string; initiated_by: string; vouch_handle: string | null; handle: string; ed25519_pub: string; x25519_pub: string; key_epoch: number }>();
  return json({ friendships: rows.results.map((row) => ({
    peer: row.handle, status: row.status, initiated_by: row.initiated_by, vouching_mutual: row.vouch_handle,
    ed25519_pub: row.ed25519_pub, x25519_pub: row.x25519_pub, key_epoch: row.key_epoch,
  })) });
}

async function removeFriend(peer: string, device: DeviceIdentity, env: Env): Promise<Response> {
  if (!isHandle(peer)) throw new HttpError(404, "not_found");
  const pair = sortedPair(device.handle, peer);
  const result = await env.DB.prepare("UPDATE friendships SET status = 'blocked' WHERE a_handle = ? AND b_handle = ?")
    .bind(pair[0], pair[1]).run();
  if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, "not_found");
  await purgeFriendshipMailboxes(device.handle, peer, env);
  return new Response(null, { status: 204 });
}

async function sendMail(peer: string, value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  const pair = await requireActiveFriend(peer, device.handle, env);
  if (canonicalSize(value) > LIMITS.envelopeBytes) throw new HttpError(413, "envelope_too_large");
  const envelope = value as Envelope;
  if (envelope.from !== formatHandleEpoch(device.handle, device.row.key_epoch)) throw new HttpError(400, "invalid_envelope_peers");
  const peerRow = await getHandle(env.DB, peer);
  if (!peerRow || envelope.to !== formatHandleEpoch(peer, peerRow.key_epoch)) throw new HttpError(400, "invalid_envelope_peers");
  if (!await verifyEnvelopeForRelay(value, device.row.ed25519_pub)) throw new HttpError(400, "invalid_envelope");
  const rateKey = pairName(pair[0], pair[1]);
  await consumeRate(env.DB, `mail-hour:${rateKey}`, 3600, LIMITS.mailPerPairHour);
  await consumeRate(env.DB, `mail-minute:${rateKey}`, 60, LIMITS.mailBurstPerMinute);
  const result = await mailbox(env, peer).enqueue(device.handle, envelope.id, "message", JSON.stringify(envelope), nowSeconds());
  if (result.result === "capacity") throw new HttpError(429, "mailbox_full");
  return json({ id: envelope.id, status: result.result }, result.result === "queued" ? 202 : 200);
}

async function pullMail(url: URL, device: DeviceIdentity, env: Env): Promise<Response> {
  const afterRaw = url.searchParams.get("after") ?? "0";
  const after = Number(afterRaw);
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "invalid_after");
  return json(await mailbox(env, device.handle).pull(after));
}

async function connectMailbox(device: DeviceIdentity, request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required");
  const internal = new URL("https://mailbox/connect");
  return mailbox(env, device.handle).fetch(new Request(internal, request));
}

async function acknowledgeMail(peer: string, value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  await requireActiveFriend(peer, device.handle, env);
  const body = exactObject(value, ["id", "receipt"]);
  const id = stringField(body, "id");
  const receipt = body.receipt as SignedReceipt;
  if (receipt?.id !== id || !verifyReceipt(receipt, device.row.ed25519_pub)) throw new HttpError(400, "invalid_receipt");
  const result = await mailbox(env, device.handle).acknowledge(peer, id, JSON.stringify(receipt), nowSeconds());
  if (result.result === "missing") throw new HttpError(404, "not_found");
  const forwarded = await mailbox(env, peer).enqueue(device.handle, id, "receipt", result.receiptJson!, nowSeconds());
  if (forwarded.result === "capacity") throw new HttpError(429, "mailbox_full");
  return json({ result: result.result, receipt: result.receiptJson ? JSON.parse(result.receiptJson) as unknown : undefined });
}

async function reportPeer(value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  const body = exactObject(value, ["peer", "reason-category"]);
  const peer = stringField(body, "peer").toLowerCase();
  const reason = stringField(body, "reason-category");
  if (!isHandle(peer) || !/^[a-z0-9_-]{1,64}$/.test(reason)) throw new HttpError(400, "invalid_request");
  await env.DB.prepare("INSERT INTO reports(id, reporter, peer, reason_category, created) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), device.handle, peer, reason, nowSeconds()).run();
  return json({ status: "recorded" }, 202);
}

async function deviceIdentity(request: Request, body: Uint8Array, env: Env): Promise<DeviceIdentity> {
  const url = new URL(request.url);
  const handle = (request.headers.get("x-reef-handle") ?? url.searchParams.get("handle") ?? "").toLowerCase();
  const tsRaw = request.headers.get("x-reef-ts") ?? url.searchParams.get("ts") ?? "";
  const signature = request.headers.get("x-reef-sig") ?? url.searchParams.get("sig") ?? "";
  const ts = Number(tsRaw);
  if (!isHandle(handle) || !Number.isSafeInteger(ts) || Math.abs(nowSeconds() - ts) > LIMITS.deviceClockSkewSeconds || signature.length > 128) {
    throw new HttpError(401, "invalid_device_signature");
  }
  const row = await getHandle(env.DB, handle);
  if (!row) throw new HttpError(401, "invalid_device_signature");
  const signedPath = canonicalSignedPath(url);
  const message = canonicalBytes({ method: request.method.toUpperCase(), path: signedPath, ts, bodySha256: await sha256Hex(body) });
  if (!await verifyEd25519(row.ed25519_pub, signature, message)) throw new HttpError(401, "invalid_device_signature");
  const replayKey = `${handle}:${ts}:${signature.slice(0, 24)}`;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_replays WHERE expires < ?").bind(nowSeconds()),
      env.DB.prepare("INSERT INTO request_replays(replay_key, expires) VALUES (?, ?)").bind(replayKey, nowSeconds() + LIMITS.replayTtlSeconds),
    ]);
  } catch {
    throw new HttpError(409, "replayed_request");
  }
  return { handle, row };
}

function canonicalSignedPath(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("sig");
  params.delete("ts");
  params.delete("handle");
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

function isDeviceRoute(method: string, path: string): boolean {
  if (method === "POST" && ["/v1/friend-codes", "/v1/friends/request", "/v1/friends/respond", "/v1/report"].includes(path)) return true;
  if (method === "GET" && path === "/v1/friends") return true;
  if (method === "DELETE" && /^\/v1\/friends\/[^/]+$/.test(path)) return true;
  if (method === "GET" && (path === "/v1/mail" || path === "/v1/mail/ws")) return true;
  return method === "POST" && /^\/v1\/mail\/[^/]+(?:\/ack)?$/.test(path);
}

async function accountSession(request: Request, env: Env): Promise<AccountSession> {
  const token = sessionToken(request);
  if (!token) throw new HttpError(401, "unauthorized");
  const row = await env.DB.prepare("SELECT account_id FROM sessions WHERE token_hash = ? AND expires >= ?")
    .bind(await sha256Hex(token), nowSeconds()).first<{ account_id: string }>();
  if (!row) throw new HttpError(401, "unauthorized");
  return { accountId: row.account_id };
}

function sessionToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  const match = /^Bearer ([A-Fa-f0-9]{64})$/.exec(authorization ?? "");
  return match?.[1];
}

async function requireActiveFriend(peer: string, handle: string, env: Env): Promise<readonly [string, string]> {
  if (!isHandle(peer) || peer === handle) throw new HttpError(404, "not_found");
  const pair = sortedPair(handle, peer);
  const row = await friendshipRow(env.DB, pair);
  if (row?.status !== "active") throw new HttpError(403, "friendship_not_active");
  return pair;
}

async function getHandle(db: D1Database, handle: string): Promise<HandleRow | null> {
  return db.prepare("SELECT handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE handle = ?")
    .bind(handle).first<HandleRow>();
}

async function friendshipRow(db: D1Database, pair: readonly [string, string]): Promise<FriendshipRow | null> {
  return db.prepare("SELECT a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created FROM friendships WHERE a_handle = ? AND b_handle = ?")
    .bind(pair[0], pair[1]).first<FriendshipRow>();
}

async function mutualFriend(db: D1Database, a: string, b: string): Promise<string | null> {
  const row = await db.prepare(`WITH a_friends AS (
      SELECT CASE WHEN a_handle = ? THEN b_handle ELSE a_handle END AS friend FROM friendships WHERE status = 'active' AND (a_handle = ? OR b_handle = ?)
    ), b_friends AS (
      SELECT CASE WHEN a_handle = ? THEN b_handle ELSE a_handle END AS friend FROM friendships WHERE status = 'active' AND (a_handle = ? OR b_handle = ?)
    ) SELECT a_friends.friend FROM a_friends JOIN b_friends USING(friend) ORDER BY friend LIMIT 1`)
    .bind(a, a, a, b, b, b).first<{ friend: string }>();
  return row?.friend ?? null;
}

async function consumeRate(db: D1Database, bucket: string, seconds: number, limit: number): Promise<void> {
  const window = Math.floor(nowSeconds() / seconds);
  const result = await db.prepare(`INSERT INTO rate_limits(bucket, window, count) VALUES (?, ?, 1)
    ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1 RETURNING count`).bind(bucket, window).first<{ count: number }>();
  if (!result || result.count > limit) throw new HttpError(429, "rate_limited");
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength === 0) return { bytes, json: undefined };
  try { return { bytes, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }; }
  catch { throw new HttpError(400, "invalid_json"); }
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
  try { if (fromBase64url(value).length !== 32) throw new Error(); }
  catch { throw new HttpError(400, "invalid_public_key"); }
  return value;
}

function policyField(value: unknown): RequestPolicy {
  if (value !== "code-only" && value !== "friends-of-friends" && value !== "open") throw new HttpError(400, "invalid_policy");
  return value;
}

function isHandle(value: string): boolean {
  try { return parseHandleEpoch(`${value}#1`).handle === value; } catch { return false; }
}

function validateHandle(value: string): void {
  if (!isHandle(value)) throw new HttpError(400, "invalid_handle");
}

function sortedPair(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}

function pairName(a: string, b: string): string {
  const pair = sortedPair(a, b);
  return `${pair[0]}|${pair[1]}`;
}

function mailbox(env: Env, handle: string) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(handle));
}

async function purgeFriendshipMailboxes(a: string, b: string, env: Env): Promise<void> {
  await Promise.all([mailbox(env, a).deletePeer(b), mailbox(env, b).deletePeer(a)]);
}

function peerFromPair(a: string, b: string, handle: string): string {
  return a === handle ? b : a;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
