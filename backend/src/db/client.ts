/**
 * Database access boundary.
 *
 * The application depends on `SqlClient`, never on `pg` or PGlite directly.
 * That is what lets production run against hosted Postgres while CI runs the
 * identical SQL and the identical migrations in-process, deterministically.
 *
 * BIGINT PARSING: both drivers decode Postgres BIGINT (OID 20) into a
 * JavaScript number by default, which silently corrupts anything above 2^53 —
 * 9007199254740993 comes back as ...992. Every implementation below overrides
 * that so BIGINT arrives as a string and is converted with BigInt().
 */

export interface SqlRow {
  [column: string]: unknown;
}

export interface SqlClient {
  query<T extends SqlRow = SqlRow>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Run a multi-statement script with no parameters. Parameterized queries use
   * the extended protocol, which accepts exactly one statement, so migration
   * files need this path. Never build one of these from user input.
   */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside a single database transaction. Everything commits or
   * nothing does. Used wherever one logical action touches several rows —
   * for paper execution that will be cash, positions and trade history.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Reads a BIGINT column that the driver returned as a string. */
export function readBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return BigInt(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Refusing to read a bigint that already lost precision as a number");
    }
    return BigInt(value);
  }
  throw new Error(`Cannot read bigint from ${typeof value}`);
}

export function readString(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected text, got ${typeof value}`);
  return value;
}

export function readDateMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  throw new Error(`Cannot read timestamp from ${typeof value}`);
}
