import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

export async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('reef-relay-migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS reef_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const applied = new Set((await client.query<{ name: string }>("SELECT name FROM reef_migrations")).rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIRECTORY)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of files) {
      if (applied.has(name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
        await client.query("INSERT INTO reef_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('reef-relay-migrations'))").catch(() => undefined);
    client.release();
  }
}
