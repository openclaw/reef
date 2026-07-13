# Guards

Reef runs a guard at both endpoints: outbound DLP before encryption and inbound injection screening after decryption. Anthropic and OpenAI adapters ship with the protocol package.

## Required adapter behavior

A valid guard configuration has:

- an immutable, dated model snapshot; floating aliases are rejected
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

The repository's red-team corpus covers injection, exfiltration, and benign-but-unusual messages. Provider/snapshot pairs that pass form the published blessed list. Owners may choose another immutable snapshot, but `doctor` warns when it is unblessed. Snapshot changes are release decisions gated by the corpus, not silent config drift.

See the [guard source](https://github.com/openclaw/reef/tree/main/packages/protocol/src) and [design](DESIGN.md#guard-pipeline-both-directions-both-endpoints).
