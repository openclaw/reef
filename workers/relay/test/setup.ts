import { applyD1Migrations, env } from "cloudflare:test";

const [initialMigration, ...upgradeMigrations] = env.TEST_MIGRATIONS;
if (!initialMigration || upgradeMigrations.length === 0) {
  throw new Error("relay migration regression requires both initial and upgrade migrations");
}

await applyD1Migrations(env.DB, [initialMigration]);
await env.DB.prepare(`INSERT INTO friendships
  (a_handle, b_handle, status, initiated_by, vouch_handle, reapprove_handle, created)
  VALUES (?, ?, 'active', ?, NULL, NULL, ?)`)
  .bind("migration-alpha", "migration-zulu", "migration-alpha", 1)
  .run();

await applyD1Migrations(env.DB, upgradeMigrations);
