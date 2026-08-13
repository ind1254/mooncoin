import express from "express";
import { z } from "zod";
import { asArbError, ArbError } from "../core/errors.js";
import { microToUsdString } from "../core/money.js";
import { credentialsSchema } from "../auth/authService.js";
import { PortfolioRepository, WatchlistRepository } from "../db/repositories.js";
/**
 * Identity and per-user state.
 *
 * Every route here derives the acting user from the session cookie. No handler
 * accepts a userId or portfolioId from the client as proof of anything: the
 * browser can send whatever it likes, so ownership is decided server-side by
 * scoping queries to the verified session's user id.
 */
export const SESSION_COOKIE = "mp_session";
/** Minimal cookie parsing — avoids a dependency for one header. */
function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header)
        return null;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        if (part.slice(0, eq).trim() === name) {
            return decodeURIComponent(part.slice(eq + 1).trim());
        }
    }
    return null;
}
function setSessionCookie(res, token, expiresAtMs, secure) {
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
    if (secure)
        attributes.push("Secure");
    res.setHeader("Set-Cookie", attributes.join("; "));
}
function clearSessionCookie(res, secure) {
    const attributes = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (secure)
        attributes.push("Secure");
    res.setHeader("Set-Cookie", attributes.join("; "));
}
/** Resolves the caller, or null when anonymous. Never throws. */
export async function resolveUser(req, auth) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token)
        return null;
    try {
        return await auth.verify(token);
    }
    catch {
        return null;
    }
}
function serializePortfolio(p) {
    return {
        id: p.id,
        name: p.name,
        baseCurrency: p.baseCurrency,
        simulated: true,
        cashUsd: microToUsdString(p.cashMicroUsd),
        startingCashUsd: microToUsdString(p.startingMicroUsd),
        // No positions yet: paper execution lands in the next milestone.
        investedUsd: "0.00",
        totalValueUsd: microToUsdString(p.cashMicroUsd),
        unrealizedPnlUsd: "0.00",
        realizedPnlUsd: "0.00",
        openPositions: 0,
        createdAtMs: p.createdAtMs,
        updatedAtMs: p.updatedAtMs,
        notice: "Paper trading only. This is simulated capital, not real money.",
    };
}
export function createAuthRouter(options) {
    const router = express.Router();
    const { auth, db, startingMicroUsd, secureCookies } = options;
    const portfolios = new PortfolioRepository(db);
    const watchlist = new WatchlistRepository(db);
    const fail = (res, err) => {
        const e = asArbError(err);
        res.status(e.httpStatus).json({
            error: e.code,
            message: e.message,
            details: e.details ?? null,
        });
    };
    /** Rejects anonymous callers; attaches the verified user to res.locals. */
    const requireAuth = async (req, res, next) => {
        const user = await resolveUser(req, auth);
        if (!user) {
            res.status(401).json({ error: "UNAUTHORIZED", message: "Sign in to access this." });
            return;
        }
        res.locals.user = user;
        next();
    };
    const currentUser = (res) => res.locals.user;
    // ---- Identity ----
    router.post("/v1/auth/signup", async (req, res) => {
        try {
            const parsed = credentialsSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new ArbError("VALIDATION_ERROR", "Enter a valid email and a password of at least 10 characters", 400);
            }
            const session = await auth.signUp(parsed.data.email, parsed.data.password);
            // Fund the portfolio immediately so the account is never half-created.
            await portfolios.ensureDefault(session.user.id, startingMicroUsd);
            setSessionCookie(res, session.token, session.expiresAtMs, secureCookies);
            console.log(JSON.stringify({ msg: "account created", userId: session.user.id }));
            res.status(201).json({ user: { id: session.user.id, email: session.user.email } });
        }
        catch (err) {
            fail(res, err);
        }
    });
    router.post("/v1/auth/signin", async (req, res) => {
        try {
            const parsed = credentialsSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new ArbError("UNAUTHORIZED", "Email or password is incorrect", 401);
            }
            const session = await auth.signIn(parsed.data.email, parsed.data.password);
            setSessionCookie(res, session.token, session.expiresAtMs, secureCookies);
            res.json({ user: { id: session.user.id, email: session.user.email } });
        }
        catch (err) {
            // Log the failure without the credentials that caused it.
            if (asArbError(err).code === "UNAUTHORIZED") {
                console.warn(JSON.stringify({ msg: "sign-in failed", reason: "invalid credentials" }));
            }
            fail(res, err);
        }
    });
    router.post("/v1/auth/signout", async (req, res) => {
        const token = readCookie(req, SESSION_COOKIE);
        if (token)
            await auth.signOut(token).catch(() => undefined);
        clearSessionCookie(res, secureCookies);
        res.json({ ok: true });
    });
    /** Session probe for the frontend. Public: anonymous is a valid answer. */
    router.get("/v1/me", async (req, res) => {
        const user = await resolveUser(req, auth);
        res.json({
            authenticated: user !== null,
            user: user ? { id: user.id, email: user.email } : null,
        });
    });
    // ---- Per-user state ----
    router.get("/v1/me/portfolio", requireAuth, async (_req, res) => {
        try {
            const user = currentUser(res);
            // Lazily created, so an account made before portfolios existed still
            // works, and repeated calls cannot fund it twice.
            const portfolio = await portfolios.ensureDefault(user.id, startingMicroUsd);
            res.json({ portfolio: serializePortfolio(portfolio) });
        }
        catch (err) {
            fail(res, err);
        }
    });
    router.get("/v1/me/watchlist", requireAuth, async (_req, res) => {
        try {
            const items = await watchlist.list(currentUser(res).id);
            res.json({
                count: items.length,
                // Mint only. Market data is fetched live; the database stores intent,
                // not a stale copy of Jupiter.
                items: items.map((i) => ({ tokenMint: i.tokenMint, addedAtMs: i.createdAtMs })),
            });
        }
        catch (err) {
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
            await watchlist.add(currentUser(res).id, parsed.data.tokenMint);
            res.status(201).json({ ok: true, tokenMint: parsed.data.tokenMint });
        }
        catch (err) {
            fail(res, err);
        }
    });
    router.delete("/v1/me/watchlist/:mint", requireAuth, async (req, res) => {
        try {
            const removed = await watchlist.remove(currentUser(res).id, req.params.mint);
            res.json({ ok: true, removed });
        }
        catch (err) {
            fail(res, err);
        }
    });
    return router;
}
