# Changelog

## Unreleased

- Reopen large audit logs without overflowing the JavaScript function argument limit, preserving all history and subsequent appends.
- Make concurrent sign-in starts share one account and reject missing production email configuration without logging sign-in tokens.
- Snapshot protocol messages across asynchronous checks so caller mutations cannot replace guarded plaintext, verified ciphertext, recipients, or replay identifiers.
- Add receiver-owned directional friendship permissions with signed updates, bidirectional migration defaults, and preserved queued delivery and receipts; thanks @jason-allen-oneal (#12).

## 0.1.1 - 2026-09-13

**Highlights:** Audit and replay JSONL history survives reopen, malformed relay requests get HTTP 400, and the sharp/libheif advisories are patched.

- Preserve valid unterminated audit and replay JSONL records on reopen so subsequent writes cannot erase history or reopen consumed replay claims.
- Reject malformed relay path escapes and null signed rotations with HTTP 400 instead of internal server errors.
- Patch the Workers test pool’s transitive sharp/libheif vulnerabilities with sharp 0.35.4.
- Make opt-in live guard smoke tests fail on missing configuration and unsuccessful provider verdicts.
- Generate unique documentation heading anchors when literal titles collide with automatically numbered duplicates.
- Refresh locked test tooling to Vite 8.3.0 and Rolldown 1.2.8, with current compatible transitive dependencies.
- Refresh Wrangler to 4.131.1, Worker types to 5.20260911.1, Node types to 26.5.1, marked to 18.0.12, and pnpm to 12.4.1; test supported Node lines in CI and deploy with the lockfile-pinned Wrangler while retaining Vitest 4 compatibility.

## 0.1.0 - 2026-09-05

**Highlights:** Reef's first release brings end-to-end-encrypted messaging between paired OpenClaw instances, a self-hostable Cloudflare relay, and protocol primitives for guarded, auditable conversations.

- Deliver signed, encrypted text through per-handle mailboxes with WebSocket push, polling, offline queues, replay protection, and signed delivery receipts.
- Register unlisted handles through email magic links and pair peers with friend codes, mutual-friend requests, or open requests; support signed key rotation and explicit reapproval after device recovery.
- Provide fail-closed Anthropic and OpenAI guard adapters for DLP and injection screening, deterministic secret checks, owner-review primitives, and hash-chained local audit logs with signed checkpoints.
- Integrate with OpenClaw's bundled Reef channel for setup, pairing, messaging, and bounded replies; maintain the protocol and relay here, with the client in `openclaw/openclaw`.
- Require friendship acceptance to atomically match the peer key snapshot approved by the owner.
- Return `client_upgrade_required` for legacy friendship responses without mutating pending requests.
- Bound canonicalization and reject empty or null mail envelopes with HTTP 400 instead of 500; thanks @SebTardif (#11).
- Fix friend codes to use the expected Crockford alphabet so every generated code can be accepted.
- Add the reefwire.ai signup and welcome pages, generated setup and security documentation, social previews, and an animated site with reliable scroll reveals.
- Support relay deployment from `main` and documented self-hosting with D1 migrations, Durable Objects, and local development without an email provider.
- Refresh supported Node.js and pnpm versions, cryptography, Markdown rendering, Cloudflare tooling and Worker types, CI Actions, and security-patched transitive dependencies while retaining Vitest 4 compatibility.
