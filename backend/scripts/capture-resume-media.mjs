import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(scriptDir, "../../docs/media");
const baseUrl = process.env.MOONPAPER_BASE_URL ?? "http://127.0.0.1:8787";

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const video = page.video();

async function pause(milliseconds) {
  await page.waitForTimeout(milliseconds);
}

async function nav(label) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await pause(2_500);
}

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.locator(".live-feed-head").waitFor({ timeout: 45_000 });
await pause(4_000);
await page.screenshot({ path: resolve(outputDir, "research.png"), fullPage: false });

await page.mouse.wheel(0, 620);
await pause(4_000);
await page.mouse.wheel(0, 620);
await pause(4_000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await pause(3_000);

await nav("Engineering");
await page.screenshot({ path: resolve(outputDir, "engineering.png"), fullPage: false });
await page.mouse.wheel(0, 650);
await pause(4_000);
await page.mouse.wheel(0, 650);
await pause(4_000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await pause(3_000);

await nav("Watchlist");
await pause(4_000);
await nav("Demo Sandbox");
await page.mouse.wheel(0, 520);
await pause(4_000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await pause(2_000);

await nav("Research");
await page.getByRole("tab", { name: "Newest", exact: true }).click();
await pause(5_000);
await page.mouse.wheel(0, 420);
await pause(4_000);

await context.close();
if (video) {
  await video.saveAs(resolve(outputDir, "moonpaper-demo.webm"));
  await video.delete();
}
await browser.close();

console.log(`Captured Moonpaper screenshots and demo video from ${baseUrl}`);
