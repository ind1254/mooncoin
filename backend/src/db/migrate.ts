import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./client.js";

/**
 * Forward-only migration runner.
 *
 * Every migration is a numbered .sql file applied exactly once, in order, and
 * recorded in schema_migrations. Production tables are never created by hand,
 * so the schema in git is the schema that is deployed.
 *
 * Each file runs inside a transaction: a migration that fails halfway leaves
 * the database untouched rather than partially altered.
 *
 * Deliberately forward-only, with no `down`. Rollback scripts are rarely
 * exercised and are usually wrong when finally needed; a mistake is corrected
 * by writing a new migration. Destructive statements (DROP/TRUNCATE) are
 * rejected here so an accidental data-losing migration cannot ship silently.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const DESTRUCTIVE = /\b(drop\s+(table|column|database|schema)|truncate)\b/i;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // zero-padded numeric prefixes make lexical order correct
}

export async function migrate(db: SqlClient, options: { allowDestructive?: boolean } = {}): Promise<MigrationResult> {
  await db.exec(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const done = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of listMigrationFiles()) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (!options.allowDestructive && DESTRUCTIVE.test(stripComments(sql))) {
      throw new Error(
        `Migration ${file} contains a destructive statement. Review it and re-run with allowDestructive if intended.`,
      );
    }
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    applied.push(file);
  }

  return { applied, skipped };
}

/** Comments must not trigger the destructive-statement guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
