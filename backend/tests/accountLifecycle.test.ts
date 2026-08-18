import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountLifecycleService, type AccountEmail, type AccountEmailSender } from "../src/auth/accountLifecycle.js";
import { PasswordAuthProvider } from "../src/auth/authService.js";
import { createApp, createTestDeps } from "../src/api/app.js";
import { loadEnv } from "../src/config/env.js";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteClient } from "../src/db/pgliteClient.js";
import { hashAccountActionToken } from "../src/db/repositories.js";

const START = 1_780_000_000_000;
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "new correct horse battery";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

class CaptureSender implements AccountEmailSender {
  readonly kind = "capture";
  readonly messages: AccountEmail[] = [];
  async send(message: AccountEmail): Promise<void> {
    this.messages.push(message);
  }
}

let db: SqlClient;
let server: Server;
let base: string;
let clock: { now: number };
let sender: CaptureSender;

beforeEach(async () => {
  clock = { now: START };
  sender = new CaptureSender();
  db = createPgliteClient();
  await migrate(db);

  const deps = createTestDeps(() => clock.now, {
    COOKIE_SECURE: false,
    EMAIL_VERIFICATION_REQUIRED: true,
    RESEND_API_KEY: "test-only",
    ACCOUNT_EMAIL_FROM: "Moonpaper <accounts@example.com>",
    PUBLIC_APP_URL: "https://moonpaper.example",
  });
  deps.db = db;
  deps.auth = new PasswordAuthProvider(db, {
    clock: () => clock.now,
    emailVerificationRequired: true,
  });
  deps.accountLifecycle = new AccountLifecycleService(db, {
    sender,
    appBaseUrl: "https://moonpaper.example",
    clock: () => clock.now,
  });
  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === "object" && address) base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server?.close();
  await db.close();
});

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  cookie: string | null;
}

async function call(method: string, path: string, body?: unknown, cookie?: string | null): Promise<Result> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    body: await response.json(),
    cookie: setCookie ? setCookie.split(";")[0]! : null,
  };
}

const signUp = (email: string) => call("POST", "/v1/auth/signup", { email, password: PASSWORD });

function tokenFrom(message: AccountEmail, route: "verify-email" | "reset-password"): string {
  const match = message.text.match(new RegExp(`#/${route}/([A-Za-z0-9_-]{43})`));
  if (!match) throw new Error(`No ${route} token in captured message`);
  return match[1]!;
}

describe("email verification", () => {
  it("keeps new accounts read-only until a single-use email token is verified", async () => {
    const signup = await signUp("verify@example.com");
    expect(signup.status).toBe(201);
    expect(signup.body.user.emailVerified).toBe(false);
    expect(signup.body.verificationEmailSent).toBe(true);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]!.text).toContain("https://moonpaper.example/#/verify-email/");
    expect(sender.messages[0]!.text).not.toContain("?token=");

    const blocked = await call("POST", "/v1/me/watchlist", { tokenMint: BONK }, signup.cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("EMAIL_VERIFICATION_REQUIRED");

    const token = tokenFrom(sender.messages[0]!, "verify-email");
    const stored = await db.query<{ token_hash: string }>("select token_hash from account_action_tokens");
    expect(stored[0]!.token_hash).toBe(hashAccountActionToken(token));
    expect(stored[0]!.token_hash).not.toBe(token);

    expect((await call("POST", "/v1/auth/verify-email", { token })).status).toBe(200);
    expect((await call("GET", "/v1/me", undefined, signup.cookie)).body.user.emailVerified).toBe(true);
    expect((await call("POST", "/v1/me/watchlist", { tokenMint: BONK }, signup.cookie)).status).toBe(201);

    const replay = await call("POST", "/v1/auth/verify-email", { token });
    expect(replay.status).toBe(400);
  });

  it("expires verification tokens and revokes the previous token on resend", async () => {
    const signup = await signUp("expires@example.com");
    const first = tokenFrom(sender.messages[0]!, "verify-email");
    expect((await call("POST", "/v1/auth/resend-verification", {}, signup.cookie)).status).toBe(200);
    const second = tokenFrom(sender.messages[1]!, "verify-email");
    expect(second).not.toBe(first);
    expect((await call("POST", "/v1/auth/verify-email", { token: first })).status).toBe(400);

    clock.now += 24 * 60 * 60 * 1_000 + 1;
    expect((await call("POST", "/v1/auth/verify-email", { token: second })).status).toBe(400);
  });
});

describe("password recovery", () => {
  it("uses the same response for existing and unknown accounts", async () => {
    await signUp("known@example.com");
    sender.messages.length = 0;

    const known = await call("POST", "/v1/auth/forgot-password", { email: "known@example.com" });
    const unknown = await call("POST", "/v1/auth/forgot-password", { email: "unknown@example.com" });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]!.text).toContain("https://moonpaper.example/#/reset-password/");
    expect(sender.messages[0]!.text).not.toContain("?token=");
  });

  it("changes the password once and invalidates every existing session", async () => {
    const signup = await signUp("recover@example.com");
    const secondSession = await call("POST", "/v1/auth/signin", {
      email: "recover@example.com",
      password: PASSWORD,
    });
    await call("POST", "/v1/auth/forgot-password", { email: "recover@example.com" });
    const resetMessage = sender.messages.find((message) => message.subject.includes("Reset"));
    const token = tokenFrom(resetMessage!, "reset-password");

    const reset = await call("POST", "/v1/auth/reset-password", { token, password: NEW_PASSWORD }, signup.cookie);
    expect(reset.status).toBe(200);
    expect(reset.cookie).toBe("mp_session=");
    expect((await call("GET", "/v1/me", undefined, signup.cookie)).body.authenticated).toBe(false);
    expect((await call("GET", "/v1/me", undefined, secondSession.cookie)).body.authenticated).toBe(false);

    expect((await call("POST", "/v1/auth/signin", { email: "recover@example.com", password: PASSWORD })).status).toBe(401);
    expect((await call("POST", "/v1/auth/signin", { email: "recover@example.com", password: NEW_PASSWORD })).status).toBe(200);
    expect((await call("POST", "/v1/auth/reset-password", { token, password: "another secure password" })).status).toBe(400);
  });
});

describe("account email configuration", () => {
  it("refuses to enforce verification without a complete email sender", () => {
    expect(() =>
      loadEnv({
        ...process.env,
        EMAIL_VERIFICATION_REQUIRED: "true",
        RESEND_API_KEY: undefined,
        ACCOUNT_EMAIL_FROM: undefined,
      }),
    ).toThrow(/cannot be true until Resend delivery is configured/);
    expect(() =>
      loadEnv({
        ...process.env,
        RESEND_API_KEY: "test",
        ACCOUNT_EMAIL_FROM: undefined,
      }),
    ).toThrow(/configured together/);
  });

  it("grandfathers accounts created before the lifecycle migration", async () => {
    const legacy = createPgliteClient();
    try {
      await legacy.exec(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        );
        create table users (
          id uuid primary key default gen_random_uuid(),
          email text not null,
          password_hash text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        insert into users (email, password_hash) values ('legacy@example.com', 'legacy-hash');
        insert into schema_migrations (name) values
          ('001_init.sql'), ('002_live_paper_positions.sql'), ('003_production_safeguards.sql');
      `);
      expect((await migrate(legacy)).applied).toEqual(["004_account_lifecycle.sql"]);
      const rows = await legacy.query<{ email_verified_at: Date | string | null }>(
        "select email_verified_at from users where email = 'legacy@example.com'",
      );
      expect(rows[0]!.email_verified_at).not.toBeNull();
    } finally {
      await legacy.close();
    }
  });
});
