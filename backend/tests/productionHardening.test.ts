import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { PasswordAuthProvider } from "../src/auth/authService.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import { RateLimitRepository, hashRateLimitSubject } from "../src/db/repositories.js";

const NOW = Date.parse("2026-08-17T23:00:00Z");

let db: SqlClient;
let server: Server;
let base: string;

beforeAll(async () => {
  db = createPgliteClient();
  await migrate(db);
  const deps = createTestDeps(() => NOW, {
    COOKIE_SECURE: true,
    AUTH_RATE_LIMIT_ATTEMPTS: 3,
    AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  });
  deps.db = db;
  deps.auth = new PasswordAuthProvider(db, { clock: () => NOW, sessionTtlMs: 86_400_000 });
  server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("production safeguards", () => {
  it("atomically enforces a durable limit and starts fresh in the next window", async () => {
    const limits = new RateLimitRepository(db);
    const first = await limits.consume("test:atomic", "user-1", 2, 60_000, NOW);
    const second = await limits.consume("test:atomic", "user-1", 2, 60_000, NOW + 1);

    expect(first.remaining).toBe(1);
    expect(second.remaining).toBe(0);
    await expect(limits.consume("test:atomic", "user-1", 2, 60_000, NOW + 2)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      httpStatus: 429,
    });
    await expect(limits.consume("test:atomic", "user-1", 2, 60_000, NOW + 60_001)).resolves.toMatchObject({
      remaining: 1,
    });
  });

  it("stores an opaque subject hash instead of the normalized identifier", async () => {
    const email = "Private.User@Example.com";
    await new RateLimitRepository(db).consume("test:privacy", email, 5, 60_000, NOW);
    const rows = await db.query<{ subject_hash: string }>(
      "select subject_hash from rate_limit_buckets where scope = 'test:privacy'",
    );

    expect(rows[0]!.subject_hash).toBe(hashRateLimitSubject(email));
    expect(rows[0]!.subject_hash).not.toContain("private.user");
  });

  it("rate-limits credential attempts with standard retry headers", async () => {
    const credentials = { email: "limited@example.com", password: "correct horse battery" };
    expect((await request("POST", "/v1/auth/signup", credentials)).response.status).toBe(201);

    const wrong = { ...credentials, password: "incorrect password!" };
    expect((await request("POST", "/v1/auth/signin", wrong)).response.status).toBe(401);
    expect((await request("POST", "/v1/auth/signin", wrong)).response.status).toBe(401);
    const limited = await request("POST", "/v1/auth/signin", wrong);

    expect(limited.response.status).toBe(429);
    expect(limited.body.error).toBe("RATE_LIMITED");
    expect(limited.response.headers.get("retry-after")).toBe("60");
    expect(limited.response.headers.get("ratelimit-remaining")).toBe("0");

    const scopes = await db.query<{ scope: string }>(
      "select distinct scope from rate_limit_buckets where scope like 'auth:%' order by scope",
    );
    expect(scopes.map(({ scope }) => scope)).toEqual(["auth:credentials", "auth:network"]);
  });

  it("rejects cross-origin writes while allowing a same-origin native-shaped request", async () => {
    const blocked = await request("POST", "/v1/auth/signout", undefined, {
      Origin: "https://attacker.example",
    });
    expect(blocked.response.status).toBe(403);
    expect(blocked.body.error).toBe("ORIGIN_NOT_ALLOWED");

    const allowed = await request("POST", "/v1/auth/signout", undefined, { Origin: base });
    expect(allowed.response.status).toBe(200);
  });

  it("serves restrictive browser headers and never reflects a hostile correlation id", async () => {
    const response = await fetch(base + "/health", {
      headers: { "x-correlation-id": "<script>alert(1)</script>" },
    });
    const body = (await response.json()) as { safeguards: Record<string, boolean> };

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.safeguards).toMatchObject({
      securityHeaders: true,
      sameOriginWrites: true,
      durableRateLimits: true,
      retrySafePaperEntries: true,
    });
  });
});
