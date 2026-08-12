import { ArbError } from "../../core/errors.js";
import { readMintAccount } from "./mint.js";
/**
 * Overlays on-chain mint facts onto another risk provider.
 *
 * This is a decorator, not a replacement: it asks the base provider for all
 * six risk facts, then overrides only the two the chain can actually prove
 * (mint and freeze authority). Everything else passes through and stays
 * labelled with the base provider's source. That is what keeps demo mode
 * intact — live mode literally contains it.
 *
 * It never throws. A throttled or unreachable RPC endpoint must degrade to
 * "we could not verify this", not blank the page.
 */
export const SOLANA_MAINNET_SOURCE = "solana-rpc:mainnet";
export class OnChainMintRiskProvider {
    base;
    client;
    loader;
    catalogDecimals;
    clock;
    source;
    constructor(base, client, loader, catalogDecimals, clock = Date.now) {
        this.base = base;
        this.client = client;
        this.loader = loader;
        this.catalogDecimals = catalogDecimals;
        this.clock = clock;
        this.source = `${base.source} + ${SOLANA_MAINNET_SOURCE}`;
    }
    async getRiskFacts(mint) {
        const basePoint = await this.base.getRiskFacts(mint);
        const facts = { ...basePoint.value };
        // Start by attributing every field to the base provider, then move the
        // two we can prove over to the chain.
        const fieldSources = {
            tokenAgeDays: basePoint.source,
            holderConcentrationBps: basePoint.source,
            mintAuthorityRevoked: basePoint.source,
            freezeAuthorityRevoked: basePoint.source,
            recentInsiderActivity: basePoint.source,
            dataComplete: basePoint.source,
        };
        const verification = await this.verify(mint, facts, fieldSources);
        facts.onChainVerification = verification;
        // Observability: one structured line whenever we serve a labelled
        // fallback, so fallback frequency is diagnosable in production logs.
        if (verification.status !== "verified") {
            console.warn(JSON.stringify({
                ts: new Date(verification.checkedAtMs).toISOString(),
                msg: "on-chain verification fell back to simulated values",
                mint,
                status: verification.status,
                detail: verification.detail,
            }));
        }
        return {
            ...basePoint,
            value: facts,
            source: this.source,
            fieldSources,
        };
    }
    /**
     * Reads the mint account and mutates `facts`/`fieldSources` in place when
     * verification succeeds. Returns the verification record either way.
     */
    async verify(mint, facts, fieldSources) {
        const checkedAtMs = this.clock();
        const base = { source: SOLANA_MAINNET_SOURCE, checkedAtMs };
        let result;
        try {
            const cached = await this.loader.load(mint, () => readMintAccount(this.client, mint));
            result = cached.value;
        }
        catch (err) {
            // Transport, rate limit, or malformed envelope. Unknown is treated as
            // risk, consistent with how the scorer already handles missing inputs.
            facts.dataComplete = false;
            const detail = err instanceof ArbError && err.code === "PROVIDER_RATE_LIMITED"
                ? "Solana RPC rate limit reached; on-chain authorities could not be checked."
                : err instanceof ArbError
                    ? `Solana RPC unavailable (${err.code}); on-chain authorities could not be checked.`
                    : "Solana RPC unavailable; on-chain authorities could not be checked.";
            return { ...base, status: "unavailable", detail };
        }
        switch (result.status) {
            case "found": {
                // COption tag absent means the authority was renounced.
                facts.mintAuthorityRevoked = !result.mint.mintAuthorityPresent;
                facts.freezeAuthorityRevoked = !result.mint.freezeAuthorityPresent;
                fieldSources.mintAuthorityRevoked = SOLANA_MAINNET_SOURCE;
                fieldSources.freezeAuthorityRevoked = SOLANA_MAINNET_SOURCE;
                const declared = await this.catalogDecimals(mint);
                // Reported, deliberately not applied: quote math still uses the
                // catalog's decimals, and changing one without the other would
                // silently misscale every amount shown to the user.
                return {
                    ...base,
                    status: "verified",
                    decimalsOnChain: result.mint.decimals,
                    ...(declared !== undefined ? { decimalsMismatch: declared !== result.mint.decimals } : {}),
                };
            }
            case "not_found":
                facts.dataComplete = false;
                return {
                    ...base,
                    status: "not_found",
                    detail: "No account exists at this mint address on Solana mainnet.",
                };
            case "unsupported_program":
                facts.dataComplete = false;
                return { ...base, status: "unsupported_program", detail: result.reason };
            case "malformed":
                facts.dataComplete = false;
                return { ...base, status: "malformed", detail: result.reason };
        }
    }
}
