import { createPool, requiredDatabaseUrl } from "./database.js";
import { applyMigrations } from "./migrations.js";

const pool = createPool(requiredDatabaseUrl());
try {
  await applyMigrations(pool);
} finally {
  await pool.end();
}
