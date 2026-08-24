import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import { WorkerLeaseRepository } from "../src/db/repositories.js";

const NOW = 1_760_000_000_000;
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

let db: SqlClient;
let leases: WorkerLeaseRepository;

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  leases = new WorkerLeaseRepository(db);
});

afterEach(async () => db.close());

describe("scheduled worker lease", () => {
  it("rejects overlap and duplicate run keys, then permits the next run", async () => {
    expect(await leases.tryAcquire("worker", OWNER_A, "minute-1", NOW, 360_000)).toBe(true);
    expect(await leases.tryAcquire("worker", OWNER_B, "minute-2", NOW + 1_000, 360_000)).toBe(false);
    expect(await leases.complete("worker", OWNER_A, "completed", { ok: true }, NOW + 2_000)).toBe(true);

    // Completion releases the lease but deliberately retains the run key.
    expect(await leases.tryAcquire("worker", OWNER_B, "minute-1", NOW + 3_000, 360_000)).toBe(false);
    expect(await leases.tryAcquire("worker", OWNER_B, "minute-2", NOW + 3_000, 360_000)).toBe(true);
    expect(await leases.complete("worker", OWNER_B, "completed", {}, NOW + 4_000)).toBe(true);
    expect(await leases.tryAcquire("worker", OWNER_A, "minute-1", NOW + 5_000, 360_000)).toBe(false);
  });

  it("recovers an abandoned lease only after expiry and rejects stale owners", async () => {
    expect(await leases.tryAcquire("worker", OWNER_A, "minute-1", NOW, 60_000)).toBe(true);
    expect(await leases.tryAcquire("worker", OWNER_B, "minute-2", NOW + 59_999, 60_000)).toBe(false);
    expect(await leases.tryAcquire("worker", OWNER_B, "minute-2", NOW + 60_000, 60_000)).toBe(true);
    expect(await leases.complete("worker", OWNER_A, "failed", {}, NOW + 61_000)).toBe(false);
    expect(await leases.complete("worker", OWNER_B, "degraded", { providerFailures: 1 }, NOW + 61_000)).toBe(true);

    const rows = await db.query<{ last_status: string; last_summary: Record<string, unknown> }>(
      "select last_status, last_summary from worker_leases where name = 'worker'",
    );
    expect(rows[0]?.last_status).toBe("degraded");
    expect(rows[0]?.last_summary).toEqual({ providerFailures: 1 });
  });
});
