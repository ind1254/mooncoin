/**
 * Vercel serverless entry point for Moonpaper.
 * Wraps the same Express app the local server uses. Paper-trading only.
 *
 * Serverless caveats (fine for a demo deployment):
 *  - State lives in /tmp, which survives only while an instance stays warm;
 *    cold starts re-seed the demo portfolio.
 *  - There is no background tick; one notification pass runs per cold start.
 */
import { createApp, createDefaultDeps, runNotificationTick, seedIfDemo } from "../backend/dist/api/app.js";

process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/moonpaper";

const deps = createDefaultDeps();
seedIfDemo(deps);
runNotificationTick(deps).catch(() => undefined);

const app = createApp(deps);
export default app;
