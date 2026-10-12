# Releasing Reef

Reef ships source releases on GitHub through
[`release-source.yml@v1`](https://github.com/openclaw/release-workflows/blob/v1/.github/workflows/release-source.yml).
Both workspace packages remain private. There is no npm publication, native
binary, Homebrew formula, or Sparkle appcast. The workflow attaches frozen-commit
source tar/zip archives, notes, an inventory, and checksums.

The relay's existing `.github/workflows/deploy-relay.yml` continues to deploy
pushes to `main`. Release and dry-run workflows do not invoke that deployment,
apply D1 migrations, or use its Cloudflare credential.

## Prepare

Choose a patch version for fixes or a minor version for features and
compatibility changes. Set `.release-version`,
`packages/protocol/package.json`, and `workers/relay/package.json` to the same
version. Finalize exactly one `## X.Y.Z - YYYY-MM-DD` changelog section with a
short `**Highlights:**` lead-in and an empty `## Unreleased` above it.

Run the release's credential-free checks with the pinned pnpm 12.11.2:

```sh
node scripts/verify-release.mjs
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
```

Review and merge the preparation PR after CI passes on all supported Node
versions. The release reruns the builds and protocol/relay tests without
Cloudflare deployment access.

## Publish through Actions

After the preparation PR and push CI pass on the exact merged commit, create a
signed annotated `vX.Y.Z` tag using the release SSH key authorized by
`.github/release-allowed-signers`, verify it, and push only that tag. Never move
an existing tag or reuse a published version. The tag starts `Release`; do not
publish locally or create a GitHub Release by hand.

The shared workflow freezes the commit, checks protected-main ancestry, the SSH
signature, version metadata, dated changelog notes, and green independent push
CI. It then runs the checks below and binds the payload to two independent
verifiers before publication. A live dispatch also requires an existing signed
tag; it cannot silently substitute an unsigned tag.

## No-publish rehearsal

Dispatch `Release` on the current protected `main` with the version matching its
metadata and a dated changelog section. `dry_run` defaults to `true`:

```sh
gh workflow run release.yml --repo openclaw/reef --ref main -f version=0.2.0 -F dry_run=true
```

This checks current main even when that version has an older tag. It neither
creates nor changes tags, GitHub Releases, registry versions, or deployments.
Only the release pipeline's checks run; ordinary push workflows remain separate.

## Verify and close out

Confirm the Actions run succeeded and the GitHub Release has the expected
signed tag, frozen commit, exact dated changelog section, inventory, and
`SHA256SUMS`. Download the attached payload and verify its checksums. Never
replace an existing release's assets to fix a failed attempt.

Keep the released changelog section intact. Open an empty `## Unreleased`
section if one is absent, review and merge the follow-up, and leave `main` clean
and current. No release is complete while its independent CI or publication
verification is failing.
