import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:8791",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:8791/health",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: "8791",
      LOCAL_DB: "true",
      DATA_DIR: "data/e2e",
      MARKET_MODE: "demo",
      QUOTE_MODE: "mock",
      COOKIE_SECURE: "false",
      EMAIL_VERIFICATION_REQUIRED: "false",
      PUBLIC_APP_URL: "http://127.0.0.1:8791",
    },
  },
});
