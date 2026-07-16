import { createPool, requiredDatabaseUrl } from "./database.js";
import { PostgresMailboxes } from "./postgres-mailboxes.js";

const pool = createPool(requiredDatabaseUrl());
try {
  await new PostgresMailboxes(pool, () => undefined).cleanup();
} finally {
  await pool.end();
}
