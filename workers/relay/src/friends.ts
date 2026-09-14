import { randomFriendCode, sha256Hex } from "./crypto.js";
import { exactObject, HttpError, isHandle, json, nowSeconds, publicKeyField, stringField } from "./http.js";
import { LIMITS } from "./limits.js";
import { consumeRate, friendshipRow, getHandle, inboundAllowed, mutualFriend, purgeFriendshipMailboxes, requireActiveFriend, sortedPair } from "./registry.js";
import type { DeviceIdentity, FriendshipRow } from "./types.js";

export async function mintCode(device: DeviceIdentity, env: Env): Promise<Response> {
  const code = randomFriendCode();
  const expires = nowSeconds() + LIMITS.friendCodeTtlSeconds;
  await env.DB.prepare("INSERT INTO friend_codes(handle, code_hash, expires) VALUES (?, ?, ?)")
    .bind(device.handle, await sha256Hex(code), expires).run();
  return json({ code, expires });
}

export async function requestFriend(value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
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

export async function respondFriend(value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "peer") &&
    Object.hasOwn(value, "accept")
  ) {
    const legacy = value as Record<string, unknown>;
    if (typeof legacy.peer === "string" && isHandle(legacy.peer) && typeof legacy.accept === "boolean") {
      throw new HttpError(409, "client_upgrade_required");
    }
  }
  const body = exactObject(value, [
    "peer",
    "accept",
    "expected_key_epoch",
    "expected_ed25519_pub",
    "expected_x25519_pub",
  ]);
  const peer = stringField(body, "peer").toLowerCase();
  const expectedKeyEpoch = body.expected_key_epoch;
  const expectedEd25519 = publicKeyField(body, "expected_ed25519_pub");
  const expectedX25519 = publicKeyField(body, "expected_x25519_pub");
  if (
    typeof body.accept !== "boolean" ||
    !isHandle(peer) ||
    !Number.isSafeInteger(expectedKeyEpoch) ||
    (expectedKeyEpoch as number) < 1
  ) throw new HttpError(400, "invalid_request");
  const pair = sortedPair(device.handle, peer);
  const friendship = await friendshipRow(env.DB, pair);
  if (!friendship || !["pending", "reapprove_required"].includes(friendship.status)) throw new HttpError(404, "not_found");
  if (friendship.status === "pending" && friendship.initiated_by === device.handle) throw new HttpError(403, "requester_cannot_respond");
  if (friendship.status === "reapprove_required" && friendship.reapprove_handle === device.handle) throw new HttpError(403, "peer_reapproval_required");
  const updated = await env.DB.prepare(`UPDATE friendships SET status = ?, reapprove_handle = NULL
    WHERE a_handle = ? AND b_handle = ? AND status = ? AND initiated_by = ? AND reapprove_handle IS ?
    AND EXISTS (SELECT 1 FROM handles
      WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ? AND x25519_pub = ?)`)
    .bind(
      body.accept ? "active" : "blocked",
      pair[0],
      pair[1],
      friendship.status,
      friendship.initiated_by,
      friendship.reapprove_handle,
      peer,
      expectedKeyEpoch,
      expectedEd25519,
      expectedX25519,
    ).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new HttpError(409, "friendship_changed");
  if (!body.accept) await purgeFriendshipMailboxes(device.handle, peer, env);
  return json({ peer, status: body.accept ? "active" : "blocked" });
}

export async function listFriends(device: DeviceIdentity, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT f.a_handle, f.b_handle, f.a_inbound_allowed, f.b_inbound_allowed,
    f.status, f.initiated_by, f.vouch_handle,
    h.handle, h.ed25519_pub, h.x25519_pub, h.key_epoch
    FROM friendships f JOIN handles h ON h.handle = CASE WHEN f.a_handle = ? THEN f.b_handle ELSE f.a_handle END
    WHERE f.a_handle = ? OR f.b_handle = ? ORDER BY h.handle`)
    .bind(device.handle, device.handle, device.handle).all<FriendshipRow & { handle: string; ed25519_pub: string; x25519_pub: string; key_epoch: number }>();
  return json({ friendships: rows.results.map((row) => ({
    peer: row.handle, status: row.status, initiated_by: row.initiated_by, vouching_mutual: row.vouch_handle,
    ed25519_pub: row.ed25519_pub, x25519_pub: row.x25519_pub, key_epoch: row.key_epoch,
    inbound_allowed: inboundAllowed(row, device.handle),
    outbound_allowed: inboundAllowed(row, row.handle),
  })) });
}

export async function setInboundAllowed(peer: string, value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  const body = exactObject(value, ["inbound_allowed"]);
  if (!isHandle(peer)) throw new HttpError(404, "not_found");
  if (typeof body.inbound_allowed !== "boolean") throw new HttpError(400, "invalid_request");
  const friendship = await requireActiveFriend(peer, device.handle, env);
  const column = device.handle === friendship.a_handle ? "a_inbound_allowed" : "b_inbound_allowed";
  const updated = await env.DB.prepare(`UPDATE friendships SET ${column} = ?
    WHERE a_handle = ? AND b_handle = ? AND status = 'active'`)
    .bind(body.inbound_allowed ? 1 : 0, friendship.a_handle, friendship.b_handle).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new HttpError(409, "friendship_changed");
  return json({ peer, inbound_allowed: body.inbound_allowed });
}

export async function removeFriend(peer: string, device: DeviceIdentity, env: Env): Promise<Response> {
  if (!isHandle(peer)) throw new HttpError(404, "not_found");
  const pair = sortedPair(device.handle, peer);
  const result = await env.DB.prepare("UPDATE friendships SET status = 'blocked' WHERE a_handle = ? AND b_handle = ?")
    .bind(pair[0], pair[1]).run();
  if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, "not_found");
  await purgeFriendshipMailboxes(device.handle, peer, env);
  return new Response(null, { status: 204 });
}

export async function reportPeer(value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  const body = exactObject(value, ["peer", "reason-category"]);
  const peer = stringField(body, "peer").toLowerCase();
  const reason = stringField(body, "reason-category");
  if (!isHandle(peer) || !/^[a-z0-9_-]{1,64}$/.test(reason)) throw new HttpError(400, "invalid_request");
  await env.DB.prepare("INSERT INTO reports(id, reporter, peer, reason_category, created) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), device.handle, peer, reason, nowSeconds()).run();
  return json({ status: "recorded" }, 202);
}
