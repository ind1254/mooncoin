/**
 * Vercel serverless entry point for Moonpaper.
 * Wraps the same Express app the local server uses. Paper-trading only.
 *
 * Boot order matters here. Persistence is attached with a dynamic import so a
 * missing or unreachable database degrades the personal subsystem instead of
 * preventing the module from loading. A previous release imported the Postgres
 * driver at module scope; because the driver was absent from the deployed
 * bundle, the function crashed before Express existed and EVERY route returned
 * 500 — including endpoints that never touch a database.
 */
import { createApp, createDefaultDeps, initPersistence, runNotificationTick, seedIfDemo } from "../backend/dist/api/app.js";

// Legacy simulator state only. User data lives in Postgres, not here.
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/moonpaper";

const deps = createDefaultDeps();

// Awaited at module scope: the function is not served until dependencies are
// resolved, and a failure inside is caught and logged rather than thrown.
await initPersistence(deps);

seedIfDemo(deps);
runNotificationTick(deps).catch(() => undefined);

const app = createApp(deps);
export default app;
