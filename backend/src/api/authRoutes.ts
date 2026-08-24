import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { asArbError, ArbError } from "../core/errors.js";
import { decimalToBaseUnits, microToUsdString } from "../core/money.js";
import type { AuthProvider, AuthenticatedUser } from "../auth/authService.js";
import { credentialsSchema } from "../auth/authService.js";
import type { AccountLifecycleService } from "../auth/accountLifecycle.js";
import type { SqlClient } from "../db/client.js";
import {
  PortfolioRepository,
  PaperBotConfigRepository,
  PaperBotDecisionRepository,
  OwnerRepository,
  RateLimitRepository,
  WatchlistRepository,
  type RateLimitResult,
} from "../db/repositories.js";
import type { LivePaperTradingService } from "../paper/livePaper.js";
import type { PaperBotConfigRecord, PaperBotDecisionRecord } from "../bot/types.js";

/**
 * Identity and per-user state.
 *
 * Every route here derives the acting user from the session cookie. No handler
 * accepts a userId or portfolioId from the client as proof of anything: the
 * browser can send whatever it likes, so ownership is decided server-side by
 * scoping queries to the verified session's user id.
 */

export const SESSION_COOKIE = "mp_session";

export interface OwnerAccessConfig {
  apiKey: string;
}

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
  getAccountLifecycle: () => AccountLifecycleService | undefined;
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
    integrationAttempts: number;
    integrationWindowMs: number;
  };
  /** When present, password entry is disabled and this one owner key is used. */
  ownerAccess?: OwnerAccessConfig;
  /** Set Secure on cookies. Off for plain-HTTP local development. */
  secureCookies: boolean;
  /** Personal writes are blocked for unverified accounts when enabled. */
  emailVerificationRequired: boolean;
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

