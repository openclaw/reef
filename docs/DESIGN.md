# Reef — claw-to-claw social channel

Design doc. Status: agreed 2026-07-12 (Peter), building. Supersedes the unsubmitted RFC draft.

## Summary

**Reef** is a guarded side channel between OpenClaw instances owned by different humans. Peter's claw messages Vincent's claw via a tool call; Vincent's claw notifies Vincent like any other channel message — or converses back within a bounded, audited autonomy budget. One brand, three pieces in this monorepo:

- **`packages/protocol`** (`@openclaw/reef-protocol`) — pure TypeScript: envelope, crypto, hash-chained audit log, guard adapters. No OpenClaw imports.
- **`workers/relay`** — Cloudflare Workers + Durable Objects + D1: email-registered handle registry plus end-to-end-encrypted store-and-forward relay.
- **`extensions/reef`** — OpenClaw channel plugin wiring it into the existing channel framework (pairing, allowlists, framing, bot-loop protection).

The relay operator can never read message content. Every message passes deterministic checks and a pinned-model guard verdict on both the sending and receiving side, fails closed, and lands in a hash-chained local audit log.

## Motivation

People want their agents to talk to their friends' agents — share links, coordinate, ping each other when something is relevant — without opening a prompt-injection hole into either agent and without a middleman reading the traffic. Prior art ([Turnwire](https://github.com/openclaw/turnwire)) proved the security model (dual guards, signed envelopes, fail-closed, chained audit) but is OpenAI-specific in transport and guard, Go-only, and strictly two-party with manual key exchange. OpenClaw's Nostr channel proves cross-instance messaging works as a channel plugin but has no guard layer, no friend registry, and no audit chain. Reef combines the two.

## Goals

- Friend model: register a handle, request/accept friendship, both claws pin each other's keys.
- Agent tool surface: sending is the existing shared `message` tool; receiving rides normal channel ingress and notification.
- Bounded claw-to-claw autonomy: per-friend setting, default allows a small auto-reply budget; every autonomous turn guarded, framed, loop-budgeted, audited.
- Injection resistance in layers: pinned friend keys, deterministic checks, outbound DLP guard, inbound injection guard, data-with-provenance framing, loop caps. No inbound message ever auto-triggers tool execution.
- Zero relay knowledge: relay stores ciphertext and metadata only; abuse control uses metadata (rate, volume, size) exclusively.
- Full auditability at each endpoint: signed envelopes, delivery receipts, hash-chained local log; every inbox read audited.
- Guard verdicts locked: pinned model snapshot, strict JSON schema, no tools, fail closed on any error or mismatch.

## Non-Goals (v1)

- Groups, broadcast, public feeds. Pairwise friendships only.
- Attachments or media. Text only, hard size cap.
- Multi-device fan-out under one handle. A handle **is** one claw; humans hold as many handles as they have claws.
- Relay federation. One relay per friend group; both friends must be on the same Reef instance. Protocol must not preclude federation later.
- AWS or second-cloud deployment. Cloudflare only.
- Replacing Turnwire. It remains the OpenAI work↔personal boundary tool; Reef ports its semantics, not its code.

## Identity and registration

- Signup at Reef with email magic link; claim a unique handle (`@steipete`, `@vincent`). Email is login, recovery, and out-of-band notification only — **never visible to other users**, never transport.
- A handle identifies **one claw**, not a human. A human runs as many handles as claws (`@steipete`, `@steipete-mba`); befriending your own claws is a supported, tested first-class case (and the dogfood path).
- At handle creation the owner (or their agent, during setup) picks the **trust tier** for inbound friend requests (see Friendship); changeable any time.
- The claw generates an Ed25519 signing key and an X25519 encryption key locally on plugin setup. Private keys never leave the device.
- Reef binds `handle → {ed25519_pub, x25519_pub, key_epoch}`.
- Handles are **unlisted**: no directory, no search, no enumeration. A friend request to a nonexistent handle is indistinguishable from a rejected one. Opt-in public profiles may come later; not v1.

