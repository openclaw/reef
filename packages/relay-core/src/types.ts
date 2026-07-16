export type RequestPolicy = "code-only" | "friends-of-friends" | "open";
export type FriendshipStatus = "pending" | "active" | "blocked" | "reapprove_required";
export type InboxEntryKind = "message" | "receipt";

export interface HandleRow {
  handle: string;
  account_id: string;
  ed25519_pub: string;
  x25519_pub: string;
  key_epoch: number;
  request_policy: RequestPolicy;
  created: number;
}

export interface FriendshipRow {
  a_handle: string;
  b_handle: string;
  status: FriendshipStatus;
  initiated_by: string;
  vouch_handle: string | null;
  reapprove_handle: string | null;
  created: number;
}

export interface FriendView {
  status: FriendshipStatus;
  initiated_by: string;
  vouch_handle: string | null;
  handle: string;
  ed25519_pub: string;
  x25519_pub: string;
  key_epoch: number;
}

export interface DeviceIdentity {
  handle: string;
  row: HandleRow;
}

interface InboxEntryBase {
  seq: number;
  peer: string;
  id: string;
  ts: number;
}

export type InboxEntry =
  | (InboxEntryBase & { kind: "message"; envelope: unknown })
  | (InboxEntryBase & { kind: "receipt"; receipt: unknown });

export type EnqueueResult = { result: "queued"; seq: number } | { result: "duplicate" | "capacity" };
export type AcknowledgeResult = { result: "acked" | "cached" | "missing"; receiptJson?: string };
