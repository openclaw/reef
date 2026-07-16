import {
  LIMITS,
  type AcknowledgeResult,
  type EnqueueResult,
  type InboxEntry,
  type InboxEntryKind,
  type MailboxStore,
} from "@openclaw/reef-relay-core";
import type { Notification, Pool, PoolClient } from "pg";
import WebSocket from "ws";

interface EntryRow {
  seq: string | number;
  peer: string;
  id: string;
  kind: InboxEntryKind;
  payload_json: string;
  ts: number;
}

interface LocalConnection {
  socket: WebSocket;
  generation: number;
}

type MailboxNotification =
  | { type: "entry"; handle: string; seq: number }
  | { type: "replace"; handle: string; generation: number };

export class PostgresMailboxes implements MailboxStore {
  private readonly connections = new Map<string, LocalConnection>();
  private listener: PoolClient | undefined;
  private listening = false;

  constructor(private readonly pool: Pool, private readonly log: (record: Record<string, unknown>) => void) {}

  async start(): Promise<void> {
    this.listener = await this.pool.connect();
    this.listener.on("notification", (notification) => {
      void this.onNotification(notification).catch((error) => {
        this.log({ event: "postgres_notification_error", error: error instanceof Error ? error.message : String(error) });
      });
    });
    this.listener.on("error", (error) => {
      this.listening = false;
      this.log({ event: "postgres_listener_error", error: error.message });
    });
    await this.listener.query("LISTEN reef_mailbox");
    this.listening = true;
  }

  isReady(): boolean {
    return this.listening;
  }

  async close(): Promise<void> {
    this.listening = false;
    for (const connection of this.connections.values()) connection.socket.close(1001, "relay shutting down");
    this.connections.clear();
    if (this.listener) {
      await this.listener.query("UNLISTEN reef_mailbox").catch(() => undefined);
      this.listener.release();
      this.listener = undefined;
    }
  }

