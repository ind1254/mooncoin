import { assessLiveFeedToken, type LiveFeedAssessment } from "./feedAssessment.js";
import type { LiveFeedKind, LiveFeedToken } from "./jupiter/liveFeed.js";
import type { TradabilityPolicy } from "./tradability.js";
import type { AutoWatchRepository } from "../db/repositories.js";

/**
 * Promotes graduated tokens onto the auto-watch shelf.
 *
 * The discovery feed hides graduated tokens using the assessment's own
 * `graduated` flag, which is pure and needs no database. This pass is the
 * durable half: it records what graduated and when, so a token that later
 * drops out of the provider's trending feed does not silently vanish from the
 * shelf too.
 *
 * Both halves read the same predicate from `feedAssessment.ts`, so ranking and
 * persistence cannot disagree about what has graduated.
 *
 * Simulation-only, like everything else in the worker: this writes a research
 * shelf and never touches a position, a portfolio, or a user's own watchlist.
 */
export interface GraduationWorkerDeps {
  getFeed(kind: LiveFeedKind, signal?: AbortSignal): Promise<{ tokens: LiveFeedToken[] }>;
  autoWatch: AutoWatchRepository;
  policy: TradabilityPolicy;
  clock?: () => number;
  /** Feeds to sweep. Trending is where established coins accumulate. */
  kinds?: LiveFeedKind[];
}

export interface GraduationPassSummary {
  scanned: number;
  promoted: number;
  byReason: { market_maturity: number; quality_threshold: number };
}

export async function runGraduationPass(
  deps: GraduationWorkerDeps,
): Promise<GraduationPassSummary> {
  const clock = deps.clock ?? Date.now;
  const kinds = deps.kinds ?? (["trending", "recent"] as LiveFeedKind[]);
  const summary: GraduationPassSummary = {
    scanned: 0,
    promoted: 0,
    byReason: { market_maturity: 0, quality_threshold: 0 },
  };

  // One mint can appear in more than one feed; promote it once per pass.
  const seen = new Set<string>();

  for (const kind of kinds) {
    const feed = await deps.getFeed(kind);
    const nowMs = clock();

    // Duplicate-symbol counting mirrors the feed route: a ticker shared by
    // several mints is a risk signal, and the assessment needs the count.
    const symbolMints = new Map<string, Set<string>>();
    for (const item of feed.tokens) {
      const key = item.token.symbol.toLowerCase();
      const mints = symbolMints.get(key) ?? new Set<string>();
      mints.add(item.token.mint);
      symbolMints.set(key, mints);
    }

    for (const item of feed.tokens) {
      summary.scanned += 1;
      if (seen.has(item.token.mint)) continue;

      const assessment: LiveFeedAssessment = assessLiveFeedToken(
        item,
        nowMs,
        deps.policy,
        symbolMints.get(item.token.symbol.toLowerCase())?.size ?? 1,
      );
      if (!assessment.graduated || assessment.graduationReason === null) continue;

      seen.add(item.token.mint);
      await deps.autoWatch.promote({
        tokenMint: item.token.mint,
        reason: assessment.graduationReason,
        symbol: item.token.symbol,
        name: item.token.name,
        qualityScore: assessment.qualityScore,
        riskScore: assessment.riskScore,
        scoreVersion: assessment.scoreVersion,
      });
      summary.promoted += 1;
      summary.byReason[assessment.graduationReason] += 1;
    }
  }

  return summary;
}
