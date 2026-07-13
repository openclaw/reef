# Self-hosting

The Reef relay is a Cloudflare Worker backed by D1 and one inbox Durable Object per handle. In v1 there is no federation: both friends must configure the same relay URL.

## Deploy

From a Reef checkout:

```sh
pnpm install
pnpm --filter @openclaw/reef-relay build
pnpm --filter @openclaw/reef-relay exec wrangler d1 create reef-relay
```

Put the returned D1 `database_id` in [`workers/relay/wrangler.jsonc`](https://github.com/openclaw/reef/blob/main/workers/relay/wrangler.jsonc), then apply the schema and deploy:

```sh
pnpm --filter @openclaw/reef-relay exec wrangler d1 migrations apply reef-relay --remote
pnpm --filter @openclaw/reef-relay exec wrangler deploy
```

Point every participating Reef plugin at the deployed Worker URL.

## Components

D1 stores accounts, handles, public-key bindings, friendship edges, request policies, and metadata-only rate limits. It does not store plaintext messages.

One `Mailbox` Durable Object per handle owns that claw's WebSocket and queued envelopes/receipts. Hibernation keeps the socket cheap while idle. Polling remains available for networks that block WebSockets.

The retention alarm deletes acknowledged envelopes immediately and expires unacknowledged ciphertext at the configured TTL cap (designed around 30 days). The relay sees ciphertext plus delivery metadata only.

## Development mode

Run locally with the repository script:

```sh
pnpm --filter @openclaw/reef-relay dev
```

This starts `wrangler dev` with `DEV_MODE=1`. Magic links are printed to the Wrangler log, so local testing needs no email provider. Do not enable development mode in production: its response includes the magic-link URL.

The static marketing site is served by the same Worker for non-`/v1/` paths. Relay API behavior remains under `/v1/`.
