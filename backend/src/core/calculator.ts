import { bpsOfCeil, returnBps } from "./money.js";
import type { CalculationInput, CalculationOutcome, CostBreakdown } from "./types.js";
import { evaluateRisk, REJECTION_CODES } from "./riskRules.js";

/**
 * Deterministic profit engine (ARB-001).
 *
 * Model: executable sell proceeds (`sellQuote.outAmount`) already embed venue fees
 * and price impact — that is what "executable quote" means. So:
 *
 *   net    = final − start − networkFees − safetyBuffer
 *   gross  = net + total costs   (spread before any cost)
 *
 * Venue fees and measured impact appear in the cost breakdown for transparency,
 * and gross is reconstructed by adding them back, keeping the identity
 * `net = gross − totalCosts` exact in integer microUsd.
 */
export function calculate(input: CalculationInput): CalculationOutcome {
  const { buyQuote, sellQuote, startingAmountMicroUsd: start } = input;

  const estimatedFinal = sellQuote.outAmount;

  const venueFees = buyQuote.feeMicroUsd + sellQuote.feeMicroUsd;
  const impactCost = bpsOfCeil(start, buyQuote.priceImpactBps + sellQuote.priceImpactBps);
  const safetyBuffer = bpsOfCeil(start, input.safetyBufferBps);
  const networkFees = input.networkFeeMicroUsd;

  const costs: CostBreakdown = {
    venueFeesMicroUsd: venueFees,
    networkFeesMicroUsd: networkFees,
    priceImpactMicroUsd: impactCost,
    safetyBufferMicroUsd: safetyBuffer,
    totalMicroUsd: venueFees + networkFees + impactCost + safetyBuffer,
  };

  const netProfit = estimatedFinal - start - networkFees - safetyBuffer;
  const grossSpread = netProfit + costs.totalMicroUsd;

  const warnings = evaluateRisk(input, netProfit);
  const hasRejection = warnings.some((w) => REJECTION_CODES.has(w));

  return {
    grossSpreadMicroUsd: grossSpread,
    estimatedFinalMicroUsd: estimatedFinal,
    costs,
    netProfitMicroUsd: netProfit,
    returnBps: returnBps(netProfit, start),
    isProfitable: netProfit > 0n && !hasRejection,
    warnings,
    quoteExpiresAtMs: Math.min(buyQuote.expiresAtMs, sellQuote.expiresAtMs),
  };
}
