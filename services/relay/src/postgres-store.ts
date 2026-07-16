import type { FriendView, FriendshipRow, HandleRow, RelayStore } from "@openclaw/reef-relay-core";
import type { Pool, PoolClient } from "pg";

export class PostgresRelayStore implements RelayStore {
  constructor(private readonly pool: Pool) {}

  async startAuth(input: { email: string; emailHash: string; accountId: string; tokenHash: string; tokenExpires: number; now: number }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM auth_tokens WHERE expires < $1 OR used = 1", [input.now]);
      await client.query(
        "INSERT INTO accounts(id, email, email_hash, created) VALUES ($1, $2, $3, $4) ON CONFLICT(email) DO NOTHING",
        [input.accountId, input.email, input.emailHash, input.now],
      );
      const account = await client.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [input.email]);
      if (!account.rows[0]) throw new Error("account creation failed");
      await client.query("INSERT INTO auth_tokens(token_hash, account_id, expires) VALUES ($1, $2, $3)", [
        input.tokenHash, account.rows[0].id, input.tokenExpires,
      ]);
    });
  }

  async completeAuth(input: { tokenHash: string; sessionHash: string; sessionExpires: number; now: number }): Promise<boolean> {
    return this.transaction(async (client) => {
      const used = await client.query<{ account_id: string }>(
        "UPDATE auth_tokens SET used = 1 WHERE token_hash = $1 AND used = 0 AND expires >= $2 RETURNING account_id",
        [input.tokenHash, input.now],
      );
      const row = used.rows[0];
      if (!row) return false;
      await client.query("INSERT INTO sessions(token_hash, account_id, expires, created) VALUES ($1, $2, $3, $4)", [
        input.sessionHash, row.account_id, input.sessionExpires, input.now,
      ]);
      return true;
    });
  }

  async createHandle(row: HandleRow): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO handles(handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(handle) DO NOTHING`,
      [row.handle, row.account_id, row.ed25519_pub, row.x25519_pub, row.key_epoch, row.request_policy, row.created],
    );
    return result.rowCount === 1;
  }

  async listOwnHandles(accountId: string): Promise<Array<Omit<HandleRow, "account_id">>> {
    const result = await this.pool.query<Omit<HandleRow, "account_id">>(
      "SELECT handle, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE account_id = $1 ORDER BY handle",
      [accountId],
    );
    return result.rows;
  }

  async getHandle(handle: string): Promise<HandleRow | null> {
    const result = await this.pool.query<HandleRow>(
      "SELECT handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE handle = $1",
      [handle],
    );
    return result.rows[0] ?? null;
  }

  async rotateHandle(input: { handle: string; oldEpoch: number; oldEd25519: string; newEpoch: number; newEd25519: string; newX25519: string }): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE handles SET ed25519_pub = $1, x25519_pub = $2, key_epoch = $3 WHERE handle = $4 AND key_epoch = $5 AND ed25519_pub = $6",
      [input.newEd25519, input.newX25519, input.newEpoch, input.handle, input.oldEpoch, input.oldEd25519],
    );
    return result.rowCount === 1;
  }

  async recoverHandle(input: { handle: string; oldEpoch: number; oldEd25519: string; newEpoch: number; newEd25519: string; newX25519: string }): Promise<string[] | null> {
    return this.transaction(async (client) => {
      const updated = await client.query(
        "UPDATE handles SET ed25519_pub = $1, x25519_pub = $2, key_epoch = $3 WHERE handle = $4 AND key_epoch = $5 AND ed25519_pub = $6",
        [input.newEd25519, input.newX25519, input.newEpoch, input.handle, input.oldEpoch, input.oldEd25519],
      );
      if (updated.rowCount !== 1) return null;
      await client.query(
        `UPDATE friendships SET status = 'reapprove_required', reapprove_handle = $1
         WHERE (a_handle = $1 OR b_handle = $1) AND status = 'active'`,
        [input.handle],
      );
      const peers = await client.query<{ peer: string }>(
        `SELECT CASE WHEN a_handle = $1 THEN b_handle ELSE a_handle END AS peer
         FROM friendships WHERE reapprove_handle = $1 AND status = 'reapprove_required'`,
        [input.handle],
      );
      return peers.rows.map((row) => row.peer);
    });
  }

  async createFriendCode(input: { handle: string; codeHash: string; expires: number }): Promise<void> {
    await this.pool.query("INSERT INTO friend_codes(handle, code_hash, expires) VALUES ($1, $2, $3)", [input.handle, input.codeHash, input.expires]);
  }

  async consumeFriendCode(input: { handle: string; codeHash: string; now: number }): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM friend_codes WHERE handle = $1 AND code_hash = $2 AND expires >= $3", [
      input.handle, input.codeHash, input.now,
    ]);
    return result.rowCount === 1;
  }

  async getFriendship(pair: readonly [string, string]): Promise<FriendshipRow | null> {
    const result = await this.pool.query<FriendshipRow>(
      "SELECT a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created FROM friendships WHERE a_handle = $1 AND b_handle = $2",
      [pair[0], pair[1]],
    );
    return result.rows[0] ?? null;
  }

  async findMutualFriend(a: string, b: string): Promise<string | null> {
    const result = await this.pool.query<{ friend: string }>(
      `WITH a_friends AS (
         SELECT CASE WHEN a_handle = $1 THEN b_handle ELSE a_handle END AS friend
         FROM friendships WHERE status = 'active' AND (a_handle = $1 OR b_handle = $1)
       ), b_friends AS (
         SELECT CASE WHEN a_handle = $2 THEN b_handle ELSE a_handle END AS friend
         FROM friendships WHERE status = 'active' AND (a_handle = $2 OR b_handle = $2)
       ) SELECT a_friends.friend FROM a_friends JOIN b_friends USING(friend) ORDER BY friend LIMIT 1`,
      [a, b],
    );
    return result.rows[0]?.friend ?? null;
  }

  async upsertFriendRequest(input: { pair: readonly [string, string]; initiatedBy: string; vouchHandle: string | null; created: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO friendships(a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created)
       VALUES ($1, $2, 'pending', $3, $4, NULL, $5)
       ON CONFLICT(a_handle, b_handle) DO UPDATE SET
         status = 'pending', initiated_by = excluded.initiated_by, vouch_handle = excluded.vouch_handle,
         reapprove_handle = NULL, created = excluded.created
       WHERE friendships.status = 'reapprove_required'`,
      [input.pair[0], input.pair[1], input.initiatedBy, input.vouchHandle, input.created],
    );
  }

  async respondFriend(input: {
    pair: readonly [string, string]; current: FriendshipRow; peer: string; expectedKeyEpoch: number;
    expectedEd25519: string; expectedX25519: string; status: "active" | "blocked";
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE friendships SET status = $1, reapprove_handle = NULL
       WHERE a_handle = $2 AND b_handle = $3 AND status = $4 AND initiated_by = $5
       AND reapprove_handle IS NOT DISTINCT FROM $6
       AND EXISTS (SELECT 1 FROM handles WHERE handle = $7 AND key_epoch = $8 AND ed25519_pub = $9 AND x25519_pub = $10)`,
      [
        input.status, input.pair[0], input.pair[1], input.current.status, input.current.initiated_by,
        input.current.reapprove_handle, input.peer, input.expectedKeyEpoch, input.expectedEd25519, input.expectedX25519,
      ],
    );
    return result.rowCount === 1;
  }

  async listFriends(handle: string): Promise<FriendView[]> {
    const result = await this.pool.query<FriendView>(
      `SELECT f.status, f.initiated_by, f.vouch_handle, h.handle, h.ed25519_pub, h.x25519_pub, h.key_epoch
       FROM friendships f JOIN handles h ON h.handle = CASE WHEN f.a_handle = $1 THEN f.b_handle ELSE f.a_handle END
       WHERE f.a_handle = $1 OR f.b_handle = $1 ORDER BY h.handle`,
      [handle],
    );
    return result.rows;
  }

  async blockFriend(pair: readonly [string, string]): Promise<boolean> {
    const result = await this.pool.query("UPDATE friendships SET status = 'blocked' WHERE a_handle = $1 AND b_handle = $2", [pair[0], pair[1]]);
    return result.rowCount === 1;
  }

  async addReport(input: { id: string; reporter: string; peer: string; reason: string; created: number }): Promise<void> {
    await this.pool.query("INSERT INTO reports(id, reporter, peer, reason_category, created) VALUES ($1, $2, $3, $4, $5)", [
      input.id, input.reporter, input.peer, input.reason, input.created,
    ]);
  }

  async accountForSession(sessionHash: string, now: number): Promise<string | null> {
    const result = await this.pool.query<{ account_id: string }>(
      "SELECT account_id FROM sessions WHERE token_hash = $1 AND expires >= $2",
      [sessionHash, now],
    );
    return result.rows[0]?.account_id ?? null;
  }

  async consumeRequestReplay(replayKey: string, expires: number, now: number): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query("DELETE FROM request_replays WHERE expires < $1", [now]);
      const inserted = await client.query(
        "INSERT INTO request_replays(replay_key, expires) VALUES ($1, $2) ON CONFLICT(replay_key) DO NOTHING",
        [replayKey, expires],
      );
      return inserted.rowCount === 1;
    });
  }

  async incrementRate(bucket: string, window: number): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `INSERT INTO rate_limits(bucket, rate_window, count) VALUES ($1, $2, 1)
       ON CONFLICT(bucket, rate_window) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`,
      [bucket, window],
    );
    const row = result.rows[0];
    if (!row) throw new Error("rate increment failed");
    return row.count;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
