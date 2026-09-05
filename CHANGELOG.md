# Changelog

## Unreleased

- Refresh cryptography, relay tooling, Markdown rendering, CI, and patched PostCSS/Nano ID test dependencies while retaining the supported Node.js versions and Vitest 4 compatibility.
- Add receiver-owned directional friendship permissions while preserving bidirectional defaults and already-accepted delivery receipts.
- Bound canonicalization and reject empty or null mail envelopes with HTTP 400 instead of 500. Thanks @SebTardif (#11).
- Return `client_upgrade_required` for legacy friendship responses without mutating pending requests.
- Require friendship acceptance to atomically match the peer key snapshot approved by the owner.
- Fix friend codes to use the expected Crockford alphabet so every generated code can be accepted.
- Refresh supported Node.js, pnpm, OpenClaw, Markdown, CI Actions, and security-patched transitive dependencies.
