import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.VOW_E2E_PORT ?? 5411);

export default defineConfig({
  testDir: "./tests/e2e",
  // Extension state (chrome.storage) is global per persistent context, so keep
  // extension-driving specs serial to avoid cross-test interference.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "node tests/e2e/server.mjs",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
