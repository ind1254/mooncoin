import { ArbError, asArbError } from "../core/errors.js";
import { baseUnitsToDecimalString, decimalToBaseUnits, microToUsdString, picoUsdToPriceString, returnBps, } from "../core/money.js";
import { LivePaperPositionRepository, PortfolioRepository, } from "../db/repositories.js";
import { USDC_MINT } from "../market/tradability.js";
const pct = (bps) => (Number(bps) / 100).toFixed(2);
function uniqueRouteLabels(quote) {
    return [...new Set(quote.routePlan.map((hop) => hop.ammLabel))];
}
function averagePricePicoUsd(valueMicroUsd, quantityBaseUnits, decimals) {
    if (quantityBaseUnits <= 0n)
        return 0n;
    return (valueMicroUsd * 1000000n * 10n ** BigInt(decimals)) / quantityBaseUnits;
}
function assertFreshQuote(quote, expectedInputMint, expectedOutputMint, expectedInputAmount, nowMs) {
    if (quote.inputMint !== expectedInputMint ||
        quote.outputMint !== expectedOutputMint ||
        quote.inAmount !== expectedInputAmount) {
        throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "The live quote did not match the requested trade.", 502);
    }
    if (quote.routePlan.length === 0 || quote.minOutAmount <= 0n) {
        throw new ArbError("QUOTE_UNAVAILABLE", "No executable paper route is available for this size right now.", 409);
    }
    if (nowMs >= quote.expiresAtMs) {
        throw new ArbError("STALE_QUOTE", "The live quote expired before the paper fill could be recorded.", 409);
    }
}
function paperPositionView(record, valuation) {
    const effectiveValuation = record.status === "closed"
        ? {
            status: "fresh",
            valueMicroUsd: record.closeProceedsMicroUsd,
            quote: null,
            detail: "Closed at the stored minimum-received value from the exit quote.",
        }
        : valuation ?? { status: "pending", valueMicroUsd: null, quote: null, detail: "Valuation not requested yet." };
    const pnlMicroUsd = record.status === "closed"
        ? record.realizedPnlMicroUsd
        : effectiveValuation.valueMicroUsd === null
            ? null
            : effectiveValuation.valueMicroUsd - record.entryCostMicroUsd;
    const returnPct = pnlMicroUsd === null ? null : pct(returnBps(pnlMicroUsd, record.entryCostMicroUsd));
    return {
        id: record.id,
        simulated: true,
        executionEnabled: false,
        status: record.status,
        token: {
            mint: record.tokenMint,
            symbol: record.tokenSymbol,
            name: record.tokenName,
            decimals: record.tokenDecimals,
        },
        quantity: baseUnitsToDecimalString(record.tokenQuantityBaseUnits, record.tokenDecimals),
        quantityBaseUnits: record.tokenQuantityBaseUnits.toString(),
        costBasisUsd: microToUsdString(record.entryCostMicroUsd),
        marketValueUsd: effectiveValuation.valueMicroUsd === null ? null : microToUsdString(effectiveValuation.valueMicroUsd),
        pnlUsd: pnlMicroUsd === null ? null : microToUsdString(pnlMicroUsd),
        returnPct,
        entry: {
            averagePriceUsd: picoUsdToPriceString(averagePricePicoUsd(record.entryCostMicroUsd, record.tokenQuantityBaseUnits, record.tokenDecimals)),
            priceImpactPct: pct(record.entryPriceImpactBps),
            slippagePct: pct(record.entrySlippageBps),
            route: record.entryRoute,
            source: record.entryQuoteSource,
            quoteRetrievedAtMs: record.entryQuoteRetrievedAtMs,
            quoteExpiresAtMs: record.entryQuoteExpiresAtMs,
        },
        valuation: {
            status: effectiveValuation.status,
            detail: effectiveValuation.detail,
            priceImpactPct: effectiveValuation.quote ? pct(effectiveValuation.quote.priceImpactBps) : null,
            route: effectiveValuation.quote ? uniqueRouteLabels(effectiveValuation.quote) : null,
            source: effectiveValuation.quote?.source ?? null,
            quoteRetrievedAtMs: effectiveValuation.quote?.retrievedAtMs ?? null,
            quoteExpiresAtMs: effectiveValuation.quote?.expiresAtMs ?? null,
        },
        exit: record.status === "closed"
            ? {
                proceedsUsd: microToUsdString(record.closeProceedsMicroUsd),
                averagePriceUsd: picoUsdToPriceString(averagePricePicoUsd(record.closeProceedsMicroUsd, record.tokenQuantityBaseUnits, record.tokenDecimals)),
                priceImpactPct: pct(record.exitPriceImpactBps),
                slippagePct: pct(record.exitSlippageBps),
                route: record.exitRoute,
                source: record.exitQuoteSource,
                quoteRetrievedAtMs: record.exitQuoteRetrievedAtMs,
                quoteExpiresAtMs: record.exitQuoteExpiresAtMs,
            }
            : null,
        openedAtMs: record.openedAtMs,
        closedAtMs: record.closedAtMs,
    };
}
/**
 * Authenticated paper execution against live, read-only Jupiter quotes.
 *
 * Entry reruns every production gate server-side. The simulated fill receives
 * Jupiter's minimum output, not its optimistic output. Closing asks for a new
 * exact-size token→USDC quote and credits only its minimum output. This module
 * has no wallet, transaction, signing, or submission dependency.
 */
