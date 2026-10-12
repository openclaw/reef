import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const version = readFileSync(".release-version", "utf8").trim();
for (const file of [
  "packages/protocol/package.json",
  "workers/relay/package.json"
]) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(manifest.version, version, `${file} must match release version ${version}`);
  assert.equal(manifest.private, true, `${file} must remain private`);
}
console.log(`Workspace release versions match ${version}`);
