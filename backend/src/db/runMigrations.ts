/**
 * Migration CLI:  npm run migrate
 *
 * Run as a deploy step, not from a request handler. Serverless instances cold
 * start concurrently, and several of them racing DDL is how you get a half
 * migrated database. One deliberate run keeps that impossible.
 */
import { loadEnv } from "../config/env.js";
import { createPgClient } from "./pgClient.js";
import { migrate } from "./migrate.js";

const env = loadEnv();
if (!env.DATABASE_URL) {
  const optional = process.argv.includes("--if-configured");
  const message = "DATABASE_URL is not set. Nothing to migrate.";
  if (optional) {
    console.log(message);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const db = createPgClient({ connectionString: env.DATABASE_URL });
try {
  const result = await migrate(db, { allowDestructive: process.argv.includes("--allow-destructive") });
  console.log(
    JSON.stringify({
      msg: "migrations complete",
      applied: result.applied,
      alreadyApplied: result.skipped.length,
    }),
  );
} catch (err) {
  console.error(JSON.stringify({ msg: "migration failed", error: (err as Error).message }));
  process.exitCode = 1;
} finally {
  await db.close();
}
