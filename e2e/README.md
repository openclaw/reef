# Reef M4 end-to-end self-test

Run from the repository root:

```sh
pnpm e2e
```

The harness applies the relay D1 migration into a temporary local state directory, then starts `wrangler dev --local` with `DEV_MODE=1` on a free loopback port. This is the real Worker, D1 database, per-handle Durable Object, and WebSocket path. No OpenClaw gateway or guard-model network call is used.

The single test prints one `PASS` line for each proof step:

1. Local relay startup.
2. Dev magic-link registration, handle claims, and real Ed25519/X25519 key binding.
3. Code-only self-friending and mutual key/epoch pinning.
4. The receiving handle's single WebSocket connection.
5. Allowed plugin compose/send/receive flow, untrusted-provenance ingress, signed ack, and sender receipt confirmation.
6. Offline store-and-forward followed by reconnect polling and receipt confirmation.
7. Mocked outbound deny, pending review, inbound deny, and cached rejection idempotency.
8. Relay and plugin replay suppression for an already-delivered envelope ID.
9. Three-message injection/exfiltration smoke corpus through the inbound compose path, using real deterministic checks and a scripted guard verdict.

Temporary relay and plugin state is removed after the run. The harness never prints returned magic-link tokens.
