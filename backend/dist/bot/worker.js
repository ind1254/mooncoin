import { randomUUID } from "node:crypto";
import { asArbError, ArbError } from "../core/errors.js";
import { microToUsdString } from "../core/money.js";
import { USDC_MINT } from "../market/tradability.js";
import { assessPaperBotCandidate, duplicateSymbolCounts, evaluatePaperBotExit, } from "./strategy.js";
export const MAX_BOT_CONFIGS_PER_PASS = 100;
export const MAX_ENTRY_ATTEMPTS_PER_CONFIG = 3;
const DECISION_DEDUP_MS = 15 * 60_000;
function ensureExitQuote(position, quote, nowMs) {
    if (quote.inputMint !== position.tokenMint ||
        quote.outputMint !== USDC_MINT ||
        quote.inAmount !== position.tokenQuantityBaseUnits) {
        throw new ArbError("MALFORMED_PROVIDER_RESPONSE", "The exit quote did not match the paper position.", 502);
    }
    if (quote.minOutAmount <= 0n || quote.routePlan.length === 0) {
        throw new ArbError("QUOTE_UNAVAILABLE", "No executable sell route is available for this paper position.", 409);
    }
    if (nowMs >= quote.expiresAtMs) {
        throw new ArbError("STALE_QUOTE", "The paper-bot exit quote expired before it could be evaluated.", 409);
    }
}
function candidateSnapshot(candidate) {
    const token = candidate.token;
    return {
        source: token.token.source,
        feed: "toptraded/5m",
        marketUpdatedAtMs: token.updatedAtMs,
        firstPoolAtMs: token.firstPoolAtMs,
        liquidityMicroUsd: token.token.market.liquidityUsdMicro?.toString() ?? null,
        pricePicoUsd: token.token.market.priceUsdPico?.toString() ?? null,
        priceChange5mBps: token.fiveMinutes.priceChangeBps?.toString() ?? null,
        volumeChange5mBps: token.fiveMinutes.volumeChangeBps?.toString() ?? null,
        traders5m: token.fiveMinutes.traders,
        assessment: candidate.assessment,
    };
}
async function recordDeduped(deps, config, action, tokenMint, input, nowMs) {
    if (await deps.decisions.hasRecentAction(config.id, tokenMint, action, nowMs - DECISION_DEDUP_MS))
        return;
    await deps.decisions.create(input);
}
async function evaluateOpenPositions(deps, config, summary, nowMs) {
    const open = await deps.positions.listOpenForBot(config.id);
    const paper = deps.createPaperTrading(config);
    let degraded = false;
    for (const position of open) {
        summary.positionsEvaluated++;
        try {
            const quote = await deps.quotes.getQuote({
                inputMint: position.tokenMint,
                outputMint: USDC_MINT,
                amount: position.tokenQuantityBaseUnits,
                slippageBps: config.slippageBps,
            });
            ensureExitQuote(position, quote, nowMs);
            const priorState = await deps.states.get(position.id);
            const previousHighWater = priorState?.highWaterValueMicroUsd ?? position.entryCostMicroUsd;
            const exit = evaluatePaperBotExit({
                entryCostMicroUsd: position.entryCostMicroUsd,
                currentValueMicroUsd: quote.minOutAmount,
                previousHighWaterMicroUsd: previousHighWater,
                openedAtMs: position.openedAtMs,
                nowMs,
                currentPriceImpactBps: quote.priceImpactBps,
                strategy: config,
            });
            await deps.states.recordValue(position.id, config.id, exit.highWaterValueMicroUsd, quote.minOutAmount, nowMs);
            if (!exit.shouldClose || !exit.reason)
                continue;
            const closed = await paper.closePosition(config.userId, position.id, config.slippageBps, {
                botConfigId: config.id,
            });
            await deps.states.markExited(position.id, exit.reason, nowMs);
            await deps.decisions.create({
                configId: config.id,
                positionId: position.id,
                tokenMint: position.tokenMint,
                tokenSymbol: position.tokenSymbol,
                action: "closed",
                reason: `Closed by ${exit.reason.replaceAll("_", " ")} using a fresh exact-size sell quote.`,
                snapshot: {
                    previewValueMicroUsd: quote.minOutAmount.toString(),
                    returnBps: exit.returnBps.toString(),
                    drawdownFromHighBps: exit.drawdownFromHighBps.toString(),
                    quotePriceImpactBps: quote.priceImpactBps.toString(),
                    closeResult: closed,
                },
                createdAtMs: nowMs,
            });
            summary.positionsClosed++;
        }
        catch (err) {
            degraded = true;
            summary.providerFailures++;
            const error = asArbError(err);
            await recordDeduped(deps, config, "exit_unavailable", position.tokenMint, {
                configId: config.id,
                positionId: position.id,
                tokenMint: position.tokenMint,
                tokenSymbol: position.tokenSymbol,
                action: "exit_unavailable",
                reason: `Could not evaluate an automatic exit: ${error.message}`,
                snapshot: { errorCode: error.code },
                createdAtMs: nowMs,
            }, nowMs);
        }
    }
    return { open: await deps.positions.listOpenForBot(config.id), degraded };
}
function candidatesFor(config, tokens, maxMarketAgeMs, nowMs) {
    const duplicates = duplicateSymbolCounts(tokens);
    return tokens
        .map((token) => assessPaperBotCandidate(token, duplicates.get(token.token.symbol.trim().toLowerCase()) ?? 1, config, maxMarketAgeMs, nowMs))
        .filter((candidate) => candidate.accepted)
        .sort((a, b) => b.assessment.qualityScore - a.assessment.qualityScore ||
        a.assessment.riskScore - b.assessment.riskScore);
}
async function attemptEntry(deps, config, currentOpen, tokens, summary, nowMs) {
    if (currentOpen.length >= config.maxOpenPositions)
        return { opened: false, rejected: 0 };
    const openMints = new Set(currentOpen.map((position) => position.tokenMint));
    const candidates = candidatesFor(config, tokens, deps.maxMarketAgeMs, nowMs);
    let rejected = 0;
    let attempted = 0;
    for (const candidate of candidates) {
        if (attempted >= MAX_ENTRY_ATTEMPTS_PER_CONFIG)
            break;
        const mint = candidate.token.token.mint;
        if (openMints.has(mint))
            continue;
        if (await deps.positions.hasBotPositionSince(config.id, mint, nowMs - config.cooldownMinutes * 60_000))
            continue;
        attempted++;
        try {
            const position = await deps.createPaperTrading(config).openPosition(config.userId, mint, microToUsdString(config.tradeSizeMicroUsd), config.slippageBps, randomUUID(), {
                openedBy: "paper_bot",
                botConfigId: config.id,
                maxBotOpenPositions: config.maxOpenPositions,
                minLiquidityMicroUsd: config.minLiquidityMicroUsd,
                maxRiskScore: config.maxRiskScore,
                maxEntryPriceImpactBps: config.maxPriceImpactBps,
            });
            const positionId = typeof position.id === "string" ? position.id : null;
            if (!positionId)
                throw new ArbError("INTERNAL_ERROR", "Paper entry did not return a position id.", 500);
            await deps.decisions.create({
                configId: config.id,
                positionId,
                tokenMint: mint,
                tokenSymbol: candidate.token.token.symbol,
                action: "opened",
                qualityScore: candidate.assessment.qualityScore,
                riskScore: candidate.assessment.riskScore,
                reason: "Opened after the trending prefilter and every production tradability gate passed.",
                snapshot: { ...candidateSnapshot(candidate), position },
                createdAtMs: nowMs,
            });
            summary.positionsOpened++;
            return { opened: true, rejected };
        }
        catch (err) {
            const error = asArbError(err);
            rejected++;
            await recordDeduped(deps, config, "entry_rejected", mint, {
                configId: config.id,
                tokenMint: mint,
                tokenSymbol: candidate.token.token.symbol,
                action: "entry_rejected",
                qualityScore: candidate.assessment.qualityScore,
                riskScore: candidate.assessment.riskScore,
                reason: `Production entry gates rejected this candidate: ${error.message}`,
                snapshot: { ...candidateSnapshot(candidate), errorCode: error.code },
                createdAtMs: nowMs,
            }, nowMs);
        }
    }
    if (candidates.length === 0) {
        await recordDeduped(deps, config, "scan_empty", null, {
            configId: config.id,
            action: "scan_empty",
            reason: "No trending token met every configured quality, risk, liquidity, and freshness prefilter.",
            snapshot: { feedSize: tokens.length },
            createdAtMs: nowMs,
        }, nowMs);
    }
    return { opened: false, rejected };
}
/** One bounded, auditable simulation pass. Never builds or submits a transaction. */
export async function runPaperBotPass(deps) {
    const startedAt = deps.clock?.() ?? Date.now();
    const summary = {
        configsProcessed: 0,
        positionsEvaluated: 0,
        positionsOpened: 0,
        positionsClosed: 0,
        providerFailures: 0,
        durationMs: 0,
    };
    const configs = await deps.configs.listEnabled(MAX_BOT_CONFIGS_PER_PASS);
    if (configs.length === 0) {
        summary.durationMs = (deps.clock?.() ?? Date.now()) - startedAt;
        return summary;
    }
    const state = new Map();
    for (const config of configs) {
        const nowMs = deps.clock?.() ?? Date.now();
        try {
            state.set(config.id, await evaluateOpenPositions(deps, config, summary, nowMs));
        }
        catch (err) {
            summary.providerFailures++;
            state.set(config.id, { open: [], degraded: true });
            const error = asArbError(err);
            await recordDeduped(deps, config, "error", null, {
                configId: config.id,
                action: "error",
                reason: `Paper-bot position evaluation failed: ${error.message}`,
                snapshot: { errorCode: error.code },
                createdAtMs: nowMs,
            }, nowMs);
        }
    }
    const needsEntryScan = configs.some((config) => {
        const evaluated = state.get(config.id);
        return !evaluated || evaluated.open.length < config.maxOpenPositions;
    });
    let tokens = [];
    if (needsEntryScan) {
        try {
            tokens = (await deps.feed.getFeed("trending")).tokens;
        }
        catch (err) {
            tokens = null;
            summary.providerFailures++;
            deps.log?.({ level: "warn", msg: "paper bot trending feed unavailable", error: asArbError(err).message });
        }
    }
    for (const config of configs) {
        summary.configsProcessed++;
        const nowMs = deps.clock?.() ?? Date.now();
        const evaluated = state.get(config.id) ?? { open: [], degraded: true };
        let degraded = evaluated.degraded || tokens === null;
        let runSummary;
        if (tokens === null) {
            runSummary = `Evaluated ${evaluated.open.length} open bot positions; trending feed unavailable, so no entries were attempted.`;
        }
        else {
            try {
                const entry = await attemptEntry(deps, config, evaluated.open, tokens, summary, nowMs);
                runSummary = entry.opened
                    ? `Evaluated ${evaluated.open.length} open positions and opened one simulated position.`
                    : `Evaluated ${evaluated.open.length} open positions; opened none (${entry.rejected} exact-gate rejection${entry.rejected === 1 ? "" : "s"}).`;
            }
            catch (err) {
                degraded = true;
                summary.providerFailures++;
                const error = asArbError(err);
                runSummary = `Entry evaluation failed safely: ${error.message}`;
                await recordDeduped(deps, config, "error", null, {
                    configId: config.id,
                    action: "error",
                    reason: runSummary,
                    snapshot: { errorCode: error.code },
                    createdAtMs: nowMs,
                }, nowMs);
            }
        }
        await deps.configs.markRun(config.id, degraded ? "degraded" : "ok", runSummary, nowMs);
    }
    summary.durationMs = (deps.clock?.() ?? Date.now()) - startedAt;
    return summary;
}