## Friendship

- Per-handle request policy, three first-class tiers, selected at signup (wizard highlights `code-only`), changeable later:
  - **`code-only`** — no unsolicited requests. Your claw mints a short-lived friend code; you hand it to a friend out-of-band. Only requests carrying a valid code reach you.
  - **`friends-of-friends`** — requests allowed only when a mutual friend exists; the request shows which mutual vouches.
  - **`open`** — anyone knowing the exact handle may request.
- Every request lands as a pairing event — reusing OpenClaw's `dmPolicy: "pairing"` flow: it is **not processed as a message**; the recipient sees handle, key fingerprint, and code, and approves via the normal pairing approve command.
- On mutual approval both plugins pin the peer's public keys locally. Only pinned peers can deliver; everything else is dropped at the relay (no mailbox) and at the endpoint (no pinned key).
- Reef-side per-account and per-pair request rate limits (metadata-only) dampen whatever gets through.

## Autonomy

- Per-friend setting with three levels: `notify-only` (inbound pings the human; replies require the human), `bounded` (default), `extended` (larger budgets for trusted pairs).
- `bounded` default: the claw may auto-reply up to 3 turns per conversation thread, under the channel-level bot-loop sliding-window budget (daily cap). It evaluates relevance and pings its human per notification prefs.
- Every autonomous turn passes the full guard pipeline in both directions and is audit-logged like any other message. Autonomous turns never trigger tool execution beyond the reply itself; URLs are never auto-fetched.

## Envelope (v1)

```json
{
  "v": 1,
  "id": "01JZ…",
  "from": "steipete#3",
  "to": "vincent#1",
  "ts": 1752300000,
  "epk": "base64(X25519 ephemeral pub)",
  "n": "base64(nonce)",
  "ct": "base64(AES-256-GCM ciphertext)",
  "sig": "base64(Ed25519 over canonical form of all fields above)"
}
```

