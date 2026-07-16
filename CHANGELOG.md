# Changelog

## Unreleased

- Add a shared relay core and a PostgreSQL-backed Node relay with a generic Kubernetes Helm chart while preserving Cloudflare support.
- Require friendship acceptance to atomically match the peer key snapshot approved by the owner.
- Fix friend codes to use the expected Crockford alphabet so every generated code can be accepted.
- Refresh supported Node.js, pnpm, OpenClaw, Markdown, CI Actions, and security-patched transitive dependencies.
