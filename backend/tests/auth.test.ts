import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createTestDeps, usdToMicroUsd } from "../src/api/app.js";
import { PasswordAuthProvider } from "../src/auth/authService.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import { PortfolioRepository, SessionRepository, UserRepository, WatchlistRepository, hashSessionToken } from "../src/db/repositories.js";

/**
 * Runs against real PostgreSQL (PGlite, in-process), using the same migrations
 * as production. Constraints, foreign keys and transactions are genuinely
 * exercised — no mocked database — while staying offline and deterministic.
 */

const START = 1_760_000_000_000;
const STARTING = usdToMicroUsd(100_000);
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

let db: SqlClient;
let server: Server;
let base: string;
let clockRef: { now: number };

beforeEach(async () => {
  clockRef = { now: START };
  db = createPgliteClient();
  await migrate(db);

  const deps = createTestDeps(() => clockRef.now);
  deps.db = db;
  deps.auth = new PasswordAuthProvider(db, { clock: () => clockRef.now, sessionTtlMs: 30 * 86_400_000 });
  deps.env = { ...deps.env, COOKIE_SECURE: false, PAPER_STARTING_USD: 100_000 };

  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  server?.close();
  await db.close();
});

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  cookie: string | null;
}

async function call(method: string, path: string, body?: unknown, cookie?: string | null): Promise<Res> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + path, init);
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: setCookie ? setCookie.split(";")[0]! : null,
  };
}

const signUp = (email: string, password = "correct horse battery") =>
  call("POST", "/v1/auth/signup", { email, password });

