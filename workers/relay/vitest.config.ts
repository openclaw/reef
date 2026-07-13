import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { DEV_MODE: "1", TEST_MIGRATIONS: migrations } },
  })],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
