import { createApp, createDefaultDeps, runNotificationTick, seedIfDemo } from "./app.js";

/**
 * FOMO Paper Trader — server entry point.
 * Paper trading only: no execution path exists anywhere in this process.
 */

const deps = createDefaultDeps();
seedIfDemo(deps);

const app = createApp(deps);
const port = deps.env.PORT;

app.listen(port, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: `fomo-paper-trader listening on :${port}`,
      marketMode: deps.env.MARKET_MODE,
      legacyQuoteMode: deps.env.QUOTE_MODE,
      dataSource: deps.market.bundle.dataSourceLabel,
      executionEnabled: false,
    }),
  );
});

// Periodic pass: revalue open paper positions and evaluate notification rules
const TICK_MS = 30_000;
setInterval(() => {
  runNotificationTick(deps).catch((err) =>
    console.error(JSON.stringify({ msg: "notification tick failed", error: String(err) })),
  );
}, TICK_MS).unref();

// Prime rule-engine baselines shortly after boot so change-based alerts work
setTimeout(() => {
  runNotificationTick(deps).catch(() => undefined);
}, 2_000).unref();
