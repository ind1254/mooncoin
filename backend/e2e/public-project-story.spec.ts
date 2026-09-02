import { expect, test } from "@playwright/test";

test("separates live research, the engineering story, and the demo sandbox", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".live-feed-head")).toBeVisible();
  await expect(page.getByText("Jupiter market feed", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Market evidence in. Explainable paper decisions out." })).toBeVisible();
  await expect(page.getByText("0", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("real-trade code paths", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Demo Sandbox", exact: true }).click();
  await expect(page.getByText("Deterministic demo sandbox", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing here is live or attached to your account.", { exact: false })).toBeVisible();
});

test("the engineering story fits a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/engineering");
  await expect(page.getByRole("heading", { name: "Market evidence in. Explainable paper decisions out." })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});
