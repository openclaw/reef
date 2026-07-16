CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE handles (
  handle TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ed25519_pub TEXT NOT NULL,
  x25519_pub TEXT NOT NULL,
  key_epoch INTEGER NOT NULL,
  request_policy TEXT NOT NULL CHECK (request_policy IN ('code-only', 'friends-of-friends', 'open')),
  created INTEGER NOT NULL
);

CREATE TABLE friendships (
  a_handle TEXT NOT NULL,
  b_handle TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'blocked', 'reapprove_required')),
  initiated_by TEXT NOT NULL,
  vouch_handle TEXT,
  reapprove_handle TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (a_handle, b_handle),
  CHECK (a_handle < b_handle)
);

CREATE TABLE friend_codes (
  handle TEXT NOT NULL REFERENCES handles(handle) ON DELETE CASCADE,
  code_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  rate_window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, rate_window)
);

CREATE TABLE request_replays (
  replay_key TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter TEXT NOT NULL,
  peer TEXT NOT NULL,
  reason_category TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE SEQUENCE mailbox_entry_seq;

CREATE TABLE mailbox_entries (
  handle TEXT NOT NULL,
  seq BIGINT NOT NULL DEFAULT nextval('mailbox_entry_seq'),
  peer TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'receipt')),
  payload_json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (handle, seq),
  UNIQUE (handle, peer, id, kind)
);

CREATE TABLE mailbox_acks (
  handle TEXT NOT NULL,
  peer TEXT NOT NULL,
  id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (handle, peer, id)
);

CREATE TABLE mailbox_connections (
  handle TEXT PRIMARY KEY,
  generation BIGINT NOT NULL
);

CREATE INDEX friendships_b_idx ON friendships(b_handle, status);
CREATE INDEX auth_tokens_expiry_idx ON auth_tokens(expires);
CREATE INDEX sessions_expiry_idx ON sessions(expires);
CREATE INDEX request_replays_expiry_idx ON request_replays(expires);
CREATE INDEX mailbox_entries_expiry_idx ON mailbox_entries(ts);
CREATE INDEX mailbox_acks_expiry_idx ON mailbox_acks(ts);
