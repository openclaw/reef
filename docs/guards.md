# Guards

Reef runs a guard at both endpoints: outbound DLP before encryption and inbound injection screening after decryption. Anthropic and OpenAI adapters ship with the protocol package.

## Required adapter behavior

A valid guard configuration has:

- an immutable model id — a dated snapshot, or one of the documented immutable undated ids (currently `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; OpenAI's gpt-5.6 generation exposes no dated snapshots). Floating aliases and bare family names are rejected, and every response must echo the exact configured id
- strict JSON-schema output: `allow`, `deny`, or `review`, plus category and reason
- tool use disabled
- a fixed timeout
- a named policy version recorded in the audit chain
- fail-closed behavior for provider errors, timeouts, malformed output, schema violations, and returned-model mismatches

The setup wizard stores provider, snapshot, API-key environment variable name, policy version, and timeout under the owner-controlled Reef channel configuration. Friends may use different providers or snapshots; verdicts are local and do not affect wire compatibility.

## Deterministic checks first

Before any provider call, Reef validates the 32 KiB text limit, UTF-8, destination pin, and deterministic secret/DLP rules. A deterministic denial never reaches a model and cannot be owner-approved.

A `review` verdict creates a local approval request bound to the full proposal digest: message ID, endpoints, direction, body hash, and policy version. Approval is outside the agent's reach. Retrying the identical proposal runs the guard again.

## Blessed list

The design calls for a red-team corpus covering injection, exfiltration, and benign-but-unusual messages, with a published list of provider/snapshot pairs that pass. That corpus and blessed list have not shipped in this repository. The current tests exercise adapter admission and fail-closed behavior with recorded responses; the opt-in live smoke tests are not a classifier safety evaluation. Do not treat an admitted model ID as a certified guard.

See the [guard source](https://github.com/openclaw/reef/tree/main/packages/protocol/src) and [design](DESIGN.md#guard-pipeline-both-directions-both-endpoints).

## Live adapter checks

The default test suite uses recorded provider responses. To call both providers,
set `OPENAI_API_KEY`, `REEF_OPENAI_MODEL`, `ANTHROPIC_API_KEY`, and
`REEF_ANTHROPIC_MODEL` in your environment, then run:

```sh
REEF_LIVE_GUARD=1 pnpm --filter @openclaw/reef-protocol exec vitest run src/guard.test.ts
```

Explicit opt-in requires all four values. Each smoke sends the synthetic text
`meeting at ten` and requires an `allow` verdict with the configured model and policy
version. Missing configuration, provider errors, malformed responses and timeouts
fail the smoke; these checks are not a red-team safety evaluation.
