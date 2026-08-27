import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/smoke",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === "1" ? 1 : 0,
  reporter: process.env.CI === "1" ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "npm run dev --workspace @poe2tc/overlay -- --host 127.0.0.1 --port 5173",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: process.env.CI !== "1",
    timeout: 60_000,
  },
});
