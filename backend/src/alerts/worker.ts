import type { ResearchProfile, ResearchService } from "../market/research.js";
import type {
  AlertEventRepository,
  AlertRuleRepository,
  AlertRuleStateRepository,
  TokenObservationRepository,
} from "../db/repositories.js";
import { evaluateRule } from "./engine.js";
import { buildObservation, snapshotFromProfile, type TokenSnapshot } from "./observations.js";

/**
 * One evaluation pass over every enabled rule.
 *
 * The shape that matters here is FETCH PER MINT, NOT PER RULE. Five hundred
 * users watching BONK is one research call, not five hundred: rules are
 * resolved to (rule, mint) pairs, grouped by mint, and each token is fetched
 * exactly once per pass. Getting this backwards is the difference between a
 * worker that costs a few RPC credits a minute and one that cannot run at all.
 *
 * Isolation is the other rule. One unreachable token, one malformed provider
 * response, one mint that no longer exists must not end the pass for everyone
 * else — so every per-mint and per-rule step is individually guarded.
 */

export interface AlertWorkerDeps {
  research: Pick<ResearchService, "getProfile">;
  rules: AlertRuleRepository;
  states: AlertRuleStateRepository;
  events: AlertEventRepository;
  observations: TokenObservationRepository;
  clock: () => number;
  /** Injected so tests do not have to silence real logging. */
  log?: (line: Record<string, unknown>) => void;
}

export interface AlertPassSummary {
  mintsExamined: number;
  mintsFailed: number;
  rulesEvaluated: number;
  alertsFired: number;
  durationMs: number;
}

/** Bounds one pass so a runaway watchlist cannot make it unbounded. */
export const MAX_MINTS_PER_PASS = 200;

export async function runAlertPass(deps: AlertWorkerDeps): Promise<AlertPassSummary> {
  const startedAt = deps.clock();
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));

  const resolved = await deps.rules.resolveEnabled();
  if (resolved.length === 0) {
    return { mintsExamined: 0, mintsFailed: 0, rulesEvaluated: 0, alertsFired: 0, durationMs: 0 };
  }

  // Group first, fetch second. This is the whole efficiency story.
  const byMint = new Map<string, typeof resolved>();
  for (const item of resolved) {
    const bucket = byMint.get(item.mint);
    if (bucket) bucket.push(item);
    else byMint.set(item.mint, [item]);
  }

  const mints = [...byMint.keys()].slice(0, MAX_MINTS_PER_PASS);
  const previous = await deps.observations.getMany(mints);

  let mintsFailed = 0;
  let rulesEvaluated = 0;
  let alertsFired = 0;

  for (const mint of mints) {
    const nowMs = deps.clock();

    let profile: ResearchProfile;
    try {
      profile = await deps.research.getProfile(mint);
    } catch (err) {
      // A token that cannot be read this pass is skipped, not zeroed. Its
      // snapshot is left alone so the next successful read diffs against real
      // history rather than against a gap.
      mintsFailed += 1;
      log({
        ts: new Date(nowMs).toISOString(),
        msg: "alert pass could not read token",
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const current: TokenSnapshot = snapshotFromProfile(profile, nowMs);
    const observation = buildObservation(current, previous.get(mint) ?? null, profile.symbol);

    for (const { rule } of byMint.get(mint) ?? []) {
      rulesEvaluated += 1;
      try {
        const prior = await deps.states.get(rule.id, mint);
        const result = evaluateRule(rule, observation, prior, nowMs);

        if (result.fired) {
          await deps.events.insert(result.fired, nowMs);
          alertsFired += 1;
        }
        // Null means the input was unavailable: leave stored state exactly as
        // it is, or the next good read would look like a fresh crossing.
        if (result.nextState !== null) {
          await deps.states.put(rule.id, mint, result.nextState, nowMs);
        }
      } catch (err) {
        log({
          ts: new Date(nowMs).toISOString(),
          msg: "alert rule evaluation failed",
          ruleId: rule.id,
          mint,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Written after evaluation, so this pass compares against the previous
    // snapshot rather than against itself.
    try {
      await deps.observations.put(current, nowMs);
    } catch (err) {
      log({
        ts: new Date(nowMs).toISOString(),
        msg: "snapshot write failed",
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    mintsExamined: mints.length,
    mintsFailed,
    rulesEvaluated,
    alertsFired,
    durationMs: deps.clock() - startedAt,
  };
}