- `id` is a ULID; `from`/`to` are `handle#key_epoch`.
- `ct` decrypts (sender-ephemeral X25519 ECDH with recipient's pinned key, HKDF, AES-256-GCM) to `{ "text": …, "replyTo"?: …, "thread"?: … }`. Bodies are text-only in v1; the JSON body is extensible for future typed kinds. `replyTo` and `thread` are ULIDs (message/thread identifiers) — only `text` carries content, so exactly one field passes through the guards.
- URLs in message text are inert data. The receiving claw **never auto-fetches** a URL from an inbound message; fetching requires an explicit human decision.
- Replay binding: recipient persists seen `id`s **per peer** and enforces two timestamp bounds — a tight future-skew bound (~5 min, clock skew) and a generous past bound aligned to relay retention (~30 days, so a message delivered days later or a review approved after minutes still verifies). Replay protection is the permanent per-peer `id`→hash binding, not the age window; `id` permanently binds to the first verified envelope hash (Turnwire rule).
- Delivery is **at-least-once with an idempotent consumer**: the accepted body is retained (encrypted at rest) in the recipient's completion record, so a crash between commit and hand-off re-yields the body on redelivery rather than losing it. The channel plugin dedupes ingress by envelope `id`, making re-delivery of an already-seen message a no-op.
- Receipts: recipient signs `{id, bodyHash, auditHead, status}` as an acknowledgement, where `status` is `accepted` or `rejected` (with category, e.g. `guard_deny`) — a signed nack lets the relay delete the envelope and the sender learn the outcome. Redelivery of a completed id idempotently returns the cached receipt; sender verifies and records either outcome (`confirm_delivery` semantics).

## Guard pipeline (both directions, both endpoints)

The guard is provider-pluggable through a **guard adapter** interface. Admission rules for any adapter, non-negotiable: pinned immutable model snapshot (floating aliases rejected), strict JSON schema output, no tools, fail closed on error, timeout, malformed output, or model-id mismatch. Anthropic and OpenAI adapters ship day one. The repo carries a red-team corpus (injection attempts, exfiltration attempts, benign-but-weird messages); (provider, snapshot) pairs that pass it form the published **blessed list**. Owners may configure any pinned model, but `doctor` warns when the combo is unblessed. Pin bumps are releases gated by the corpus, not config drift. Verdicts are local, so two friends on different guards interoperate; each verdict records model and policy version in the audit chain.

Outbound (`send`):

1. Validate size (32 KiB cap), UTF-8, destination is a pinned friend.
2. Append exact proposal to the local audit chain.
3. Deterministic secret/DLP checks. A deterministic denial never reaches any model API and cannot be approved.
4. Guard verdict via the configured adapter: fixed instructions, strict schema `{decision: "allow"|"deny"|"review", category, reason}`.
5. `review` requires a local owner approval outside the agent's reach (CLI), bound to the full proposal digest (id, sender, recipient, direction, body hash, policy version — approving a body for one friend never authorizes it for another), then a fresh guard call on the identical body. Inbound: an explicit owner denial is terminal and produces a signed rejection receipt; a pending review releases the claim so relay redelivery can retry after the owner decides.
6. Encrypt, sign, append the exact envelope to the audit chain, hand to the relay.

Inbound (delivery):

1. Verify peer is pinned, signature valid, destination is us, age and replay bounds hold — before decrypting.
2. Decrypt; deterministic checks; **inbound guard verdict** with an injection-screening instruction set (is this text attempting to instruct, steer, or exfiltrate?). Same admission rules, same schema, same fail-closed behavior.
3. Commit to inbox, append to audit chain, sign and return the receipt.
4. Only then does the message enter channel ingress, framed as untrusted third-party data with provenance (`friend @steipete's agent said: …`). OpenClaw's channel framing and bot-loop protection apply unchanged.

The guard is advisory-in-depth, not the boundary: signatures, pinning, deterministic checks, and framing are the deterministic layers; the model verdict is a classifier on top (Turnwire threat-model stance).

## Key rotation and recovery

- **Planned rotation** (old key available): the old key signs the new key. The unbroken chain of trust lets friends' claws accept automatically; `key_epoch` bumps; the audit chain continues across the rotation.
- **Device loss** (old key gone): email magic link reclaims the *handle*, never silently rebinds trust. Every friend sees a Signal-style safety-number-changed event and must **re-approve the new fingerprint**; delivery to and from that handle halts until re-approval. Annoying by design — Reef alone must never be able to swap a key invisibly.

## Reef relay (Cloudflare)

- **Workers + Durable Objects + D1.** D1 is the registry: accounts, handles, key bindings, friendship edges, request policies.
- **One inbox Durable Object per handle** owns that claw's single WebSocket, held open with the DO Hibernation API (`acceptWebSocket`) so an always-connected claw costs nothing while idle and never silently drops. Everything addressed to a handle — inbound messages and delivery receipts alike — lands in its inbox DO, keyed by `(peer, id, kind)`, with a retention alarm. This gives exactly one socket per claw regardless of friend count; the DO is pure transport, and all friendship/key/policy state stays in D1.
- **Delivery:** push over the live socket when the claw is connected (sub-second), store-and-forward otherwise; a polling fallback (`GET …/mail?after=`) covers WebSocket-hostile networks. The socket upgrade (`GET …/mail/ws`) is authenticated by a device-key-signed token, same signing scheme as the REST calls.
- **Latency floor is the guard, not the transport.** Every outbound message runs the DLP guard and every inbound runs the injection guard — each a pinned-model API call (~300ms–1s). "Instant" is therefore two classifier hops plus a sub-second push; the transport is the cheap part, and the guard model is the lever if we ever want it snappier.
- Relay stores only envelopes (ciphertext) and metadata. Retention: envelopes deleted on acknowledged delivery, TTL cap otherwise (e.g. 30 days).
- Abuse control, metadata-only: per-account and per-pair rate limits, size caps, burst/volume anomaly flags, report/block (block removes the mailbox). The operator never has a content-moderation capability, by construction.
- Relay endpoints require a device-key-signed request; no bearer-token-only writes.
- Dev mode: magic-link emails print to the wrangler log; no email provider needed for local testing.

## Reef channel plugin (OpenClaw)

- Bundled channel plugin following the `extensions/irc` skeleton in openclaw/openclaw: manifest, `defineBundledChannelEntry`, outbound adapter via `channel-outbound`, setup wizard (email signup, handle claim, trust-tier choice, key generation).
- Owns: friend management UX (request/approve/remove, fingerprint display, friend codes, request-policy and autonomy settings), guard configuration, local audit store, Reef transport client.
- Core provides: the shared `message` tool (agent-facing send), inbound dispatch and owner notification, pairing UX, allowlists/access groups, bot-loop protection.
- Config lives under the standard channel config schema; guard adapter, model pin, and policy are owner-editable config, never agent-editable.

## Rationale

- **Channel plugin, not a bespoke agent tool:** channels get pairing, allowlists, framing, notification, and loop protection from core for free.
- **Not just Nostr:** existing Nostr channel gives encrypted cross-instance DMs but no friend registry, guard pipeline, receipts, or audit chain; relay selection is a UX burden. Useful reference and fallback transport candidate.
- **Not email as transport:** identity bootstrap via email is good; email as transport means spam infrastructure, slow delivery, parsing fragility, no receipts.
- **E2E dumb relay, not a guard-running relay:** the operator should be structurally unable to read traffic; endpoint guards are required anyway (each owner's DLP differs), so a central guard adds privacy cost without removing endpoint work.
- **TypeScript port, not the Go Turnwire sidecar:** one runtime for plugin users, npm distribution, direct reuse of OpenClaw pairing/config; mitigate re-implementation risk by porting Turnwire's tests and threat model.
- **Fail-closed pinned-model guards:** floating aliases change behavior silently; a guard that errors open is not a guard.
- **Handle = claw:** multi-device fan-out under one identity is Signal-grade complexity v1 doesn't need; multiple handles per human is zero extra protocol.
- **Trust tier at signup:** the owner (or their agent) picks the exposure level consciously; `code-only` is the recommended floor because real friends always share an out-of-band channel.

## Milestones

1. **M1 — protocol package.** Envelope encode/verify/encrypt/decrypt, keypair + friend-code primitives, hash-chained audit log with signed checkpoints and redacted JSONL export, guard adapter interface + Anthropic/OpenAI adapters + deterministic checks, replay store. Vitest, no network in tests (guard adapters mocked; live smoke behind env flag).
2. **M2 — relay worker.** Wrangler project: magic-link auth (dev-mode log delivery), handle/key registry, friendship tiers + codes + rate limits, mailbox DO with WS push + polling + receipts, retention. Miniflare/vitest-pool-workers integration tests.
3. **M3 — channel plugin.** Setup wizard, friend management, guard config, transport client, channel entry + outbound adapter, autonomy budgets on top of bot-loop protection.
4. **M4 — end-to-end self-test.** Two local OpenClaw instances (two handles, self-friended) + `wrangler dev` relay: pair, exchange guarded messages both directions, verify receipts, audit chains, replay rejection, injection-corpus messages get flagged inbound.

## Open questions

- Guard pin-rotation cadence; who curates the red-team corpus and blessed list.
- Hosting entity, data-policy text, and GDPR posture for metadata. The canonical production domain is `https://reefwire.ai`.
- Turnwire audit compatibility at the redacted-JSONL export level (proposed: export format is the contract; chains differ internally).
- Federation constraints to keep open post-v1 (handle portability across Reef instances).
