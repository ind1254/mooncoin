import { describe, expect, it, vi } from "vitest";
import type { AlertWorkerDeps } from "../src/alerts/worker.js";
import type { PaperBotWorkerDeps } from "../src/bot/worker.js";
import { runScheduledWorkerPass, type ScheduledWorkerPassResult } from "../src/worker/pass.js";
import {
  createVercelCronHandler,
  cronRunKey,
  isAuthorizedCronRequest,
} from "../src/worker/vercel.js";

const NOW = 1_760_000_012_345;

function emptyAlertDeps(overrides: Record<string, unknown> = {}): AlertWorkerDeps {
  return {
    research: {} as AlertWorkerDeps["research"],
    rules: { resolveEnabled: async () => [] } as unknown as AlertWorkerDeps["rules"],
    states: {} as AlertWorkerDeps["states"],
    events: {} as AlertWorkerDeps["events"],
    observations: {} as AlertWorkerDeps["observations"],
    clock: () => NOW,
    ...overrides,
  };
}

function emptyBotDeps(): PaperBotWorkerDeps {
  return {
    configs: { listEnabled: async () => [], markRun: async () => undefined },
    positions: {} as PaperBotWorkerDeps["positions"],
    states: {} as PaperBotWorkerDeps["states"],
    decisions: {} as PaperBotWorkerDeps["decisions"],
    feed: {} as PaperBotWorkerDeps["feed"],
    quotes: {} as PaperBotWorkerDeps["quotes"],
    createPaperTrading: () => ({}) as ReturnType<PaperBotWorkerDeps["createPaperTrading"]>,
    maxMarketAgeMs: 300_000,
    clock: () => NOW,
  };
}

function completedResult(runKey: string): ScheduledWorkerPassResult {
  return {
    runKey,
    status: "completed",
    reason: "ran",
    startedAtMs: NOW,
    completedAtMs: NOW,
    durationMs: 0,
    alert: { mintsExamined: 0, mintsFailed: 0, rulesEvaluated: 0, alertsFired: 0, durationMs: 0 },
    bot: {
      configsProcessed: 0,
      positionsEvaluated: 0,
      positionsOpened: 0,
      positionsClosed: 0,
      providerFailures: 0,
      durationMs: 0,
    },
    failedComponents: [],
    simulationOnly: true,
    executionEnabled: false,
  };
}

describe("scheduled worker pass", () => {
  it("does no work when another invocation owns the lease", async () => {
    const complete = vi.fn();
    const result = await runScheduledWorkerPass(
      {
        alerts: emptyAlertDeps({ rules: { resolveEnabled: vi.fn() } }),
        bot: emptyBotDeps(),
        leases: { tryAcquire: async () => false, complete },
        clock: () => NOW,
        log: () => undefined,
      },
      "minute-1",
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("duplicate_or_active");
    expect(complete).not.toHaveBeenCalled();
  });

  it("runs alerts and the paper bot once and releases the lease", async () => {
    const complete = vi.fn(async () => true);
    const result = await runScheduledWorkerPass(
      {
        alerts: emptyAlertDeps(),
        bot: emptyBotDeps(),
        leases: { tryAcquire: async () => true, complete },
        clock: () => NOW,
        log: () => undefined,
      },
      "minute-1",
    );

    expect(result.status).toBe("completed");
    expect(result.alert?.rulesEvaluated).toBe(0);
    expect(result.bot?.configsProcessed).toBe(0);
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "completed",
      expect.objectContaining({ executionEnabled: false, runKey: "minute-1" }),
      NOW,
    );
  });

  it("continues to the paper bot if the alert subsystem fails", async () => {
    const complete = vi.fn(async () => true);
    const result = await runScheduledWorkerPass(
      {
        alerts: emptyAlertDeps({ rules: { resolveEnabled: async () => { throw new Error("alerts down"); } } }),
        bot: emptyBotDeps(),
        leases: { tryAcquire: async () => true, complete },
        clock: () => NOW,
        log: () => undefined,
      },
      "minute-1",
    );

    expect(result.status).toBe("degraded");
    expect(result.failedComponents).toEqual(["alerts"]);
    expect(result.bot?.configsProcessed).toBe(0);
  });
});

describe("Vercel cron handler", () => {
  const secret = "a-strong-cron-secret";

  function responseRecorder() {
    const record = { status: 0, body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
    const response = {
      setHeader: (name: string, value: string) => { record.headers[name] = value; },
      status: (code: number) => { record.status = code; return response; },
      json: (body: Record<string, unknown>) => { record.body = body; return body; },
    };
    return { record, response };
  }

  it("fails closed without the exact bearer secret", () => {
    expect(isAuthorizedCronRequest(undefined, secret)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${secret}`, "short")).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("uses one stable idempotency key per UTC minute", () => {
    expect(cronRunKey(NOW)).toBe(cronRunKey(NOW + 10_000));
    expect(cronRunKey(NOW)).not.toBe(cronRunKey(NOW + 60_000));
  });

  it("rejects unauthorized calls before initializing the runtime", async () => {
    const factory = vi.fn();
    const handler = createVercelCronHandler({ secret, clock: () => NOW, runtimeFactory: factory, log: () => undefined });
    const { record, response } = responseRecorder();

    await handler({ method: "GET", headers: {} }, response);

    expect(record.status).toBe(401);
    expect(record.body).toMatchObject({ error: "UNAUTHORIZED", executionEnabled: false });
    expect(factory).not.toHaveBeenCalled();
  });

  it("runs an authorized GET and returns the simulation result", async () => {
    const run = vi.fn(async (runKey: string) => completedResult(runKey));
    const handler = createVercelCronHandler({
      secret,
      clock: () => NOW,
      runtimeFactory: () => ({ run, close: async () => undefined }),
      log: () => undefined,
    });
    const { record, response } = responseRecorder();

    await handler({ method: "GET", headers: { authorization: `Bearer ${secret}` } }, response);

    expect(record.status).toBe(200);
    expect(record.body).toMatchObject({ ok: true, status: "completed", executionEnabled: false });
    expect(run).toHaveBeenCalledWith(cronRunKey(NOW));
  });
});
