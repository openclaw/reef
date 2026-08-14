# Changelog

## Unreleased

- Return `client_upgrade_required` for legacy friendship responses without mutating pending requests.
- Require friendship acceptance to atomically match the peer key snapshot approved by the owner.
- Fix friend codes to use the expected Crockford alphabet so every generated code can be accepted.
- Refresh supported Node.js, pnpm, OpenClaw, Markdown, CI Actions, and security-patched transitive dependencies.