  async attach(handle: string, socket: WebSocket): Promise<void> {
    const generation = await this.claimConnection(handle);
    this.connections.get(handle)?.socket.close(1012, "replaced by newer connection");
    const connection = { socket, generation };
    this.connections.set(handle, connection);
    socket.on("message", (data, isBinary) => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data);
      const size = buffer.byteLength;
      if (size > LIMITS.wsMessageBytes) {
        socket.close(1009, "message too large");
        return;
      }
      if (!isBinary && buffer.toString() === "ping") socket.send("pong");
    });
    socket.on("close", () => {
      if (this.connections.get(handle) === connection) this.connections.delete(handle);
    });
  }

  async enqueue(handle: string, peer: string, id: string, kind: InboxEntryKind, payloadJson: string, now: number): Promise<EnqueueResult> {
    const result = await this.transaction(async (client) => {
      await lockMailbox(client, handle);
      await expireMailbox(client, handle, now);
      if (kind === "message") {
        const acked = await client.query("SELECT 1 FROM mailbox_acks WHERE handle = $1 AND peer = $2 AND id = $3", [handle, peer, id]);
        if (acked.rowCount) return { result: "duplicate" } as const;
      }
      const existing = await client.query(
        "SELECT seq FROM mailbox_entries WHERE handle = $1 AND peer = $2 AND id = $3 AND kind = $4",
        [handle, peer, id, kind],
      );
      if (existing.rowCount) return { result: "duplicate" } as const;
      const count = await client.query<{ count: string }>("SELECT COUNT(*) AS count FROM mailbox_entries WHERE handle = $1", [handle]);
      if (Number(count.rows[0]?.count ?? 0) >= LIMITS.mailboxEntriesPerHandle) return { result: "capacity" } as const;
      const inserted = await client.query<{ seq: string }>(
        `INSERT INTO mailbox_entries(handle, peer, id, kind, payload_json, ts)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING seq`,
        [handle, peer, id, kind, payloadJson, now],
      );
      return { result: "queued", seq: safeNumber(inserted.rows[0]!.seq) } as const;
    });
    if (result.result === "queued") await this.notify({ type: "entry", handle, seq: result.seq });
    return result;
  }

  async pull(handle: string, after: number): Promise<{ entries: InboxEntry[]; cursor: number }> {
    const now = Math.floor(Date.now() / 1000);
    await this.pool.query("DELETE FROM mailbox_entries WHERE handle = $1 AND ts <= $2", [
      handle, now - LIMITS.envelopeRetentionSeconds,
    ]);
    const result = await this.pool.query<EntryRow>(
      `SELECT seq, peer, id, kind, payload_json, ts FROM mailbox_entries
       WHERE handle = $1 AND seq > $2 ORDER BY seq LIMIT 200`,
      [handle, after],
    );
    const entries = result.rows.map(inboxEntry);
    return { entries, cursor: entries.at(-1)?.seq ?? after };
  }

  async acknowledge(handle: string, peer: string, id: string, receiptJson: string, now: number): Promise<AcknowledgeResult> {
    return this.transaction(async (client) => {
      await lockMailbox(client, handle);
      await expireMailbox(client, handle, now);
      const cached = await client.query<{ receipt_json: string }>(
        "SELECT receipt_json FROM mailbox_acks WHERE handle = $1 AND peer = $2 AND id = $3",
        [handle, peer, id],
      );
      if (cached.rows[0]) return { result: "cached", receiptJson: cached.rows[0].receipt_json };
      const removed = await client.query(
        "DELETE FROM mailbox_entries WHERE handle = $1 AND peer = $2 AND id = $3 AND kind = 'message'",
        [handle, peer, id],
      );
      if (removed.rowCount !== 1) return { result: "missing" };
      await client.query("INSERT INTO mailbox_acks(handle, peer, id, receipt_json, ts) VALUES ($1, $2, $3, $4, $5)", [
        handle, peer, id, receiptJson, now,
      ]);
      return { result: "acked", receiptJson };
    });
  }

  async deletePeer(handle: string, peer: string): Promise<void> {
    await this.transaction(async (client) => {
      await lockMailbox(client, handle);
      await client.query("DELETE FROM mailbox_entries WHERE handle = $1 AND peer = $2", [handle, peer]);
      await client.query("DELETE FROM mailbox_acks WHERE handle = $1 AND peer = $2", [handle, peer]);
    });
  }

  async destroy(handle: string): Promise<void> {
    const generation = await this.transaction(async (client) => {
      await lockMailbox(client, handle);
      await client.query("DELETE FROM mailbox_entries WHERE handle = $1", [handle]);
      await client.query("DELETE FROM mailbox_acks WHERE handle = $1", [handle]);
      return incrementGeneration(client, handle);
    });
    await this.notify({ type: "replace", handle, generation });
  }

  async cleanup(now = Math.floor(Date.now() / 1000)): Promise<void> {
    const cutoff = now - LIMITS.envelopeRetentionSeconds;
    await this.pool.query("DELETE FROM mailbox_entries WHERE ts <= $1", [cutoff]);
    await this.pool.query("DELETE FROM mailbox_acks WHERE ts <= $1", [cutoff]);
    await this.pool.query("DELETE FROM auth_tokens WHERE expires < $1 OR used = 1", [now]);
    await this.pool.query("DELETE FROM sessions WHERE expires < $1", [now]);
    await this.pool.query("DELETE FROM friend_codes WHERE expires < $1", [now]);
    await this.pool.query("DELETE FROM request_replays WHERE expires < $1", [now]);
    await this.pool.query("DELETE FROM rate_limits WHERE rate_window < $1", [Math.floor(now / 3600) - 1]);
  }

  private async claimConnection(handle: string): Promise<number> {
    const generation = await this.transaction((client) => incrementGeneration(client, handle));
    await this.notify({ type: "replace", handle, generation });
    return generation;
  }

  private async notify(notification: MailboxNotification): Promise<void> {
    await this.pool.query("SELECT pg_notify('reef_mailbox', $1)", [JSON.stringify(notification)]);
  }

  private async onNotification(notification: Notification): Promise<void> {
    if (!notification.payload) return;
    let parsed: MailboxNotification;
    try {
      parsed = JSON.parse(notification.payload) as MailboxNotification;
    } catch {
      return;
    }
    const connection = this.connections.get(parsed.handle);
    if (!connection) return;
    if (parsed.type === "replace") {
      if (connection.generation < parsed.generation) connection.socket.close(1012, "replaced by newer connection");
      return;
    }
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    const result = await this.pool.query<EntryRow>(
      "SELECT seq, peer, id, kind, payload_json, ts FROM mailbox_entries WHERE handle = $1 AND seq = $2",
      [parsed.handle, parsed.seq],
    );
    const row = result.rows[0];
    if (row) {
      try {
        connection.socket.send(JSON.stringify({ type: "entry", entry: inboxEntry(row) }));
      } catch {
        connection.socket.close(1011, "push failed");
      }
    }
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

async function lockMailbox(client: PoolClient, handle: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [handle]);
}

async function expireMailbox(client: PoolClient, handle: string, now: number): Promise<void> {
  const cutoff = now - LIMITS.envelopeRetentionSeconds;
  await client.query("DELETE FROM mailbox_entries WHERE handle = $1 AND ts <= $2", [handle, cutoff]);
  await client.query("DELETE FROM mailbox_acks WHERE handle = $1 AND ts <= $2", [handle, cutoff]);
}

async function incrementGeneration(client: PoolClient, handle: string): Promise<number> {
  const result = await client.query<{ generation: string }>(
    `INSERT INTO mailbox_connections(handle, generation) VALUES ($1, 1)
     ON CONFLICT(handle) DO UPDATE SET generation = mailbox_connections.generation + 1 RETURNING generation`,
    [handle],
  );
  return safeNumber(result.rows[0]!.generation);
}

function inboxEntry(row: EntryRow): InboxEntry {
  const payload = JSON.parse(row.payload_json) as unknown;
  const base = { seq: safeNumber(row.seq), peer: row.peer, id: row.id, ts: row.ts };
  return row.kind === "message"
    ? { ...base, kind: "message", envelope: payload }
    : { ...base, kind: "receipt", receipt: payload };
}

function safeNumber(value: string | number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("mailbox sequence exceeded JavaScript safe integer range");
  return number;
}