export class LivePaperTradingService {
    db;
    tradability;
    quotes;
    config;
    clock;
    positions;
    portfolios;
    constructor(db, tradability, quotes, config, clock = Date.now) {
        this.db = db;
        this.tradability = tradability;
        this.quotes = quotes;
        this.config = config;
        this.clock = clock;
        this.positions = new LivePaperPositionRepository(db);
        this.portfolios = new PortfolioRepository(db);
    }
    parseEntryAmount(amountUsd) {
        if (!/^\d+(?:\.\d{1,2})?$/.test(amountUsd.trim())) {
            throw new ArbError("VALIDATION_ERROR", "Paper entry amount must use at most two decimal places.", 400);
        }
        let amount;
        try {
            amount = decimalToBaseUnits(amountUsd, 6);
        }
        catch (err) {
            throw new ArbError("VALIDATION_ERROR", err.message, 400);
        }
        if (amount < this.config.minTradeMicroUsd || amount > this.config.maxTradeMicroUsd) {
            throw new ArbError("AMOUNT_OUT_OF_RANGE", `Paper entries must be between $${microToUsdString(this.config.minTradeMicroUsd)} and $${microToUsdString(this.config.maxTradeMicroUsd)}.`, 400);
        }
        return amount;
    }
    async openPosition(userId, tokenMint, amountUsd, slippageBps, clientRequestId) {
        const amountMicroUsd = this.parseEntryAmount(amountUsd);
        const replay = await this.positions.findByClientRequestId(userId, clientRequestId);
        if (replay) {
            if (replay.tokenMint !== tokenMint ||
                replay.entryCostMicroUsd !== amountMicroUsd ||
                replay.entrySlippageBps !== slippageBps) {
                throw new ArbError("VALIDATION_ERROR", "That paper request id was already used for a different entry.", 409);
            }
            return paperPositionView(replay);
        }
        const check = await this.tradability.check(tokenMint, amountUsd, slippageBps);
        if (!check.eligible || !check.quote) {
            throw new ArbError("PAPER_TRADE_INELIGIBLE", "This token did not pass every required production gate for that paper entry.", 409, { verdict: check.verdict, blockingGateIds: check.blockingGateIds });
        }
        const nowMs = this.clock();
        const quote = check.quote;
        assertFreshQuote(quote, USDC_MINT, check.mint, amountMicroUsd, nowMs);
        if (quote.priceImpactBps > this.config.maxEntryPriceImpactBps) {
            throw new ArbError("PRICE_IMPACT_TOO_HIGH", "Price impact exceeds the paper-entry policy.", 409);
        }
        const record = await this.positions.open(userId, this.config.startingMicroUsd, this.config.maxOpenPositions, {
            clientRequestId,
            tokenMint: check.mint,
            tokenSymbol: check.symbol,
            tokenName: check.name,
            tokenDecimals: check.profile.decimals,
            // Conservative fill: the account receives only the slippage-adjusted
            // minimum, even though Jupiter's current estimate is higher.
            tokenQuantityBaseUnits: quote.minOutAmount,
            entryCostMicroUsd: amountMicroUsd,
            entrySlippageBps: quote.slippageBps,
            entryPriceImpactBps: quote.priceImpactBps,
            entryRoute: uniqueRouteLabels(quote),
            entryQuoteSource: quote.source,
            entryQuoteRetrievedAtMs: quote.retrievedAtMs,
            entryQuoteExpiresAtMs: quote.expiresAtMs,
            openedAtMs: nowMs,
        });
        return paperPositionView(record);
    }
    async closePosition(userId, positionId, slippageBps) {
        const existing = await this.positions.findOwned(userId, positionId);
        if (!existing)
            throw new ArbError("POSITION_NOT_FOUND", "Paper position not found", 404);
        if (existing.status === "closed") {
            throw new ArbError("POSITION_ALREADY_CLOSED", "This paper position is already closed", 409);
        }
        const quote = await this.quotes.getQuote({
            inputMint: existing.tokenMint,
            outputMint: USDC_MINT,
            amount: existing.tokenQuantityBaseUnits,
            slippageBps,
        });
        const nowMs = this.clock();
        assertFreshQuote(quote, existing.tokenMint, USDC_MINT, existing.tokenQuantityBaseUnits, nowMs);
        const closed = await this.positions.close(userId, positionId, {
            // USDC has six decimals, exactly matching the portfolio's micro-USD unit.
            closeProceedsMicroUsd: quote.minOutAmount,
            exitSlippageBps: quote.slippageBps,
            exitPriceImpactBps: quote.priceImpactBps,
            exitRoute: uniqueRouteLabels(quote),
            exitQuoteSource: quote.source,
            exitQuoteRetrievedAtMs: quote.retrievedAtMs,
            exitQuoteExpiresAtMs: quote.expiresAtMs,
            closedAtMs: nowMs,
        });
        return paperPositionView(closed);
    }
    async valueOpenPosition(record) {
        try {
            const quote = await this.quotes.getQuote({
                inputMint: record.tokenMint,
                outputMint: USDC_MINT,
                amount: record.tokenQuantityBaseUnits,
                slippageBps: record.entrySlippageBps,
            });
            assertFreshQuote(quote, record.tokenMint, USDC_MINT, record.tokenQuantityBaseUnits, this.clock());
            return {
                status: "fresh",
                valueMicroUsd: quote.minOutAmount,
                quote,
                detail: quote.priceImpactBps > this.config.maxEntryPriceImpactBps
                    ? "Live sell valuation is available, but its price impact is above the entry limit."
                    : "Valued at the minimum received from a fresh exact-size Jupiter sell quote.",
            };
        }
        catch (err) {
            return {
                status: "unavailable",
                valueMicroUsd: null,
                quote: null,
                detail: asArbError(err).message,
            };
        }
    }
    async getPortfolio(userId) {
        const portfolio = await this.portfolios.ensureDefault(userId, this.config.startingMicroUsd);
        const records = await this.positions.listForUser(userId);
        const open = records.filter((record) => record.status === "open");
        const valuations = await Promise.all(open.map((record) => this.valueOpenPosition(record)));
        const byId = new Map(open.map((record, index) => [record.id, valuations[index]]));
        const valuationComplete = valuations.every((valuation) => valuation.status === "fresh");
        const invested = open.reduce((sum, record) => sum + record.entryCostMicroUsd, 0n);
        const markedValue = valuationComplete
            ? valuations.reduce((sum, valuation) => sum + valuation.valueMicroUsd, 0n)
            : null;
        const unrealized = markedValue === null ? null : markedValue - invested;
        const realized = records.reduce((sum, record) => sum + (record.realizedPnlMicroUsd ?? 0n), 0n);
        const totalValue = markedValue === null ? null : portfolio.cashMicroUsd + markedValue;
        return {
            id: portfolio.id,
            name: portfolio.name,
            baseCurrency: portfolio.baseCurrency,
            simulated: true,
            executionEnabled: false,
            cashUsd: microToUsdString(portfolio.cashMicroUsd),
            startingCashUsd: microToUsdString(portfolio.startingMicroUsd),
            investedUsd: microToUsdString(invested),
            totalValueUsd: totalValue === null ? null : microToUsdString(totalValue),
            unrealizedPnlUsd: unrealized === null ? null : microToUsdString(unrealized),
            realizedPnlUsd: microToUsdString(realized),
            openPositions: open.length,
            closedPositions: records.length - open.length,
            valuationStatus: valuationComplete ? "fresh" : "unavailable",
            positions: records.map((record) => paperPositionView(record, byId.get(record.id))),
            createdAtMs: portfolio.createdAtMs,
            updatedAtMs: portfolio.updatedAtMs,
            limits: {
                minEntryUsd: microToUsdString(this.config.minTradeMicroUsd),
                maxEntryUsd: microToUsdString(this.config.maxTradeMicroUsd),
                maxOpenPositions: this.config.maxOpenPositions,
            },
            notice: "Simulation only. Entries and exits use read-only Jupiter quotes and never build, sign, or submit a transaction.",
        };
    }
}
