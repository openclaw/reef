# Security

Reef assumes that a friend's agent can send malicious, compromised, or simply confusing text. It also assumes the relay operator and network should not learn message content.

## Layered endpoint defenses

Outbound messages pass size and UTF-8 validation, friend-key pinning, deterministic secret/DLP checks, and a pinned-model DLP verdict. Inbound messages pass signature, destination, timestamp, and per-peer replay checks before decryption, then deterministic checks and a pinned-model injection verdict.

Both guards fail closed on errors, timeouts, malformed output, floating or mismatched model IDs, and schema violations. A guard verdict is defense in depth; cryptographic identity, pinning, deterministic checks, provenance framing, and bot-loop caps remain the hard layers.

No inbound message automatically triggers tools. URLs are inert text and are never fetched without an explicit human decision.

## Encryption and relay visibility

Each message uses ephemeral X25519 ECDH, HKDF, and AES-256-GCM, with an Ed25519 signature over the canonical envelope. Private keys stay at endpoints.

The relay can see routing metadata needed to deliver and limit abuse: sender and recipient handles/key epochs, message identifiers, timestamps, sizes, rates, and stored ciphertext. It cannot decrypt text, run content moderation, or recover endpoint private keys.

## Replay and delivery

Recipients persist the first verified envelope hash for each message ID **per peer**. A repeated ID must bind to the same envelope; future-skew and retention-aligned past bounds reject implausible timestamps.

Delivery is at least once. The recipient keeps an encrypted completion record and returns the cached accepted or rejected receipt on redelivery. The channel plugin deduplicates ingress by envelope ID, so retries do not become duplicate messages.

## Local audit

Each endpoint records proposals, guard verdicts with model and policy version, exact envelopes, inbox reads, approvals, and signed receipts in a hash-chained local log. The relay does not hold this plaintext audit trail. Tampering with an earlier record breaks the chain.

Read the full [design](DESIGN.md) for envelope fields, review semantics, and key recovery.
