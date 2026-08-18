import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { asArbError, ArbError } from "../core/errors.js";
import type { AuthProvider, AuthenticatedUser } from "../auth/authService.js";
import { credentialsSchema } from "../auth/authService.js";
import type { SqlClient } from "../db/client.js";
import {
  PortfolioRepository,
  RateLimitRepository,
  WatchlistRepository,
  type RateLimitResult,
} from "../db/repositories.js";
import type { LivePaperTradingService } from "../paper/livePaper.js";

/**
 * Identity and per-user state.
 *
 * Every route here derives the acting user from the session cookie. No handler
 * accepts a userId or portfolioId from the client as proof of anything: the
 * browser can send whatever it likes, so ownership is decided server-side by
 * scoping queries to the verified session's user id.
 */

export const SESSION_COOKIE = "mp_session";

/**
 * One message for every persistence outage. It names what is broken and what
 * still works, so a user is not left assuming the whole product is down.
 */
const PERSISTENCE_DOWN_MESSAGE =
  "Account services are temporarily unavailable. Research and quotes are unaffected.";

export interface AuthRoutesOptions {
  /** Resolved per request so persistence can recover without a redeploy. */
  getAuth: () => AuthProvider | undefined;
  getDb: () => SqlClient | undefined;
  /** Constructed against the current database so persistence may recover at runtime. */
  createPaperTrading: (db: SqlClient) => LivePaperTradingService;
  startingMicroUsd: bigint;
  clock: () => number;
  rateLimits: {
    authAttempts: number;
    authWindowMs: number;
    authNetworkAttempts: number;
    paperAttempts: number;
    paperWindowMs: number;
  };
  /** Set Secure on cookies. Off for plain-HTTP local development. */
  secureCookies: boolean;
}

/** Minimal cookie parsing — avoids a dependency for one header. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(res: Response, token: string, expiresAtMs: number, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    // httpOnly: JavaScript cannot read it, so an XSS bug cannot exfiltrate
    // the session token.
    "HttpOnly",
    // SameSite=Lax: the cookie is not sent on cross-site POSTs, which blocks
    // the ordinary CSRF shape without needing a token for these routes.
    "SameSite=Lax",
    `Expires=${new Date(expiresAtMs).toUTCString()}`,
  ];
  if (secure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(res: Response, secure: boolean): void {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

/** Resolves the caller, or null when anonymous. Never throws. */
export async function resolveUser(req: Request, auth: AuthProvider): Promise<AuthenticatedUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    return await auth.verify(token);
  } catch {
    return null;
  }
}

/**
 * A database error must not surface as a generic 500. Callers need to know
 * the difference between "you sent something wrong" and "our storage is
 * temporarily down", and neither should ever leak SQL to the browser.
 */
function toSafeError(err: unknown): ArbError {
  const e = asArbError(err);
  if (e.code !== "INTERNAL_ERROR") return e;
  const message = err instanceof Error ? err.message : String(err);
  if (/relation .* does not exist|undefined_table/i.test(message)) {
    return new ArbError("DATABASE_ERROR", "Account services are temporarily unavailable.", 503);
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection|terminated|SASL|password authentication/i.test(message)) {
    return new ArbError("DATABASE_ERROR", "Account services are temporarily unavailable.", 503);
  }
  return e;
}

