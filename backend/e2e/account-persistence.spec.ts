import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

test("restores account settings and saved coins after refresh and a new login", async ({ page }) => {
  const email = `resume-${randomUUID()}@example.com`;
  const password = "correct horse battery";

  await page.goto("/");
  await expect(page).toHaveTitle(/Moonpaper/);
  await expect(page.getByRole("button", { name: "Research" })).toBeVisible();

  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Create one" }).click();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPass").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#sSize")).toBeVisible();
  await page.locator("#sSize").fill("22.5");
  await page.locator("#sRisk").selectOption("conservative");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved to your account")).toBeVisible();

  const addWatch = await page.evaluate(async (mint) => {
    const response = await fetch("/v1/me/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenMint: mint }),
    });
    return response.status;
  }, BONK);
  expect(addWatch).toBe(201);

  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#sSize")).toHaveValue("22.5");
  await expect(page.locator("#sRisk")).toHaveValue("conservative");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPass").fill(password);
  await page.locator("#authSubmit").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#sSize")).toHaveValue("22.5");
  await expect(page.locator("#sRisk")).toHaveValue("conservative");
  const savedMints = await page.evaluate(async () => {
    const response = await fetch("/v1/me/watchlist");
    const body = await response.json();
    return body.items.map((item: { tokenMint: string }) => item.tokenMint);
  });
  expect(savedMints).toContain(BONK);
});
