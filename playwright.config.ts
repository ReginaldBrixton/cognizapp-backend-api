import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  globalSetup: "./tests/playwright/global-setup.ts",
  timeout: 30_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.API_URL ?? "http://localhost:3001",
    extraHTTPHeaders: {
      "Content-Type": "application/json",
    },
  },
});
