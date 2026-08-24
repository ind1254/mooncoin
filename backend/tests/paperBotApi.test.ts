import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { PasswordAuthProvider } from "../src/auth/authService.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";

let db: SqlClient;
let server: Server;
let base: string;

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  const deps = createTestDeps(Date.now);
  deps.db = db;
  deps.auth = new PasswordAuthProvider(db, { clock: Date.now, sessionTtlMs: 86_400_000 });
  deps.env = { ...deps.env, COOKIE_SECURE: false };
  server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.close();
  await db.close();
});

async function call(method: string, path: string, body?: unknown, cookie?: string | null) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? null,
  };
}

const settings = {
  enabled: true,
  tradeSizeUsd: "500.00",
  minQualityScore: 70,
  maxRiskScore: 30,
  minLiquidityUsd: "250000.00",
  maxPriceImpactBps: 100,
  slippageBps: 50,
  maxOpenPositions: 3,
  takeProfitBps: 1500,
  stopLossBps: 800,
  trailingStopBps: 1000,
  maxHoldMinutes: 360,
  cooldownMinutes: 60,
};

describe("paper-bot account API", () => {
  it("is private, disabled by default, and saves only simulation settings", async () => {
    expect((await call("GET", "/v1/me/paper-bot")).status).toBe(401);
    const signup = await call("POST", "/v1/auth/signup", {
      email: "bot-api@example.com",
      password: "correct horse battery",
    });
    const initial = await call("GET", "/v1/me/paper-bot", undefined, signup.cookie);
    expect(initial.status).toBe(200);
    expect(initial.body.config.enabled).toBe(false);
    expect(initial.body.executionEnabled).toBe(false);

    const updated = await call("PUT", "/v1/me/paper-bot", settings, signup.cookie);
    expect(updated.status).toBe(200);
    expect(updated.body.config).toMatchObject({ enabled: true, tradeSizeUsd: "500.00" });
    expect(updated.body.executionEnabled).toBe(false);

    const invalid = await call(
      "PUT",
      "/v1/me/paper-bot",
      { ...settings, maxPriceImpactBps: 301 },
      signup.cookie,
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("VALIDATION_ERROR");
  });
});