/** Exact constant-time bearer comparison. Missing and short keys fail closed. */
export function isAuthorizedOwnerRequest(authorization: string | undefined, apiKey: string | undefined): boolean {
  if (!authorization || !apiKey || apiKey.length < 32) return false;
  const actual = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${apiKey}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Resolves the caller, or null when anonymous. Never throws. */
export async function resolveUser(
  req: Request,
  auth: AuthProvider,
  db?: SqlClient,
  ownerAccess?: OwnerAccessConfig,
): Promise<AuthenticatedUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  try {
    if (token) {
      const sessionUser = await auth.verify(token);
      const designatedOwner = ownerAccess && db ? await new OwnerRepository(db).get() : null;
      const isDesignatedOwner = !ownerAccess || sessionUser?.id === designatedOwner?.id;
      if (sessionUser && isDesignatedOwner) return sessionUser;
    }
    if (db && ownerAccess && isAuthorizedOwnerRequest(req.headers.authorization, ownerAccess.apiKey)) {
      const owner = await new OwnerRepository(db).getOrAssign();
      return owner
        ? { id: owner.id, email: owner.email, emailVerified: owner.emailVerifiedAtMs !== null }
        : null;
    }
    return null;
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
  const {
    getAuth,
    getDb,
    getAccountLifecycle,
    createPaperTrading,
    startingMicroUsd,
    secureCookies,
    emailVerificationRequired,
    ownerAccess,
    clock,
    rateLimits,
  } = options;

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
    const user = await resolveUser(req, auth, getDb(), ownerAccess);
    if (!user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: ownerAccess ? "A valid Moonpaper owner key is required." : "Sign in to access this.",
      });
      return;
    }
    res.locals.user = user;
    next();
  };

  const currentUser = (res: Response): AuthenticatedUser => res.locals.user as AuthenticatedUser;
  const paperTrading = (): LivePaperTradingService => createPaperTrading(getDb()!);

  const requireVerified = (_req: Request, res: Response, next: express.NextFunction): void => {
    const designatedOwner = Boolean(ownerAccess);
    if (emailVerificationRequired && !currentUser(res).emailVerified && !designatedOwner) {
      res.status(403).json({
        error: "EMAIL_VERIFICATION_REQUIRED",
        message: "Verify your email before changing your paper portfolio or watchlist.",
      });
      return;
    }
    next();
  };

  const serializeBotConfig = (config: PaperBotConfigRecord): Record<string, unknown> => ({
    id: config.id,
    enabled: config.enabled,
    simulated: true,
    executionEnabled: false,
    strategyVersion: config.strategyVersion,
    tradeSizeUsd: microToUsdString(config.tradeSizeMicroUsd),
    minQualityScore: config.minQualityScore,
    maxRiskScore: config.maxRiskScore,
    minLiquidityUsd: microToUsdString(config.minLiquidityMicroUsd),
    maxPriceImpactBps: Number(config.maxPriceImpactBps),
    slippageBps: Number(config.slippageBps),
    maxOpenPositions: config.maxOpenPositions,
    takeProfitBps: Number(config.takeProfitBps),
    stopLossBps: Number(config.stopLossBps),
    trailingStopBps: Number(config.trailingStopBps),
    maxHoldMinutes: config.maxHoldMinutes,
    cooldownMinutes: config.cooldownMinutes,
    lastRunAtMs: config.lastRunAtMs,
    lastRunStatus: config.lastRunStatus,
    lastRunSummary: config.lastRunSummary,
    createdAtMs: config.createdAtMs,
    updatedAtMs: config.updatedAtMs,
  });

  const serializeBotDecision = (decision: PaperBotDecisionRecord): Record<string, unknown> => ({
    id: decision.id,
    positionId: decision.positionId,
    tokenMint: decision.tokenMint,
    tokenSymbol: decision.tokenSymbol,
    action: decision.action,
    qualityScore: decision.qualityScore,
    riskScore: decision.riskScore,
    reason: decision.reason,
    snapshot: decision.snapshot,
    createdAtMs: decision.createdAtMs,
  });

  const sequenceActions: Record<PaperBotDecisionRecord["action"], string> = {
    opened: "paper_buy",
    closed: "paper_sell",
    entry_rejected: "paper_skip",
    exit_unavailable: "paper_hold",
    scan_empty: "paper_scan_empty",
    error: "paper_error",
  };

  const encodeSequenceCursor = (decision: PaperBotDecisionRecord): string =>
    Buffer.from(`${decision.createdAtMs}:${decision.id}`, "utf8").toString("base64url");

  const decodeSequenceCursor = (cursor: string): { createdAtMs: number; id: string } => {
    let value = "";
    try {
      value = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      // Parsed by the strict check below.
    }
    const separator = value.indexOf(":");
    const parsed = z.object({
      createdAtMs: z.coerce.number().int().min(0).max(9_007_199_254_740_991),
      id: z.string().uuid(),
    }).safeParse({ createdAtMs: value.slice(0, separator), id: value.slice(separator + 1) });
    if (separator < 1 || !parsed.success) {
      throw new ArbError("VALIDATION_ERROR", "The sequence cursor is invalid.", 400);
    }
    return parsed.data;
  };

  const serializeFomoSequence = (
    decision: PaperBotDecisionRecord,
    config: PaperBotConfigRecord,
  ): Record<string, unknown> => ({
    sequenceId: decision.id,
    idempotencyKey: decision.id,
    occurredAtMs: decision.createdAtMs,
    chain: "solana",
    cluster: "mainnet-beta",
    tokenMint: decision.tokenMint,
    tokenSymbol: decision.tokenSymbol,
    action: sequenceActions[decision.action],
    decisionAction: decision.action,
    tradeSizeUsd: microToUsdString(config.tradeSizeMicroUsd),
    qualityScore: decision.qualityScore,
    riskScore: decision.riskScore,
    reason: decision.reason,
    positionId: decision.positionId,
    evidence: decision.snapshot,
    source: `moonpaper-${config.strategyVersion}`,
    mode: "paper",
    simulated: true,
    executionEnabled: false,
  });

  const passwordEntryAllowed = (_req: Request, res: Response, next: express.NextFunction): void => {
    if (ownerAccess) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Password sign-up and sign-in are disabled on this single-owner deployment.",
      });
      return;
    }
    next();
  };

  // ---- Identity ----

  router.post("/v1/owner/unlock", requirePersistence, async (req, res) => {
    try {
      await consumeLimit(
        res,
        "owner:network",
        req.ip ?? req.socket.remoteAddress ?? "unresolved-network",
        rateLimits.authNetworkAttempts,
        rateLimits.authWindowMs,
      );
      if (!ownerAccess || !isAuthorizedOwnerRequest(req.headers.authorization, ownerAccess.apiKey)) {
        throw new ArbError("UNAUTHORIZED", "The owner access key is incorrect.", 401);
      }
      const owner = await new OwnerRepository(getDb()!).getOrAssign();
      const session = owner ? await getAuth()!.issueTrustedSessionForUserId(owner.id) : null;
      if (!session) {
        throw new ArbError(
          "DATABASE_ERROR",
          "The owner account does not exist yet. Create the initial Moonpaper account before enabling owner mode.",
          503,
        );
      }
      setSessionCookie(res, session.token, session.expiresAtMs, secureCookies);
      res.json({ user: session.user, ownerMode: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/v1/auth/signup", passwordEntryAllowed, requirePersistence, async (req, res) => {
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
      let verificationEmailSent = false;
      if (emailVerificationRequired && !session.user.emailVerified) {
        try {
          verificationEmailSent = (await getAccountLifecycle()?.sendVerification(session.user.id))?.sent ?? false;
        } catch (emailError) {
          // The account and portfolio are valid. Preserve them and let the
          // signed-in user retry delivery instead of turning this into a
          // duplicate-account trap on their next sign-up attempt.
          console.error(JSON.stringify({
            msg: "verification email delivery failed",
            error: emailError instanceof Error ? emailError.message : "unknown error",
          }));
        }
      }
      console.log(JSON.stringify({ msg: "account created", userId: session.user.id }));
      res.status(201).json({
        user: session.user,
        verificationRequired: emailVerificationRequired && !session.user.emailVerified,
        verificationEmailSent,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/v1/auth/signin", passwordEntryAllowed, requirePersistence, async (req, res) => {
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
      res.json({ user: session.user });
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
      user = await resolveUser(req, auth, getDb(), ownerAccess);
    } catch {
      res.json({ authenticated: false, user: null, accountsEnabled: false });
      return;
    }
    res.json({
      authenticated: user !== null,
      accountsEnabled: true,
      ownerMode: Boolean(ownerAccess),
      emailVerificationRequired,
      emailDeliveryConfigured: getAccountLifecycle()?.deliveryConfigured ?? false,
      user,
    });
  });

  const emailSchema = z.object({ email: z.string().email().max(254) });
  const actionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

  router.post("/v1/auth/forgot-password", passwordEntryAllowed, requirePersistence, async (req, res) => {
    const startedAt = Date.now();
    try {
      const parsed = emailSchema.safeParse(req.body);
      if (parsed.success) {
        await consumeLimit(
          res,
          "auth:network",
          req.ip ?? req.socket.remoteAddress ?? "unresolved-network",
          rateLimits.authNetworkAttempts,
          rateLimits.authWindowMs,
        );
        await consumeLimit(
          res,
          "auth:recovery",
          parsed.data.email,
          rateLimits.authAttempts,
          rateLimits.authWindowMs,
        );
        try {
          await getAccountLifecycle()?.requestPasswordReset(parsed.data.email);
        } catch (emailError) {
          // Deliberately indistinguishable from an unknown email address.
          console.error(JSON.stringify({
            msg: "password reset delivery failed",
            error: emailError instanceof Error ? emailError.message : "unknown error",
          }));
        }
      }
      // Bound the most obvious account-enumeration timing difference between
      // a database miss and an outbound provider call. Rate limits provide the
      // primary abuse control; this makes the response shape less distinguishable.
      const remainingDelayMs = 350 - (Date.now() - startedAt);
      if (remainingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));
      const deliveryConfigured = getAccountLifecycle()?.deliveryConfigured ?? false;
      res.status(202).json({
        ok: true,
        deliveryConfigured,
        message: deliveryConfigured
          ? "If that account exists, a password-reset email will arrive shortly."
          : "Password-recovery email is not configured on this deployment yet.",
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/v1/auth/verify-email", passwordEntryAllowed, requirePersistence, async (req, res) => {
    try {
      const parsed = z.object({ token: actionTokenSchema }).safeParse(req.body);
      if (!parsed.success || !getAccountLifecycle()) {
        throw new ArbError("VALIDATION_ERROR", "This verification link is invalid or expired.", 400);
      }
      const user = await getAccountLifecycle()!.verifyEmail(parsed.data.token);
      res.json({ ok: true, user: { id: user.id, email: user.email, emailVerified: true } });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/v1/auth/resend-verification", passwordEntryAllowed, requireAuth, async (_req, res) => {
    try {
      await consumeLimit(
        res,
        "auth:verification",
        currentUser(res).id,
        rateLimits.authAttempts,
        rateLimits.authWindowMs,
      );
      const delivery = await getAccountLifecycle()?.sendVerification(currentUser(res).id);
      if (!delivery || delivery.reason === "delivery_unconfigured") {
        throw new ArbError("INTERNAL_ERROR", "Verification email is temporarily unavailable.", 503);
      }
      res.json({ ok: true, sent: delivery.sent, alreadyVerified: delivery.reason === "already_verified" });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/v1/auth/reset-password", passwordEntryAllowed, requirePersistence, async (req, res) => {
    try {
      const parsed = z
        .object({ token: actionTokenSchema, password: z.string().min(10).max(200) })
        .safeParse(req.body);
      if (!parsed.success || !getAccountLifecycle()) {
        throw new ArbError("VALIDATION_ERROR", "This password-reset link is invalid or expired.", 400);
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
        "auth:reset",
        parsed.data.token,
        rateLimits.authAttempts,
        rateLimits.authWindowMs,
      );
      await getAccountLifecycle()!.resetPassword(parsed.data.token, parsed.data.password);
      clearSessionCookie(res, secureCookies);
      res.json({ ok: true, message: "Password updated. Sign in again on every device." });
    } catch (err) {
      fail(res, err);
    }
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

  const moneyInput = z.union([z.string().min(1).max(32), z.number().finite()]).transform(String);
  const parseMicroUsd = (value: string, label: string): bigint => {
    if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
      throw new ArbError("VALIDATION_ERROR", `${label} must use at most two decimal places.`, 400);
    }
    try {
      return decimalToBaseUnits(value, 6);
    } catch {
      throw new ArbError("VALIDATION_ERROR", `${label} is invalid.`, 400);
    }
  };

  const botConfigSchema = z.object({
    enabled: z.boolean(),
    tradeSizeUsd: moneyInput,
    minQualityScore: z.coerce.number().int().min(0).max(100),
    maxRiskScore: z.coerce.number().int().min(0).max(100),
    minLiquidityUsd: moneyInput,
    maxPriceImpactBps: z.coerce.number().int().min(1).max(300),
    slippageBps: z.coerce.number().int().min(1).max(500),
    maxOpenPositions: z.coerce.number().int().min(1).max(10),
    takeProfitBps: z.coerce.number().int().min(100).max(10_000),
    stopLossBps: z.coerce.number().int().min(100).max(5_000),
    trailingStopBps: z.coerce.number().int().min(0).max(5_000),
    maxHoldMinutes: z.coerce.number().int().min(5).max(10_080),
    cooldownMinutes: z.coerce.number().int().min(1).max(1_440),
  });

  router.get("/v1/me/paper-bot", requireAuth, async (req, res) => {
    try {
      const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(req.query);
      if (!parsed.success) throw new ArbError("VALIDATION_ERROR", "Invalid paper-bot history limit.", 400);
      const configs = new PaperBotConfigRepository(getDb()!);
      const config = await configs.ensureDefault(currentUser(res).id, clock());
      const decisions = await new PaperBotDecisionRepository(getDb()!).listForUser(
        currentUser(res).id,
        parsed.data.limit,
      );
      res.json({
        simulated: true,
        executionEnabled: false,
        config: serializeBotConfig(config),
        decisions: decisions.map(serializeBotDecision),
        notice:
          "The shadow bot can only open and close virtual positions. It never builds, signs, or submits a transaction.",
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Integration boundary for FOMO or another owner-controlled client. This is
   * an auditable decision feed, not a wallet or transaction-signing API.
   */
  router.get("/v1/integrations/fomo/sequences", requireAuth, async (req, res) => {
    try {
      const parsed = z.object({
        cursor: z.string().min(1).max(256).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }).safeParse(req.query);
      if (!parsed.success) {
        throw new ArbError("VALIDATION_ERROR", "Use a valid sequence cursor and a limit from 1 to 100.", 400);
      }

      const user = currentUser(res);
      await consumeLimit(
        res,
        "integration:sequence-reads",
        user.id,
        rateLimits.integrationAttempts,
        rateLimits.integrationWindowMs,
      );
      const configs = new PaperBotConfigRepository(getDb()!);
      const config = await configs.ensureDefault(user.id, clock());
      const decisions = new PaperBotDecisionRepository(getDb()!);
      const cursor = parsed.data.cursor ? decodeSequenceCursor(parsed.data.cursor) : null;
      const page = cursor
        ? await decisions.listForUserAfter(user.id, cursor.createdAtMs, cursor.id, parsed.data.limit)
        : (await decisions.listForUser(user.id, parsed.data.limit)).reverse();
      const last = page.at(-1);

      res.json({
        integration: "fomo",
        schemaVersion: "2026-08-24",
        mode: "paper",
        simulated: true,
        executionEnabled: false,
        botEnabled: config.enabled,
        strategyVersion: config.strategyVersion,
        pollAfterMs: 60_000,
        sequences: page.map((decision) => serializeFomoSequence(decision, config)),
        nextCursor: last ? encodeSequenceCursor(last) : (parsed.data.cursor ?? null),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/v1/me/paper-bot", requireAuth, async (req, res) => {
    try {
      const parsed = botConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError("VALIDATION_ERROR", "Invalid paper-bot strategy settings.", 400, {
          issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
      }
      if (parsed.data.enabled && emailVerificationRequired && !currentUser(res).emailVerified) {
        throw new ArbError("EMAIL_VERIFICATION_REQUIRED", "Verify your email before enabling the paper bot.", 403);
      }
      await consumeLimit(
        res,
        "paper:writes",
        currentUser(res).id,
        rateLimits.paperAttempts,
        rateLimits.paperWindowMs,
      );
      const tradeSizeMicroUsd = parseMicroUsd(parsed.data.tradeSizeUsd, "Trade size");
      const minLiquidityMicroUsd = parseMicroUsd(parsed.data.minLiquidityUsd, "Minimum liquidity");
      if (tradeSizeMicroUsd < 10_000_000n || tradeSizeMicroUsd > 10_000_000_000n) {
        throw new ArbError("AMOUNT_OUT_OF_RANGE", "Paper-bot trade size must be between $10 and $10,000.", 400);
      }
      if (minLiquidityMicroUsd < 10_000_000_000n || minLiquidityMicroUsd > 1_000_000_000_000_000n) {
        throw new ArbError("AMOUNT_OUT_OF_RANGE", "Paper-bot minimum liquidity must be between $10,000 and $1 billion.", 400);
      }
      const configs = new PaperBotConfigRepository(getDb()!);
      await configs.ensureDefault(currentUser(res).id, clock());
      const config = await configs.save(
        currentUser(res).id,
        parsed.data.enabled,
        {
          tradeSizeMicroUsd,
          minQualityScore: parsed.data.minQualityScore,
          maxRiskScore: parsed.data.maxRiskScore,
          minLiquidityMicroUsd,
          maxPriceImpactBps: BigInt(parsed.data.maxPriceImpactBps),
          slippageBps: BigInt(parsed.data.slippageBps),
          maxOpenPositions: parsed.data.maxOpenPositions,
          takeProfitBps: BigInt(parsed.data.takeProfitBps),
          stopLossBps: BigInt(parsed.data.stopLossBps),
          trailingStopBps: BigInt(parsed.data.trailingStopBps),
          maxHoldMinutes: parsed.data.maxHoldMinutes,
          cooldownMinutes: parsed.data.cooldownMinutes,
        },
        clock(),
      );
      res.json({ simulated: true, executionEnabled: false, config: serializeBotConfig(config) });
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

  router.post("/v1/me/paper/positions", requireAuth, requireVerified, async (req, res) => {
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

  router.post("/v1/me/paper/positions/:id/close", requireAuth, requireVerified, async (req, res) => {
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

  router.post("/v1/me/watchlist", requireAuth, requireVerified, async (req, res) => {
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

  router.delete("/v1/me/watchlist/:mint", requireAuth, requireVerified, async (req, res) => {
    try {
      const removed = await new WatchlistRepository(getDb()!).remove(currentUser(res).id, req.params.mint!);
      res.json({ ok: true, removed });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