describe("password hashing", () => {
  it("never stores the plaintext and verifies correctly", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).not.toContain("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password here", hash)).toBe(false);
  });

  it("produces a different hash each time for the same password", async () => {
    // Distinct salts, so identical passwords are not identifiable in a dump.
    expect(await hashPassword("same password xyz")).not.toBe(await hashPassword("same password xyz"));
  });

  it("returns false for a malformed hash rather than throwing", async () => {
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("sign up / sign in / sign out", () => {
  it("creates an account and returns a session cookie", async () => {
    const res = await signUp("alice@example.com");
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("alice@example.com");
    expect(res.cookie).toMatch(/^mp_session=/);
    // The response body must never carry the raw token or a password hash.
    expect(JSON.stringify(res.body)).not.toMatch(/password|token/i);
  });

  it("sets HttpOnly and SameSite on the session cookie", async () => {
    const res = await fetch(base + "/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "flags@example.com", password: "correct horse battery" }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("rejects a duplicate email, case-insensitively", async () => {
    await signUp("dupe@example.com");
    const second = await signUp("DUPE@example.com");
    expect(second.status).toBe(409);
  });

  it("rejects weak or malformed credentials", async () => {
    expect((await call("POST", "/v1/auth/signup", { email: "x@y.com", password: "short" })).status).toBe(400);
    expect((await call("POST", "/v1/auth/signup", { email: "nope", password: "correct horse battery" })).status).toBe(400);
  });

  it("signs in with correct credentials and rejects wrong ones identically", async () => {
    await signUp("bob@example.com");
    const ok = await call("POST", "/v1/auth/signin", { email: "bob@example.com", password: "correct horse battery" });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/^mp_session=/);

    const wrongPassword = await call("POST", "/v1/auth/signin", { email: "bob@example.com", password: "wrong password xx" });
    const noSuchUser = await call("POST", "/v1/auth/signin", { email: "ghost@example.com", password: "wrong password xx" });
    // Same status and message, so neither reveals which emails exist.
    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.body.message).toBe(noSuchUser.body.message);
  });

  it("signs out and invalidates the session", async () => {
    const { cookie } = await signUp("carol@example.com");
    expect((await call("GET", "/v1/me", undefined, cookie)).body.authenticated).toBe(true);
    await call("POST", "/v1/auth/signout", undefined, cookie);
    expect((await call("GET", "/v1/me", undefined, cookie)).body.authenticated).toBe(false);
  });
});

describe("authorization boundary", () => {
  it("refuses portfolio access to anonymous callers", async () => {
    const res = await call("GET", "/v1/me/portfolio");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
  });

  it("refuses a forged or garbage session cookie", async () => {
    const forged = "mp_session=" + "a".repeat(43);
    expect((await call("GET", "/v1/me/portfolio", undefined, forged)).status).toBe(401);
    expect((await call("GET", "/v1/me/portfolio", undefined, "mp_session=")).status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const { cookie } = await signUp("expire@example.com");
    expect((await call("GET", "/v1/me/portfolio", undefined, cookie)).status).toBe(200);
    clockRef.now += 31 * 86_400_000; // past the 30-day TTL
    expect((await call("GET", "/v1/me/portfolio", undefined, cookie)).status).toBe(401);
  });

  it("keeps each user's data private, even with the other's cookie absent", async () => {
    const alice = await signUp("a@example.com");
    const bob = await signUp("b@example.com");

    await call("POST", "/v1/me/watchlist", { tokenMint: BONK }, alice.cookie);
    await call("POST", "/v1/me/watchlist", { tokenMint: WIF }, bob.cookie);

    const aliceList = await call("GET", "/v1/me/watchlist", undefined, alice.cookie);
    const bobList = await call("GET", "/v1/me/watchlist", undefined, bob.cookie);

    expect(aliceList.body.items.map((i: { tokenMint: string }) => i.tokenMint)).toEqual([BONK]);
    expect(bobList.body.items.map((i: { tokenMint: string }) => i.tokenMint)).toEqual([WIF]);
  });

  it("ignores a userId supplied by the client", async () => {
    const alice = await signUp("trust@example.com");
    const bob = await signUp("victim@example.com");
    const bobId = bob.body.user.id;

    // Identity comes from the cookie; query and body params are not authority.
    const res = await call("GET", `/v1/me/portfolio?userId=${bobId}`, undefined, alice.cookie);
    expect(res.status).toBe(200);
    const direct = await call("GET", "/v1/me/portfolio", undefined, alice.cookie);
    expect(res.body.portfolio.id).toBe(direct.body.portfolio.id);
    expect(res.body.portfolio.id).not.toBe(
      (await call("GET", "/v1/me/portfolio", undefined, bob.cookie)).body.portfolio.id,
    );
  });

  it("cannot read another user's portfolio through the repository", async () => {
    const users = new UserRepository(db);
    const portfolios = new PortfolioRepository(db);
    const alice = await users.create("r1@example.com", await hashPassword("correct horse battery"));
    const bob = await users.create("r2@example.com", await hashPassword("correct horse battery"));
    const alicePortfolio = await portfolios.ensureDefault(alice.id, STARTING);

    expect(await portfolios.findOwned(alicePortfolio.id, alice.id)).not.toBeNull();
    // Ownership is in the WHERE clause, so the wrong owner simply sees nothing.
    expect(await portfolios.findOwned(alicePortfolio.id, bob.id)).toBeNull();
  });
});

describe("portfolio initialization", () => {
  it("funds a new account with exactly the configured starting balance", async () => {
    const { cookie } = await signUp("fund@example.com");
    const res = await call("GET", "/v1/me/portfolio", undefined, cookie);
    expect(res.body.portfolio.cashUsd).toBe("100000.00");
    expect(res.body.portfolio.startingCashUsd).toBe("100000.00");
    expect(res.body.portfolio.baseCurrency).toBe("USD");
    expect(res.body.portfolio.simulated).toBe(true);
  });

  it("is idempotent: repeated initialization never funds twice", async () => {
    const users = new UserRepository(db);
    const portfolios = new PortfolioRepository(db);
    const user = await users.create("idem@example.com", await hashPassword("correct horse battery"));

    const first = await portfolios.ensureDefault(user.id, STARTING);
    const second = await portfolios.ensureDefault(user.id, STARTING);
    const third = await portfolios.ensureDefault(user.id, STARTING);

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    const count = await db.query<{ n: string }>(
      "select count(*)::text as n from portfolios where user_id = $1",
      [user.id],
    );
    expect(count[0]!.n).toBe("1");
  });

  it("survives concurrent first requests without double funding", async () => {
    const users = new UserRepository(db);
    const portfolios = new PortfolioRepository(db);
    const user = await users.create("race@example.com", await hashPassword("correct horse battery"));

    // The unique index decides the winner, not application logic.
    await Promise.all([
      portfolios.ensureDefault(user.id, STARTING),
      portfolios.ensureDefault(user.id, STARTING),
      portfolios.ensureDefault(user.id, STARTING),
    ]);
    const count = await db.query<{ n: string }>(
      "select count(*)::text as n from portfolios where user_id = $1",
      [user.id],
    );
    expect(count[0]!.n).toBe("1");
  });

  it("keeps the portfolio when the service is recreated, which /tmp would not", async () => {
    const { cookie } = await signUp("persist@example.com");
    const before = await call("GET", "/v1/me/portfolio", undefined, cookie);

    // Tear the HTTP layer down and rebuild it against the same database,
    // standing in for a serverless cold start.
    server.close();
    const deps = createTestDeps(() => clockRef.now);
    deps.db = db;
    deps.auth = new PasswordAuthProvider(db, { clock: () => clockRef.now });
    deps.env = { ...deps.env, COOKIE_SECURE: false };
    const app = createApp(deps);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;

    const after = await call("GET", "/v1/me/portfolio", undefined, cookie);
    expect(after.status).toBe(200);
    expect(after.body.portfolio.id).toBe(before.body.portfolio.id);
    expect(after.body.portfolio.cashUsd).toBe("100000.00");
  });
});

describe("watchlist persistence", () => {
  it("adds, lists and removes by canonical mint", async () => {
    const { cookie } = await signUp("watch@example.com");
    expect((await call("POST", "/v1/me/watchlist", { tokenMint: BONK }, cookie)).status).toBe(201);

    const list = await call("GET", "/v1/me/watchlist", undefined, cookie);
    expect(list.body.count).toBe(1);
    expect(list.body.items[0].tokenMint).toBe(BONK);
    // Stores intent only — no cached price or liquidity to go stale.
    expect(list.body.items[0]).not.toHaveProperty("price");

    const del = await call("DELETE", `/v1/me/watchlist/${BONK}`, undefined, cookie);
    expect(del.body.removed).toBe(true);
    expect((await call("GET", "/v1/me/watchlist", undefined, cookie)).body.count).toBe(0);
  });

  it("adding the same mint twice does not duplicate it", async () => {
    const { cookie } = await signUp("dupewatch@example.com");
    await call("POST", "/v1/me/watchlist", { tokenMint: BONK }, cookie);
    await call("POST", "/v1/me/watchlist", { tokenMint: BONK }, cookie);
    expect((await call("GET", "/v1/me/watchlist", undefined, cookie)).body.count).toBe(1);
  });

  it("rejects a malformed mint", async () => {
    const { cookie } = await signUp("badmint@example.com");
    expect((await call("POST", "/v1/me/watchlist", { tokenMint: "nope" }, cookie)).status).toBe(400);
  });

  it("requires authentication", async () => {
    expect((await call("GET", "/v1/me/watchlist")).status).toBe(401);
    expect((await call("POST", "/v1/me/watchlist", { tokenMint: BONK })).status).toBe(401);
  });
});

describe("database guarantees", () => {
  it("stores session tokens hashed, never in the clear", async () => {
    const sessions = new SessionRepository(db);
    const users = new UserRepository(db);
    const user = await users.create("hash@example.com", await hashPassword("correct horse battery"));
    await sessions.create("super-secret-token", user.id, START + 60_000);

    const rows = await db.query<{ token_hash: string }>("select token_hash from sessions");
    expect(rows[0]!.token_hash).not.toBe("super-secret-token");
    expect(rows[0]!.token_hash).toBe(hashSessionToken("super-secret-token"));
    // The raw token still resolves, because we hash on lookup too.
    expect(await sessions.findValidUser("super-secret-token", START)).not.toBeNull();
  });

  it("refuses a negative cash balance at the database level", async () => {
    const users = new UserRepository(db);
    const user = await users.create("neg@example.com", await hashPassword("correct horse battery"));
    await expect(
      db.query(
        "insert into portfolios (user_id, cash_micro_usd, starting_micro_usd) values ($1, -1, 1)",
        [user.id],
      ),
    ).rejects.toThrow();
  });

  it("cascades sessions and portfolios when a user is deleted", async () => {
    const { cookie } = await signUp("cascade@example.com");
    await call("GET", "/v1/me/portfolio", undefined, cookie);
    const userId = (await db.query<{ id: string }>("select id from users where email = $1", ["cascade@example.com"]))[0]!.id;

    await db.query("delete from users where id = $1", [userId]);
    const sessions = await db.query("select 1 from sessions where user_id = $1", [userId]);
    const portfolios = await db.query("select 1 from portfolios where user_id = $1", [userId]);
    expect(sessions).toHaveLength(0);
    expect(portfolios).toHaveLength(0);
  });

  it("rolls back every write when a transaction fails", async () => {
    const users = new UserRepository(db);
    const user = await users.create("tx@example.com", await hashPassword("correct horse battery"));
    const watch = new WatchlistRepository(db);

    await expect(
      db.transaction(async (tx) => {
        await new WatchlistRepository(tx).add(user.id, BONK);
        // Violates the non-negative CHECK, so the whole transaction unwinds.
        await tx.query("insert into portfolios (user_id, cash_micro_usd, starting_micro_usd) values ($1, -5, 1)", [user.id]);
      }),
    ).rejects.toThrow();

    // The watchlist insert must be gone: all or nothing.
    expect(await watch.list(user.id)).toHaveLength(0);
  });

  it("stores money exactly beyond the float-safe range", async () => {
    const users = new UserRepository(db);
    const portfolios = new PortfolioRepository(db);
    const user = await users.create("big@example.com", await hashPassword("correct horse battery"));
    // 2^53 + 1 micro-USD: unrepresentable as a JS number.
    const huge = 9_007_199_254_740_993n;
    await portfolios.ensureDefault(user.id, huge);
    const read = await portfolios.findDefault(user.id);
    expect(read!.cashMicroUsd).toBe(huge);
  });
});

describe("public routes stay public", () => {
  it("does not require a session for research or health", async () => {
    expect((await call("GET", "/health")).status).toBe(200);
    expect((await call("GET", "/v1/me")).body.authenticated).toBe(false);
    // Anonymous search reaches the provider layer rather than a 401.
    expect((await call("GET", "/v1/search?q=bonk")).status).not.toBe(401);
  });
});
