import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps } from "../src/api/app.js";
import { PasswordAuthProvider } from "../src/auth/authService.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import {
  PaperBotConfigRepository,
  PaperBotDecisionRepository,
  UserRepository,
} from "../src/db/repositories.js";

const NOW = 1_787_558_400_000;
const OWNER_EMAIL = "owner@moonpaper.test";
const OWNER_KEY = "moonpaper-owner-test-key-0123456789abcdef";

let db: SqlClient;
let server: Server;
let base: string;
let ownerId: string;

beforeEach(async () => {
  db = createPgliteClient();
  await migrate(db);
  ownerId = (await new UserRepository(db).create(OWNER_EMAIL, "password-entry-disabled", NOW)).id;

  const deps = createTestDeps(() => NOW);
  deps.db = db;
  deps.auth = new PasswordAuthProvider(db, { clock: () => NOW, sessionTtlMs: 86_400_000 });
  deps.env = {
    ...deps.env,
    COOKIE_SECURE: false,
    OWNER_API_KEY: OWNER_KEY,
    INTEGRATION_RATE_LIMIT_ATTEMPTS: 20,
    INTEGRATION_RATE_LIMIT_WINDOW_MS: 60_000,
  };
  server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.close();
  await db.close();
});

async function call(
  method: string,
  path: string,
  options: { body?: unknown; bearer?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(base + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
    cookie: setCookie?.split(";")[0] ?? null,
    setCookie,
  };
}

describe("single-owner access", () => {
  it("disables password entry and accepts the owner bearer key on private APIs", async () => {
    expect((await call("POST", "/v1/auth/signup", {
      body: { email: "new@example.com", password: "correct horse battery" },
    })).status).toBe(403);
    expect((await call("POST", "/v1/auth/signin", {
      body: { email: OWNER_EMAIL, password: "correct horse battery" },
    })).status).toBe(403);

    expect((await call("GET", "/v1/me/paper-bot")).status).toBe(401);
    expect((await call("GET", "/v1/me/paper-bot", { bearer: `${OWNER_KEY}x` })).status).toBe(401);

    const direct = await call("GET", "/v1/me/paper-bot", { bearer: OWNER_KEY });
    expect(direct.status).toBe(200);
    expect(direct.body).toMatchObject({ simulated: true, executionEnabled: false });

    const unlock = await call("POST", "/v1/owner/unlock", { bearer: OWNER_KEY });
    expect(unlock.status).toBe(200);
    expect(unlock.body.user.email).toBe(OWNER_EMAIL);
    expect(unlock.body).not.toHaveProperty("token");
    expect(unlock.setCookie).toContain("HttpOnly");
    expect(unlock.setCookie).toContain("SameSite=Lax");

    const session = await call("GET", "/v1/me", { cookie: unlock.cookie! });
    expect(session.body).toMatchObject({ authenticated: true, ownerMode: true });

    const other = await new UserRepository(db).create("old-user@moonpaper.test", "unused", NOW);
    expect(other.email).toBe("old-user@moonpaper.test");
    const otherSession = await new PasswordAuthProvider(db, { clock: () => NOW })
      .issueTrustedSessionForUserId(other.id);
    const rejectedOldSession = await call("GET", "/v1/me", {
      cookie: `mp_session=${otherSession!.token}`,
    });
    expect(rejectedOldSession.body).toMatchObject({ authenticated: false, ownerMode: true });
  });

  it("returns only the owner's decisions with a stable polling cursor", async () => {
    const configs = new PaperBotConfigRepository(db);
    const decisions = new PaperBotDecisionRepository(db);
    const ownerConfig = await configs.ensureDefault(ownerId, NOW);
    await decisions.create({
      configId: ownerConfig.id,
      tokenMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      tokenSymbol: "BONK",
      action: "opened",
      qualityScore: 82,
      riskScore: 18,
      reason: "All production gates passed.",
      createdAtMs: NOW + 1_000,
    });
    await decisions.create({
      configId: ownerConfig.id,
      tokenMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      tokenSymbol: "BONK",
      action: "closed",
      reason: "Take profit reached.",
      createdAtMs: NOW + 2_000,
    });

    const other = await new UserRepository(db).create("other@moonpaper.test", "unused", NOW);
    const otherConfig = await configs.ensureDefault(other.id, NOW);
    await decisions.create({
      configId: otherConfig.id,
      tokenMint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
      tokenSymbol: "WIF",
      action: "opened",
      reason: "Must not leak.",
      createdAtMs: NOW + 3_000,
    });

    const first = await call("GET", "/v1/integrations/fomo/sequences?limit=10", { bearer: OWNER_KEY });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      integration: "fomo",
      mode: "paper",
      simulated: true,
      executionEnabled: false,
    });
    expect(first.body.sequences.map((sequence: Record<string, unknown>) => sequence.action)).toEqual([
      "paper_buy",
      "paper_sell",
    ]);
    expect(JSON.stringify(first.body)).not.toContain("WIF");
    expect(first.body.nextCursor).toEqual(expect.any(String));

    await decisions.create({
      configId: ownerConfig.id,
      action: "scan_empty",
      reason: "No candidate met every filter.",
      createdAtMs: NOW + 4_000,
    });
    const next = await call(
      "GET",
      `/v1/integrations/fomo/sequences?cursor=${encodeURIComponent(first.body.nextCursor)}`,
      { bearer: OWNER_KEY },
    );
    expect(next.status).toBe(200);
    expect(next.body.sequences).toHaveLength(1);
    expect(next.body.sequences[0]).toMatchObject({
      action: "paper_scan_empty",
      tokenMint: null,
      executionEnabled: false,
    });

    expect((await call("GET", "/v1/integrations/fomo/sequences?cursor=not-a-cursor", {
      bearer: OWNER_KEY,
    })).status).toBe(400);
  });
});
