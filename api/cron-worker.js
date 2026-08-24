/**
 * Vercel Cron entry point for Moonpaper's alerts and shadow paper bot.
 * The implementation lives in the typed backend and executes one bounded pass.
 */
import { createVercelCronHandler } from "../backend/dist/worker/vercel.js";

export default createVercelCronHandler();