export function createAuthRouter(options: AuthRoutesOptions): Router {
  const router = express.Router();
  const { getAuth, getDb, createPaperTrading, startingMicroUsd, secureCookies, clock, rateLimits } = options;

  const setLimitHeaders = (res: Response, result: RateLimitResult): void => {
    res.setHeader("RateLimit-Limit", String(result.limit));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(Math.max(1, Math.ceil((result.resetAtMs - clock()) / 1_000))));
  };

  const consumeLimit = async (
    res: Response,
    scope: string,
    subject: string,
    limit: number,
    windowMs: number,
  ): Promise<void> => {
    const result = await new RateLimitRepository(getDb()!).consume(scope, subject, limit, windowMs, clock());
    setLimitHeaders(res, result);
  };

  const fail = (res: Response, err: unknown): void => {
    const e = toSafeError(err);
    if (e.code === "RATE_LIMITED") {
      const retryAfter = e.details?.retryAfterSeconds;
      if (typeof retryAfter === "number") res.setHeader("Retry-After", String(retryAfter));
      if (typeof e.details?.limit === "number") res.setHeader("RateLimit-Limit", String(e.details.limit));
      res.setHeader("RateLimit-Remaining", "0");
      if (typeof e.details?.resetAtMs === "number") {
        res.setHeader("RateLimit-Reset", String(Math.max(1, Math.ceil((e.details.resetAtMs - clock()) / 1_000))));
      }
    }
    if (e.httpStatus >= 500) {
      // Full detail server-side; nothing sensitive to the client.
      console.error(JSON.stringify({ msg: "account request failed", code: e.code, error: e.message }));
    }
    res.status(e.httpStatus).json({
      error: e.code,
      message: e.message,
      details: e.details ?? null,
    });
  };

  /** 503 when persistence is unavailable, so the reason is never guessed at. */
  const requirePersistence = (
    _req: Request,
    res: Response,
    next: express.NextFunction,
  ): void => {
    if (!getDb() || !getAuth()) {
      res.status(503).json({
        error: "DATABASE_ERROR",
        message: PERSISTENCE_DOWN_MESSAGE,
      });
      return;
    }
    next();
  };

  /** Rejects anonymous callers; attaches the verified user to res.locals. */
  const requireAuth = async (req: Request, res: Response, next: express.NextFunction): Promise<void> => {
    const auth = getAuth();
    if (!auth) {
      res.status(503).json({
        error: "DATABASE_ERROR",
        message: PERSISTENCE_DOWN_MESSAGE,
      });
      return;
    }
    const user = await resolveUser(req, auth);
    if (!user) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Sign in to access this." });
      return;
    }
    res.locals.user = user;
    next();
  };

  const currentUser = (res: Response): AuthenticatedUser => res.locals.user as AuthenticatedUser;
  const paperTrading = (): LivePaperTradingService => createPaperTrading(getDb()!);

  // ---- Identity ----

  router.post("/v1/auth/signup", requirePersistence, async (req, res) => {
    try {
      const parsed = credentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError("VALIDATION_ERROR", "Enter a valid email and a password of at least 10 characters", 400);
      }
      await consumeLimit(
        res,
        "auth:network",
        req.ip ?? req.socket.remoteAddress ?? "unresolved-network",
        rateLimits.authNetworkAttempts,
        rateLimits.authWindowMs,
      );
      await consumeLimit(
        res,
        "auth:credentials",
        parsed.data.email,
        rateLimits.authAttempts,
        rateLimits.authWindowMs,
      );
      const session = await getAuth()!.signUp(parsed.data.email, parsed.data.password);
      // Fund the portfolio immediately so the account is never half-created.
      await new PortfolioRepository(getDb()!).ensureDefault(session.user.id, startingMicroUsd);
      setSessionCookie(res, session.token, session.expiresAtMs, secureCookies);
      console.log(JSON.stringify({ msg: "account created", userId: session.user.id }));
      res.status(201).json({ user: { id: session.user.id, email: session.user.email } });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/v1/auth/signin", requirePersistence, async (req, res) => {
    try {
      const parsed = credentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError("UNAUTHORIZED", "Email or password is incorrect", 401);
      }
      await consumeLimit(
        res,
        "auth:network",
        req.ip ?? req.socket.remoteAddress ?? "unresolved-network",
        rateLimits.authNetworkAttempts,
        rateLimits.authWindowMs,
      );
      await consumeLimit(
        res,
        "auth:credentials",
        parsed.data.email,
        rateLimits.authAttempts,
        rateLimits.authWindowMs,
      );
      const session = await getAuth()!.signIn(parsed.data.email, parsed.data.password);
      setSessionCookie(res, session.token, session.expiresAtMs, secureCookies);
      res.json({ user: { id: session.user.id, email: session.user.email } });
    } catch (err) {
      // Log the failure without the credentials that caused it.
      if (asArbError(err).code === "UNAUTHORIZED") {
        console.warn(JSON.stringify({ msg: "sign-in failed", reason: "invalid credentials" }));
      }
      fail(res, err);
    }
  });

  router.post("/v1/auth/signout", async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    const auth = getAuth();
    if (token && auth) await auth.signOut(token).catch(() => undefined);
    // Always clear the cookie: signing out must work even if storage is down.
    clearSessionCookie(res, secureCookies);
    res.json({ ok: true });
  });

  /**
   * Session probe for the frontend. Public and never 500s: "anonymous" and
   * "accounts unavailable" are both valid answers the UI needs to render.
   */
  router.get("/v1/me", async (req, res) => {
    const auth = getAuth();
    if (!auth) {
      res.json({ authenticated: false, user: null, accountsEnabled: false });
      return;
    }
    let user: AuthenticatedUser | null = null;
    try {
      user = await resolveUser(req, auth);
    } catch {
      res.json({ authenticated: false, user: null, accountsEnabled: false });
      return;
    }
    res.json({
      authenticated: user !== null,
      accountsEnabled: true,
      user: user ? { id: user.id, email: user.email } : null,
    });
  });

  // ---- Per-user state ----

  router.get("/v1/me/portfolio", requireAuth, async (_req, res) => {
    try {
      const user = currentUser(res);
      res.json({ portfolio: await paperTrading().getPortfolio(user.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  const paperEntrySchema = z.object({
    clientRequestId: z.string().uuid(),
    tokenMint: z.string().min(32).max(64),
    amountUsd: z.union([z.string().min(1).max(32), z.number().finite()]).transform(String),
    slippageBps: z.coerce.number().int().min(1).max(5_000).default(50),
  });

  router.post("/v1/me/paper/positions", requireAuth, async (req, res) => {
    try {
      const parsed = paperEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError(
          "VALIDATION_ERROR",
          "Enter a valid request id, mint, USD amount, and slippage setting.",
          400,
        );
      }
      await consumeLimit(
        res,
        "paper:writes",
        currentUser(res).id,
        rateLimits.paperAttempts,
        rateLimits.paperWindowMs,
      );
      const position = await paperTrading().openPosition(
        currentUser(res).id,
        parsed.data.tokenMint,
        parsed.data.amountUsd,
        BigInt(parsed.data.slippageBps),
        parsed.data.clientRequestId,
      );
      res.status(201).json({ simulated: true, executionEnabled: false, position });
    } catch (err) {
      fail(res, err);
    }
  });

  const paperCloseSchema = z.object({
    slippageBps: z.coerce.number().int().min(1).max(5_000).default(50),
  });

  router.post("/v1/me/paper/positions/:id/close", requireAuth, async (req, res) => {
    try {
      const parsed = paperCloseSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ArbError("VALIDATION_ERROR", "Invalid close slippage setting.", 400);
      await consumeLimit(
        res,
        "paper:writes",
        currentUser(res).id,
        rateLimits.paperAttempts,
        rateLimits.paperWindowMs,
      );
      const position = await paperTrading().closePosition(
        currentUser(res).id,
        req.params.id!,
        BigInt(parsed.data.slippageBps),
      );
      res.json({ simulated: true, executionEnabled: false, position });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/v1/me/watchlist", requireAuth, async (_req, res) => {
    try {
      const items = await new WatchlistRepository(getDb()!).list(currentUser(res).id);
      res.json({
        count: items.length,
        // Mint only. Market data is fetched live; the database stores intent,
        // not a stale copy of Jupiter.
        items: items.map((i) => ({ tokenMint: i.tokenMint, addedAtMs: i.createdAtMs })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  const mintSchema = z.object({ tokenMint: z.string().min(32).max(64) });

  router.post("/v1/me/watchlist", requireAuth, async (req, res) => {
    try {
      const parsed = mintSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError("VALIDATION_ERROR", "A valid token mint address is required", 400);
      }
      await new WatchlistRepository(getDb()!).add(currentUser(res).id, parsed.data.tokenMint);
      res.status(201).json({ ok: true, tokenMint: parsed.data.tokenMint });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/v1/me/watchlist/:mint", requireAuth, async (req, res) => {
    try {
      const removed = await new WatchlistRepository(getDb()!).remove(currentUser(res).id, req.params.mint!);
      res.json({ ok: true, removed });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
