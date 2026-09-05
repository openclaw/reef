# Changelog

## Unreleased

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
