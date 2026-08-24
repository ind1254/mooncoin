import { timingSafeEqual } from "node:crypto";
import { loadEnv } from "../config/env.js";
import type { ScheduledWorkerPassResult } from "./pass.js";
import { createScheduledWorkerRuntime, type ScheduledWorkerRuntime } from "./runtime.js";

interface VercelCronRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface VercelCronResponse {
  setHeader(name: string, value: string): void;
  status(code: number): VercelCronResponse;
  json(body: Record<string, unknown>): unknown;
}

export interface VercelCronHandlerOptions {
  secret?: string;
  clock?: () => number;
  runtimeFactory?: () => ScheduledWorkerRuntime | Promise<ScheduledWorkerRuntime>;
  log?: (line: Record<string, unknown>) => void;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time comparison after an exact length check. Missing/short secrets fail closed. */
export function isAuthorizedCronRequest(authorization: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(authorization, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Stable idempotency key for Vercel's one-minute schedule. */
export function cronRunKey(nowMs: number): string {
  const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
  return `scheduled:${new Date(minuteMs).toISOString()}`;
}

/** Create the Node.js function handler used by api/cron-worker.js. */
export function createVercelCronHandler(options: VercelCronHandlerOptions = {}) {
  const clock = options.clock ?? Date.now;
  const log = options.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const secret = options.secret ?? process.env.CRON_SECRET;
  const runtimeFactory =
    options.runtimeFactory ?? (() => createScheduledWorkerRuntime(loadEnv()));
  let runtimePromise: Promise<ScheduledWorkerRuntime> | undefined;

  const getRuntime = (): Promise<ScheduledWorkerRuntime> => {
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

  return async (req: VercelCronRequest, res: VercelCronResponse): Promise<unknown> => {
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
      const result: ScheduledWorkerPassResult = await runtime.run(runKey);
      const httpStatus = result.status === "failed" || result.failedComponents.length > 0 ? 503 : 200;
      return res.status(httpStatus).json({ ok: httpStatus === 200, ...result });
    } catch (err) {
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
