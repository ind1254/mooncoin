import express, { Router } from "express";
import { z } from "zod";
import { asArbError, ArbError } from "../core/errors.js";
import { microToUsdString, usdToMicro } from "../core/money.js";
import {
  AMOUNT_LIMITS,
  getEnabledToken,
  getEnabledVenue,
  listTokens,
  listVenues,
  setTokenEnabled,
  setVenueEnabled,
} from "../config/allowlist.js";
import { JupiterVenueAdapter, VENUE_DEX_LABELS } from "../adapters/jupiter.js";
import { MockVenueAdapter } from "../adapters/mock.js";
import type { QuoteAdapter } from "../adapters/types.js";
import { DEFAULT_CONFIG, findBestRoundTrip } from "../service/arbitrageService.js";
import { InMemoryPaperStore, toPaperRecord } from "../store/paperStore.js";

/**
 * Legacy USD-denominated arbitrage calculator endpoints (the original add-on).
 * Kept fully functional for the iOS module and the /demo page.
 * Calculation-only: every response carries executionEnabled: false.
 */

export function createLegacyArbitrageRouter(useMockQuotes: boolean, adminToken?: string): Router {
  const router = express.Router();
  const store = new InMemoryPaperStore();

  function buildAdapters(): QuoteAdapter[] {
    if (useMockQuotes) {
      return [new MockVenueAdapter("raydium", 1_400n), new MockVenueAdapter("orca", 1_420n)];
    }
    return Object.entries(VENUE_DEX_LABELS).map(
      ([venueId, labels]) => new JupiterVenueAdapter(venueId, labels),
    );
  }

  const calculateSchema = z.object({
    tokenMint: z.string().min(32).max(64),
    startingAmountUsd: z.number(),
    preferredVenues: z.array(z.string()).min(2).max(4).optional(),
  });

  router.post("/v1/arbitrage/calculate", async (req, res) => {
    const correlationId = res.locals.correlationId as string;
    try {
      const parsed = calculateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ArbError("VALIDATION_ERROR", "Invalid request body", 400, {
          issues: parsed.error.issues.map((i) => i.message),
        });
      }
      const { tokenMint, startingAmountUsd, preferredVenues } = parsed.data;

      const token = getEnabledToken(tokenMint);
      if (!token) {
        throw new ArbError("TOKEN_NOT_ALLOWED", "Token is not on the verified allowlist", 403);
      }
      if (startingAmountUsd < AMOUNT_LIMITS.minUsd || startingAmountUsd > AMOUNT_LIMITS.maxUsd) {
        throw new ArbError(
          "AMOUNT_OUT_OF_RANGE",
          `Amount must be between $${AMOUNT_LIMITS.minUsd} and $${AMOUNT_LIMITS.maxUsd}`,
          400,
        );
      }
      const amountMicroUsd = usdToMicro(startingAmountUsd);

      let adapters = buildAdapters();
      if (preferredVenues) {
        for (const v of preferredVenues) {
          if (!getEnabledVenue(v)) {
            throw new ArbError("VENUE_NOT_ALLOWED", `Venue not enabled: ${v}`, 403);
          }
        }
        adapters = adapters.filter((a) => preferredVenues.includes(a.venueId));
      } else {
        adapters = adapters.filter((a) => getEnabledVenue(a.venueId));
      }

      const abort = new AbortController();
      req.on("close", () => abort.abort());

      const comparison = await findBestRoundTrip(token, amountMicroUsd, adapters, DEFAULT_CONFIG, abort.signal);
      const { buyQuote, sellQuote, outcome } = comparison;

      const record = toPaperRecord(comparison, token.symbol, amountMicroUsd, correlationId);
      await store.save(record);

      res.json({
        correlationId,
        token: { mint: token.mint, symbol: token.symbol },
        buyVenue: buyQuote.venueId,
        sellVenue: sellQuote.venueId,
        startingAmountUsd: microToUsdString(amountMicroUsd),
        estimatedFinalUsd: microToUsdString(outcome.estimatedFinalMicroUsd),
        grossSpreadUsd: microToUsdString(outcome.grossSpreadMicroUsd),
        costs: {
          venueFeesUsd: microToUsdString(outcome.costs.venueFeesMicroUsd),
          networkFeesUsd: microToUsdString(outcome.costs.networkFeesMicroUsd),
          priceImpactUsd: microToUsdString(outcome.costs.priceImpactMicroUsd),
          safetyBufferUsd: microToUsdString(outcome.costs.safetyBufferMicroUsd),
          totalUsd: microToUsdString(outcome.costs.totalMicroUsd),
        },
        estimatedNetProfitUsd: microToUsdString(outcome.netProfitMicroUsd),
        estimatedReturnPct: (Number(outcome.returnBps) / 100).toFixed(2),
        isProfitable: outcome.isProfitable,
        warnings: outcome.warnings,
        providerFailures: comparison.providerFailures,
        quotes: {
          buyRetrievedAtMs: buyQuote.retrievedAtMs,
          sellRetrievedAtMs: sellQuote.retrievedAtMs,
          expiresAtMs: outcome.quoteExpiresAtMs,
        },
        status: "Paper calculation - no funds moved",
        executionEnabled: false,
      });
    } catch (err) {
      const arbErr = asArbError(err);
      res.status(arbErr.httpStatus).json({
        correlationId,
        error: arbErr.code,
        message: arbErr.message,
        details: arbErr.details ?? null,
        executionEnabled: false,
      });
    }
  });

  router.get("/v1/arbitrage/history", async (_req, res) => {
    const records = await store.list(50);
    res.json({
      records: records.map((r) => ({
        ...r,
        startingAmountUsd: microToUsdString(BigInt(r.startingAmountMicroUsd)),
        netProfitUsd: microToUsdString(BigInt(r.netProfitMicroUsd)),
      })),
    });
  });

  router.get("/v1/arbitrage/tokens", (_req, res) => {
    res.json({ tokens: listTokens().filter((t) => t.enabled) });
  });

  function requireAdmin(req: express.Request, res: express.Response): boolean {
    if (!adminToken || req.headers["x-admin-token"] !== adminToken) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return false;
    }
    return true;
  }

  const adminToggleSchema = z.object({ id: z.string(), enabled: z.boolean() });

  router.get("/admin/allowlist", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ tokens: listTokens(), venues: listVenues() });
  });

  router.post("/admin/tokens/toggle", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = adminToggleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
    const ok = setTokenEnabled(parsed.data.id, parsed.data.enabled);
    return res.status(ok ? 200 : 404).json({ ok });
  });

  router.post("/admin/venues/toggle", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = adminToggleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
    const ok = setVenueEnabled(parsed.data.id, parsed.data.enabled);
    return res.status(ok ? 200 : 404).json({ ok });
  });

  return router;
}
