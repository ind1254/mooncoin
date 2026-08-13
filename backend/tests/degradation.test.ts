import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPersistence, createApp, createTestDeps, initPersistence, type AppDeps } from "../src/api/app.js";
import { PasswordAuthProvider } from "../src/auth/authService.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";

/**
 * Regression tests for the production incident where a top-level import of the
 * Postgres driver crashed the whole function, so every endpoint returned 500 —
 * including endpoints that never touch a database.
 *
 * The rule these lock in: persistence problems degrade the PERSONAL subsystem
 * only. Public research must keep serving.
 */

const START = 1_760_000_000_000;
let server: Server;
let base: string;

async function listen(deps: AppDeps): Promise<void> {
  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (p: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

afterEach(() => server?.close());

describe("no database configured", () => {
  beforeEach(async () => {
    const deps = createTestDeps(() => START);
    // Explicitly no db/auth — the state the deployed app was effectively in.
    deps.db = undefined;
    deps.auth = undefined;
    await listen(deps);
  });

  it("the application still boots and serves", async () => {
    const health = await get("/health");
    expect(health.status).toBe(200);
    expect(health.body.app).toBe("ok");
  });

  it("public research endpoints keep working", async () => {
    // The core regression: these must never 500 because persistence is absent.
    for (const path of ["/health", "/v1/meta", "/v1/settings", "/v1/notifications", "/v1/opportunities"]) {
      const res = await get(path);
      expect(res.status, `${path} should not be a server error`).toBeLessThan(500);
    }
  });

  it("reports accounts as unconfigured rather than broken", async () => {
    const health = await get("/health");
    expect(health.body.database).toBe("unconfigured");
    expect(health.body.accountsEnabled).toBe(false);
    // Unconfigured is a deployment choice, not an outage.
    expect(health.body.degraded).toBe(false);
  });

  it("answers /v1/me without erroring", async () => {
    const res = await get("/v1/me");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.accountsEnabled).toBe(false);
  });

  it("returns 503, not 500, for personal endpoints", async () => {
    const portfolio = await get("/v1/me/portfolio");
    expect(portfolio.status).toBe(503);
    expect(portfolio.body.error).toBe("DATABASE_ERROR");

    const signup = await post("/v1/auth/signup", { email: "a@b.com", password: "correct horse battery" });
    expect(signup.status).toBe(503);

    const signin = await post("/v1/auth/signin", { email: "a@b.com", password: "correct horse battery" });
    expect(signin.status).toBe(503);
  });

  it("tells the user research still works and leaks nothing internal", async () => {
    const res = await get("/v1/me/portfolio");
    expect(res.body.message).toMatch(/unavailable/i);
    expect(res.body.message).toMatch(/research/i);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/postgres|password|DATABASE_URL|at .*\.js:\d+/i);
  });

  it("still lets a user sign out", async () => {
    // Clearing a cookie must not depend on storage being healthy.
    const res = await post("/v1/auth/signout", {});
    expect(res.status).toBe(200);
  });
});

describe("database connected but migrations missing", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = createPgliteClient();
    // Deliberately NOT migrated: connection works, schema does not exist.
    const deps = createTestDeps(() => START);
    deps.db = db;
    deps.auth = new PasswordAuthProvider(db, { clock: () => START });
    await listen(deps);
  });

  afterEach(async () => await db.close());

  it("health reports the schema as missing with a fix instruction", async () => {
    const health = await get("/health");
    expect(health.status).toBe(200);
    expect(health.body.database).toBe("schema_missing");
    expect(health.body.migrations).toBe("missing");
    expect(health.body.degraded).toBe(true);
    expect(health.body.detail).toMatch(/migrate/i);
  });

  it("signup reports a service problem instead of a raw SQL error", async () => {
    const res = await post("/v1/auth/signup", { email: "x@y.com", password: "correct horse battery" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("DATABASE_ERROR");
    // No SQL, table names or stack traces reach the browser.
    expect(JSON.stringify(res.body)).not.toMatch(/relation|does not exist|select |insert /i);
  });

  it("public research is unaffected by the missing schema", async () => {
    expect((await get("/v1/settings")).status).toBeLessThan(500);
    expect((await get("/v1/notifications")).status).toBeLessThan(500);
  });
});

describe("healthy database", () => {
  let db: SqlClient;

  beforeEach(async () => {
    db = createPgliteClient();
    await migrate(db);
    const deps = createTestDeps(() => START);
    deps.db = db;
    deps.auth = new PasswordAuthProvider(db, { clock: () => START });
    deps.env = { ...deps.env, COOKIE_SECURE: false };
    await listen(deps);
  });

  afterEach(async () => await db.close());

  it("health reports everything green", async () => {
    const health = await get("/health");
    expect(health.body.app).toBe("ok");
    expect(health.body.database).toBe("ok");
    expect(health.body.migrations).toBe("ok");
    expect(health.body.accountsEnabled).toBe(true);
    expect(health.body.degraded).toBe(false);
  });

  it("never exposes credentials or connection details", async () => {
    const health = await get("/health");
    const serialized = JSON.stringify(health.body);
    expect(serialized).not.toMatch(/postgres:\/\/|password|DATABASE_URL/i);
  });

  it("completes the full signup to session journey", async () => {
    const res = await fetch(base + "/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "journey@example.com", password: "correct horse battery" }),
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;

    const me = await fetch(base + "/v1/me", { headers: { cookie } });
    const meBody = (await me.json()) as { authenticated: boolean };
    expect(meBody.authenticated).toBe(true);

    const portfolio = await fetch(base + "/v1/me/portfolio", { headers: { cookie } });
    const pBody = (await portfolio.json()) as { portfolio: { cashUsd: string } };
    expect(pBody.portfolio.cashUsd).toBe("100000.00");
  });
});

describe("initPersistence isolation", () => {
  it("does not throw when DATABASE_URL is absent", async () => {
    const deps = createTestDeps(() => START);
    deps.db = undefined;
    deps.auth = undefined;
    await expect(initPersistence(deps)).resolves.toBeUndefined();
    expect(deps.db).toBeUndefined();
  });

  it("reports unconfigured rather than unavailable when there is no URL", async () => {
    const deps = createTestDeps(() => START);
    deps.db = undefined;
    expect(await checkPersistence(deps)).toEqual({ status: "unconfigured" });
  });

  it("leaves an injected client untouched", async () => {
    const db = createPgliteClient();
    await migrate(db);
    const deps = createTestDeps(() => START);
    deps.db = db;
    await initPersistence(deps);
    expect(deps.db).toBe(db);
    expect((await checkPersistence(deps)).status).toBe("ok");
    await db.close();
  });
});
