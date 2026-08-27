import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  outputDir: "artifacts/playwright/test-results",
  projects: [
    {
      name: "public-companion",
      testMatch: /public-companion\.spec\.ts/,
    },
    {
      name: "authorized-qa",
      testMatch: /authorized-qa\.spec\.ts/,
    },
  ],
});
