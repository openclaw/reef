import type { FriendView, FriendshipRow, HandleRow, RelayStore } from "@openclaw/reef-relay-core";

export class D1RelayStore implements RelayStore {
  constructor(private readonly db: D1Database) {}

  async startAuth(input: { email: string; emailHash: string; accountId: string; tokenHash: string; tokenExpires: number; now: number }): Promise<void> {
    await this.db.prepare("DELETE FROM auth_tokens WHERE expires < ? OR used = 1").bind(input.now).run();
    let account = await this.db.prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE").bind(input.email).first<{ id: string }>();
    if (!account) {
      await this.db.prepare("INSERT OR IGNORE INTO accounts(id, email, email_hash, created) VALUES (?, ?, ?, ?)")
        .bind(input.accountId, input.email, input.emailHash, input.now).run();
      account = await this.db.prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE").bind(input.email).first<{ id: string }>();
    }
    if (!account) throw new Error("account creation failed");
    await this.db.prepare("INSERT INTO auth_tokens(token_hash, account_id, expires) VALUES (?, ?, ?)")
      .bind(input.tokenHash, account.id, input.tokenExpires).run();
  }

  async completeAuth(input: { tokenHash: string; sessionHash: string; sessionExpires: number; now: number }): Promise<boolean> {
    const row = await this.db.prepare("SELECT account_id FROM auth_tokens WHERE token_hash = ? AND used = 0 AND expires >= ?")
      .bind(input.tokenHash, input.now).first<{ account_id: string }>();
    if (!row) return false;
    const used = await this.db.prepare("UPDATE auth_tokens SET used = 1 WHERE token_hash = ? AND used = 0").bind(input.tokenHash).run();
    if ((used.meta.changes ?? 0) !== 1) return false;
    await this.db.prepare("INSERT INTO sessions(token_hash, account_id, expires, created) VALUES (?, ?, ?, ?)")
      .bind(input.sessionHash, row.account_id, input.sessionExpires, input.now).run();
    return true;
  }

