import express from "express";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Cloud calculation API (ARB-005). Calculation-only by design:
 * there is no code path that signs, submits, or authorizes a transaction,
 * and every response carries executionEnabled: false (FR-08).
 */

const app = express();
app.use(express.json({ limit: "16kb" }));

const store = new InMemoryPaperStore();

// Mock mode runs fully offline with a deterministic inter-venue spread.
// Enable via `npm run dev:mock` (works in any shell) or QUOTE_MODE=mock.
const useMock = process.env.QUOTE_MODE === "mock" || process.argv.includes("--mock");
function buildAdapters(): QuoteAdapter[] {
  if (useMock) {
    return [
      new MockVenueAdapter("raydium", 1_400n), // $0.0014 / token
      new MockVenueAdapter("orca", 1_420n), // ~1.4% higher sell venue
    ];
  }
  return Object.entries(VENUE_DEX_LABELS).map(
    ([venueId, labels]) => new JupiterVenueAdapter(venueId, labels),
  );
}

/** Correlation ID + structured request logging (FR-09). */
app.use((req, res, next) => {
  const correlationId = (req.headers["x-correlation-id"] as string) || randomUUID();
  res.locals.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        correlationId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });
  next();
});

const calculateSchema = z.object({
  tokenMint: z.string().min(32).max(64),
  startingAmountUsd: z.number(),
  preferredVenues: z.array(z.string()).min(2).max(4).optional(),
});

app.post("/v1/arbitrage/calculate", async (req, res) => {
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
    if (
      startingAmountUsd < AMOUNT_LIMITS.minUsd ||
      startingAmountUsd > AMOUNT_LIMITS.maxUsd
    ) {
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

    const comparison = await findBestRoundTrip(
      token,
      amountMicroUsd,
      adapters,
      DEFAULT_CONFIG,
      abort.signal,
    );
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

app.get("/v1/arbitrage/history", async (_req, res) => {
  const records = await store.list(50);
  res.json({
    records: records.map((r) => ({
      ...r,
      startingAmountUsd: microToUsdString(BigInt(r.startingAmountMicroUsd)),
      netProfitUsd: microToUsdString(BigInt(r.netProfitMicroUsd)),
    })),
  });
});

app.get("/v1/arbitrage/tokens", (_req, res) => {
  res.json({ tokens: listTokens().filter((t) => t.enabled) });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, quoteMode: useMock ? "mock" : "jupiter" });
});

// Browser demo of the iOS feature (../../../demo), served same-origin
const demoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "demo");
app.use("/demo", express.static(demoDir));

/** Admin allowlist control (FR-10). Requires ADMIN_TOKEN env var in any real deployment. */
function requireAdmin(req: express.Request, res: express.Response): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.headers["x-admin-token"] !== token) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

app.get("/admin/allowlist", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ tokens: listTokens(), venues: listVenues() });
});

const adminToggleSchema = z.object({ id: z.string(), enabled: z.boolean() });

app.post("/admin/tokens/toggle", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const parsed = adminToggleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const ok = setTokenEnabled(parsed.data.id, parsed.data.enabled);
  return res.status(ok ? 200 : 404).json({ ok });
});

app.post("/admin/venues/toggle", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const parsed = adminToggleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const ok = setVenueEnabled(parsed.data.id, parsed.data.enabled);
  return res.status(ok ? 200 : 404).json({ ok });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: `fomo-arbitrage-backend listening on :${port}`,
      quoteMode: useMock ? "mock" : "jupiter",
      executionEnabled: false,
    }),
  );
});
