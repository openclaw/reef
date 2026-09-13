import { HttpError, isHandle, nowSeconds } from "./http.js";
import type { FriendshipRow, HandleRow } from "./types.js";

export async function requireActiveFriend(peer: string, handle: string, env: Env): Promise<readonly [string, string]> {
  if (!isHandle(peer) || peer === handle) throw new HttpError(404, "not_found");
  const pair = sortedPair(handle, peer);
  const row = await friendshipRow(env.DB, pair);
  if (row?.status !== "active") throw new HttpError(403, "friendship_not_active");
  return pair;
}

export async function getHandle(db: D1Database, handle: string): Promise<HandleRow | null> {
  return db.prepare("SELECT handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE handle = ?")
    .bind(handle).first<HandleRow>();
}

export async function friendshipRow(db: D1Database, pair: readonly [string, string]): Promise<FriendshipRow | null> {
  return db.prepare("SELECT a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created FROM friendships WHERE a_handle = ? AND b_handle = ?")
    .bind(pair[0], pair[1]).first<FriendshipRow>();
}

export async function mutualFriend(db: D1Database, a: string, b: string): Promise<string | null> {
  const row = await db.prepare(`WITH a_friends AS (
      SELECT CASE WHEN a_handle = ? THEN b_handle ELSE a_handle END AS friend FROM friendships WHERE status = 'active' AND (a_handle = ? OR b_handle = ?)
    ), b_friends AS (
      SELECT CASE WHEN a_handle = ? THEN b_handle ELSE a_handle END AS friend FROM friendships WHERE status = 'active' AND (a_handle = ? OR b_handle = ?)
    ) SELECT a_friends.friend FROM a_friends JOIN b_friends USING(friend) ORDER BY friend LIMIT 1`)
    .bind(a, a, a, b, b, b).first<{ friend: string }>();
  return row?.friend ?? null;
}

export async function consumeRate(db: D1Database, bucket: string, seconds: number, limit: number): Promise<void> {
  const window = Math.floor(nowSeconds() / seconds);
  const result = await db.prepare(`INSERT INTO rate_limits(bucket, window, count) VALUES (?, ?, 1)
    ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1 RETURNING count`).bind(bucket, window).first<{ count: number }>();
  if (!result || result.count > limit) throw new HttpError(429, "rate_limited");
}

export function sortedPair(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function mailbox(env: Env, handle: string) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(handle));
}

export async function purgeFriendshipMailboxes(a: string, b: string, env: Env): Promise<void> {
  await Promise.all([mailbox(env, a).deletePeer(b), mailbox(env, b).deletePeer(a)]);
}

export function peerFromPair(a: string, b: string, handle: string): string {
  return a === handle ? b : a;
}
