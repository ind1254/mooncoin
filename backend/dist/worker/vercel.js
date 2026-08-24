import { timingSafeEqual } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { createScheduledWorkerRuntime } from "./runtime.js";
function headerValue(value) {
    return Array.isArray(value) ? value[0] : value;
}
/** Constant-time comparison after an exact length check. Missing/short secrets fail closed. */
export function isAuthorizedCronRequest(authorization, secret) {
    if (!secret || secret.length < 16 || !authorization)
        return false;
    const expected = Buffer.from(`Bearer ${secret}`, "utf8");
    const actual = Buffer.from(authorization, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/** Stable idempotency key for Vercel's one-minute schedule. */
export function cronRunKey(nowMs) {
    const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
    return `scheduled:${new Date(minuteMs).toISOString()}`;
}
/** Create the Node.js function handler used by api/cron-worker.js. */
export function createVercelCronHandler(options = {}) {
    const clock = options.clock ?? Date.now;
    const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
    const secret = options.secret ?? process.env.CRON_SECRET;
    const runtimeFactory = options.runtimeFactory ?? (() => createScheduledWorkerRuntime(loadEnv()));
    let runtimePromise;
    const getRuntime = () => {
        if (!runtimePromise) {
            runtimePromise = Promise.resolve()
                .then(runtimeFactory)
                .catch((err) => {
                runtimePromise = undefined;
                throw err;
            });
        }
        return runtimePromise;
    };
    return async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (req.method !== "GET") {
            res.setHeader("Allow", "GET");
            return res.status(405).json({
                ok: false,
                error: "METHOD_NOT_ALLOWED",
                simulationOnly: true,
                executionEnabled: false,
            });
        }
        if (!isAuthorizedCronRequest(headerValue(req.headers.authorization), secret)) {
            return res.status(401).json({
                ok: false,
                error: "UNAUTHORIZED",
                simulationOnly: true,
                executionEnabled: false,
            });
        }
        const runKey = cronRunKey(clock());
        try {
            const runtime = await getRuntime();
            const result = await runtime.run(runKey);
            const httpStatus = result.status === "failed" || result.failedComponents.length > 0 ? 503 : 200;
            return res.status(httpStatus).json({ ok: httpStatus === 200, ...result });
        }
        catch (err) {
            log({
                ts: new Date(clock()).toISOString(),
                level: "error",
                msg: "Vercel cron worker invocation failed",
                runKey,
                error: err instanceof Error ? err.message : String(err),
            });
            return res.status(503).json({
                ok: false,
                error: "WORKER_PASS_FAILED",
                runKey,
                simulationOnly: true,
                executionEnabled: false,
            });
        }
    };
}
