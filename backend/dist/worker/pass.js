import { randomUUID } from "node:crypto";
import { runGraduationPass } from "../market/graduation.js";
import { runAlertPass } from "../alerts/worker.js";
import { runPaperBotPass } from "../bot/worker.js";
export const SCHEDULED_WORKER_NAME = "alerts-and-shadow-paper-bot-v1";
/** Longer than Fluid Compute's five-minute default, so a timed-out pass cannot overlap. */
export const SCHEDULED_WORKER_LEASE_MS = 6 * 60_000;
function completionStatus(result) {
    if (result.failedComponents.length === 2)
        return "failed";
    if (result.failedComponents.length > 0 ||
        (result.alert?.mintsFailed ?? 0) > 0 ||
        (result.bot?.providerFailures ?? 0) > 0) {
        return "degraded";
    }
    return "completed";
}
/**
 * Run one bounded alert + simulation pass.
 *
 * The database claim happens before any provider call or paper write. A
 * duplicate scheduled minute or a concurrent invocation returns safely without
 * touching application state.
 */
export async function runScheduledWorkerPass(deps, runKey) {
    const clock = deps.clock ?? Date.now;
    const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
    const startedAtMs = clock();
    const ownerId = randomUUID();
    const acquired = await deps.leases.tryAcquire(SCHEDULED_WORKER_NAME, ownerId, runKey, startedAtMs, SCHEDULED_WORKER_LEASE_MS);
    if (!acquired) {
        log({
            ts: new Date(startedAtMs).toISOString(),
            msg: "scheduled worker pass skipped",
            runKey,
            reason: "duplicate_or_active",
        });
        return {
            runKey,
            status: "skipped",
            reason: "duplicate_or_active",
            startedAtMs,
            completedAtMs: startedAtMs,
            durationMs: 0,
            alert: null,
            bot: null,
            graduation: null,
            failedComponents: [],
            simulationOnly: true,
            executionEnabled: false,
        };
    }
    let alert = null;
    let bot = null;
    let graduation = null;
    const failedComponents = [];
    try {
        alert = await runAlertPass(deps.alerts);
    }
    catch (err) {
        failedComponents.push("alerts");
        log({
            ts: new Date(clock()).toISOString(),
            level: "error",
            msg: "scheduled alert pass failed",
            runKey,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        bot = await runPaperBotPass(deps.bot);
    }
    catch (err) {
        failedComponents.push("paper_bot");
        log({
            ts: new Date(clock()).toISOString(),
            level: "error",
            msg: "scheduled paper-bot pass failed",
            runKey,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    if (deps.graduation) {
        try {
            graduation = await runGraduationPass(deps.graduation);
        }
        catch (err) {
            failedComponents.push("graduation");
            log({
                ts: new Date(clock()).toISOString(),
                level: "error",
                msg: "scheduled graduation pass failed",
                runKey,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    const completedAtMs = clock();
    const result = {
        runKey,
        status: "completed",
        reason: "ran",
        startedAtMs,
        completedAtMs,
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        alert,
        bot,
        graduation,
        failedComponents,
        simulationOnly: true,
        executionEnabled: false,
    };
    result.status = completionStatus(result);
    const released = await deps.leases.complete(SCHEDULED_WORKER_NAME, ownerId, result.status, {
        runKey,
        durationMs: result.durationMs,
        alert,
        bot,
        failedComponents,
        simulationOnly: true,
        executionEnabled: false,
    }, completedAtMs);
    if (!released) {
        throw new Error("Scheduled worker lease ownership was lost before completion.");
    }
    log({
        ts: new Date(completedAtMs).toISOString(),
        msg: "scheduled worker pass complete",
        ...result,
    });
    return result;
}
