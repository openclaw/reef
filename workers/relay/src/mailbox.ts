import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "./limits.js";
import type { InboxEntry, InboxEntryKind } from "./types.js";

interface EntryRow {
  [key: string]: string | number | null;
  seq: number;
  peer: string;
  id: string;
  kind: InboxEntryKind;
  payload_json: string;
  ts: number;
}

interface AckRow {
  [key: string]: string | number | null;
  peer: string;
  id: string;
  receipt_json: string;
  ts: number;
}

type EnqueueResult = { result: "queued"; seq: number } | { result: "duplicate" | "capacity" };

export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          peer TEXT NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('message', 'receipt')),
          payload_json TEXT NOT NULL,
          ts INTEGER NOT NULL,
          UNIQUE(peer, id, kind)
        );
        CREATE INDEX IF NOT EXISTS entries_seq ON entries(seq);
        CREATE INDEX IF NOT EXISTS entries_expiry ON entries(ts);
        CREATE TABLE IF NOT EXISTS acks (
          peer TEXT NOT NULL,
          id TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          ts INTEGER NOT NULL,
          PRIMARY KEY(peer, id)
        );
        CREATE INDEX IF NOT EXISTS acks_expiry ON acks(ts);
      `);
    });
  }

  async enqueue(peer: string, id: string, kind: InboxEntryKind, payloadJson: string, now: number): Promise<EnqueueResult> {
    if (kind === "message") {
      const acked = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM acks WHERE peer = ? AND id = ?", peer, id).toArray();
      if (acked.length > 0) return { result: "duplicate" };
    }
    const existing = this.ctx.storage.sql.exec<{ seq: number }>(
      "SELECT seq FROM entries WHERE peer = ? AND id = ? AND kind = ?", peer, id, kind,
    ).toArray();
    if (existing.length > 0) return { result: "duplicate" };
    const queued = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM entries").one().count;
    if (queued >= LIMITS.mailboxEntriesPerHandle) return { result: "capacity" };
    const seq = this.ctx.storage.sql.exec<{ seq: number }>(
      "INSERT INTO entries(peer, id, kind, payload_json, ts) VALUES (?, ?, ?, ?, ?) RETURNING seq",
      peer, id, kind, payloadJson, now,
    ).one().seq;
    const entry = inboxEntry({ seq, peer, id, kind, payload_json: payloadJson, ts: now });
    await this.scheduleAlarm();
    const frame = JSON.stringify({ type: "entry", entry });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(frame); } catch { socket.close(1011, "push failed"); }
    }
    return { result: "queued", seq };
  }

  async pull(after: number): Promise<{ entries: InboxEntry[]; cursor: number }> {
    const entries = this.ctx.storage.sql.exec<EntryRow>(
      "SELECT seq, peer, id, kind, payload_json, ts FROM entries WHERE seq > ? ORDER BY seq LIMIT 200", after,
    ).toArray().map(inboxEntry);
    return { entries, cursor: entries.at(-1)?.seq ?? after };
  }

  async acknowledge(peer: string, id: string, receiptJson: string, now: number): Promise<{ result: "acked" | "cached" | "missing"; receiptJson?: string }> {
    const cached = this.ctx.storage.sql.exec<AckRow>(
      "SELECT peer, id, receipt_json, ts FROM acks WHERE peer = ? AND id = ?", peer, id,
    ).toArray()[0];
    if (cached) return { result: "cached", receiptJson: cached.receipt_json };
    const message = this.ctx.storage.sql.exec<EntryRow>(
      "SELECT seq, peer, id, kind, payload_json, ts FROM entries WHERE peer = ? AND id = ? AND kind = 'message'", peer, id,
    ).toArray()[0];
    if (!message) return { result: "missing" };
    this.ctx.storage.sql.exec("DELETE FROM entries WHERE peer = ? AND id = ? AND kind = 'message'", peer, id);
    this.ctx.storage.sql.exec("INSERT INTO acks(peer, id, receipt_json, ts) VALUES (?, ?, ?, ?)", peer, id, receiptJson, now);
    await this.scheduleAlarm();
    return { result: "acked", receiptJson };
  }

  async deletePeer(peer: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM entries WHERE peer = ?", peer);
    this.ctx.storage.sql.exec("DELETE FROM acks WHERE peer = ?", peer);
    await this.scheduleAlarm();
  }

  async destroy(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, "inbox reset");
    this.ctx.storage.sql.exec("DELETE FROM entries");
    this.ctx.storage.sql.exec("DELETE FROM acks");
    await this.ctx.storage.deleteAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("upgrade required", { status: 426 });
    for (const socket of this.ctx.getWebSockets()) socket.close(1012, "replaced by newer connection");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > LIMITS.wsMessageBytes) {
      socket.close(1009, "message too large");
      return;
    }
    if (typeof message === "string" && message === "ping") socket.send("pong");
  }

  webSocketClose(): void {}

  webSocketError(): void {}

  async alarm(): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - LIMITS.envelopeRetentionSeconds;
    this.ctx.storage.sql.exec("DELETE FROM entries WHERE ts <= ?", cutoff);
    this.ctx.storage.sql.exec("DELETE FROM acks WHERE ts <= ?", cutoff);
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const oldest = this.ctx.storage.sql.exec<{ ts: number }>(
      "SELECT ts FROM (SELECT ts FROM entries UNION ALL SELECT ts FROM acks) ORDER BY ts LIMIT 1",
    ).toArray()[0];
    if (oldest) await this.ctx.storage.setAlarm((oldest.ts + LIMITS.envelopeRetentionSeconds) * 1000);
    else await this.ctx.storage.deleteAlarm();
  }
}

function inboxEntry(row: EntryRow): InboxEntry {
  const payload = JSON.parse(row.payload_json) as unknown;
  return row.kind === "message"
    ? { seq: row.seq, peer: row.peer, id: row.id, kind: "message", envelope: payload, ts: row.ts }
    : { seq: row.seq, peer: row.peer, id: row.id, kind: "receipt", receipt: payload, ts: row.ts };
}
