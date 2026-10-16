import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { DEV_MODE: "1", TEST_MIGRATIONS: migrations } },
  })],
  test: {
    // Workerd cannot read Vitest's host-side transformed-module cache.
    fsModuleCache: false,
    setupFiles: ["./test/setup.ts"],
    testTimeout: 10_000,
  },
});