  async createHandle(row: HandleRow): Promise<boolean> {
    try {
      await this.db.prepare("INSERT INTO handles(handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(row.handle, row.account_id, row.ed25519_pub, row.x25519_pub, row.key_epoch, row.request_policy, row.created).run();
      return true;
    } catch {
      return false;
    }
  }

  async listOwnHandles(accountId: string): Promise<Array<Omit<HandleRow, "account_id">>> {
    const rows = await this.db.prepare("SELECT handle, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE account_id = ? ORDER BY handle")
      .bind(accountId).all<Omit<HandleRow, "account_id">>();
    return rows.results;
  }

  getHandle(handle: string): Promise<HandleRow | null> {
    return this.db.prepare("SELECT handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE handle = ?")
      .bind(handle).first<HandleRow>();
  }

  async rotateHandle(input: { handle: string; oldEpoch: number; oldEd25519: string; newEpoch: number; newEd25519: string; newX25519: string }): Promise<boolean> {
    const result = await this.db.prepare("UPDATE handles SET ed25519_pub = ?, x25519_pub = ?, key_epoch = ? WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?")
      .bind(input.newEd25519, input.newX25519, input.newEpoch, input.handle, input.oldEpoch, input.oldEd25519).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async recoverHandle(input: { handle: string; oldEpoch: number; oldEd25519: string; newEpoch: number; newEd25519: string; newX25519: string }): Promise<string[] | null> {
    const results = await this.db.batch([
      this.db.prepare("UPDATE handles SET ed25519_pub = ?, x25519_pub = ?, key_epoch = ? WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?")
        .bind(input.newEd25519, input.newX25519, input.newEpoch, input.handle, input.oldEpoch, input.oldEd25519),
      this.db.prepare(`UPDATE friendships SET status = 'reapprove_required', reapprove_handle = ?
        WHERE (a_handle = ? OR b_handle = ?) AND status = 'active'
        AND EXISTS (SELECT 1 FROM handles WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?)`)
        .bind(input.handle, input.handle, input.handle, input.handle, input.newEpoch, input.newEd25519),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return null;
    const rows = await this.db.prepare("SELECT a_handle, b_handle FROM friendships WHERE reapprove_handle = ? AND status = 'reapprove_required'")
      .bind(input.handle).all<{ a_handle: string; b_handle: string }>();
    return rows.results.map((row) => row.a_handle === input.handle ? row.b_handle : row.a_handle);
  }

  async createFriendCode(input: { handle: string; codeHash: string; expires: number }): Promise<void> {
    await this.db.prepare("INSERT INTO friend_codes(handle, code_hash, expires) VALUES (?, ?, ?)")
      .bind(input.handle, input.codeHash, input.expires).run();
  }

  async consumeFriendCode(input: { handle: string; codeHash: string; now: number }): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM friend_codes WHERE handle = ? AND code_hash = ? AND expires >= ?")
      .bind(input.handle, input.codeHash, input.now).run();
    return (result.meta.changes ?? 0) === 1;
  }

  getFriendship(pair: readonly [string, string]): Promise<FriendshipRow | null> {
    return this.db.prepare("SELECT a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created FROM friendships WHERE a_handle = ? AND b_handle = ?")
      .bind(pair[0], pair[1]).first<FriendshipRow>();
  }

  async findMutualFriend(a: string, b: string): Promise<string | null> {
    const row = await this.db.prepare(`WITH a_friends AS (
        SELECT CASE WHEN a_handle = ? THEN b_handle ELSE a_handle END AS friend FROM friendships WHERE status = 'active' AND (a_handle = ? OR b_handle = ?)
      ), b_friends AS (
        SELECT CASE WHEN a_handle = ? THEN b_handle ELSE a_handle END AS friend FROM friendships WHERE status = 'active' AND (a_handle = ? OR b_handle = ?)
      ) SELECT a_friends.friend FROM a_friends JOIN b_friends USING(friend) ORDER BY friend LIMIT 1`)
      .bind(a, a, a, b, b, b).first<{ friend: string }>();
    return row?.friend ?? null;
  }

  async upsertFriendRequest(input: { pair: readonly [string, string]; initiatedBy: string; vouchHandle: string | null; created: number }): Promise<void> {
    await this.db.prepare(`INSERT INTO friendships(a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created)
      VALUES (?, ?, 'pending', ?, ?, NULL, ?)
      ON CONFLICT(a_handle, b_handle) DO UPDATE SET status = 'pending', initiated_by = excluded.initiated_by, vouch_handle = excluded.vouch_handle, reapprove_handle = NULL, created = excluded.created
      WHERE friendships.status = 'reapprove_required'`)
      .bind(input.pair[0], input.pair[1], input.initiatedBy, input.vouchHandle, input.created).run();
  }

  async respondFriend(input: {
    pair: readonly [string, string]; current: FriendshipRow; peer: string; expectedKeyEpoch: number;
    expectedEd25519: string; expectedX25519: string; status: "active" | "blocked";
  }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE friendships SET status = ?, reapprove_handle = NULL
      WHERE a_handle = ? AND b_handle = ? AND status = ? AND initiated_by = ? AND reapprove_handle IS ?
      AND EXISTS (SELECT 1 FROM handles WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ? AND x25519_pub = ?)`)
      .bind(
        input.status, input.pair[0], input.pair[1], input.current.status, input.current.initiated_by,
        input.current.reapprove_handle, input.peer, input.expectedKeyEpoch, input.expectedEd25519, input.expectedX25519,
      ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async listFriends(handle: string): Promise<FriendView[]> {
    const rows = await this.db.prepare(`SELECT f.status, f.initiated_by, f.vouch_handle,
      h.handle, h.ed25519_pub, h.x25519_pub, h.key_epoch
      FROM friendships f JOIN handles h ON h.handle = CASE WHEN f.a_handle = ? THEN f.b_handle ELSE f.a_handle END
      WHERE f.a_handle = ? OR f.b_handle = ? ORDER BY h.handle`)
      .bind(handle, handle, handle).all<FriendView>();
    return rows.results;
  }

  async blockFriend(pair: readonly [string, string]): Promise<boolean> {
    const result = await this.db.prepare("UPDATE friendships SET status = 'blocked' WHERE a_handle = ? AND b_handle = ?")
      .bind(pair[0], pair[1]).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async addReport(input: { id: string; reporter: string; peer: string; reason: string; created: number }): Promise<void> {
    await this.db.prepare("INSERT INTO reports(id, reporter, peer, reason_category, created) VALUES (?, ?, ?, ?, ?)")
      .bind(input.id, input.reporter, input.peer, input.reason, input.created).run();
  }

  async accountForSession(sessionHash: string, now: number): Promise<string | null> {
    const row = await this.db.prepare("SELECT account_id FROM sessions WHERE token_hash = ? AND expires >= ?")
      .bind(sessionHash, now).first<{ account_id: string }>();
    return row?.account_id ?? null;
  }

  async consumeRequestReplay(replayKey: string, expires: number, now: number): Promise<boolean> {
    try {
      await this.db.batch([
        this.db.prepare("DELETE FROM request_replays WHERE expires < ?").bind(now),
        this.db.prepare("INSERT INTO request_replays(replay_key, expires) VALUES (?, ?)").bind(replayKey, expires),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async incrementRate(bucket: string, window: number): Promise<number> {
    const row = await this.db.prepare(`INSERT INTO rate_limits(bucket, window, count) VALUES (?, ?, 1)
      ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1 RETURNING count`)
      .bind(bucket, window).first<{ count: number }>();
    if (!row) throw new Error("rate increment failed");
    return row.count;
  }
}
