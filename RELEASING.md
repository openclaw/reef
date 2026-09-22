# Releasing Reef

Reef ships source releases on GitHub. Both workspace packages are private; there
is no npm publication or release-artifact workflow. The relay deploys from `main`
through `.github/workflows/deploy-relay.yml`.

1. Choose a patch version for fixes or a minor version for user-facing features or
   compatibility changes. Update the matching versions in
   `packages/protocol/package.json` and `workers/relay/package.json`.
2. Finalize `CHANGELOG.md` under `## X.Y.Z - YYYY-MM-DD`, with a one-line
   `**Highlights:**` lead-in. Keep an empty `## Unreleased` section above it.
3. Run `pnpm install --frozen-lockfile`, `pnpm -r build`, and `pnpm -r test`.
   Open a release PR and merge it only after its exact-head CI succeeds on all
   supported Node lines.
4. From the merged, clean `main`, create and push `vX.Y.Z`. Publish a GitHub Release
   titled `reef X.Y.Z`, using the exact changelog section as the notes file:

   ```sh
   gh release create vX.Y.Z --verify-tag --title 'reef X.Y.Z' --notes-file /path/to/release-notes.md
   ```

5. Read back the published release and tag, confirm the release is not a draft or
   prerelease, and compare its body to the changelog section. Verify the merged
   commit's CI and relay deployment. Leave `main` clean and up to date.
