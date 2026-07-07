import { defineConfig } from "vitest/config";

// Vitest config kept separate from vite.config.ts so the CRXJS extension
// plugin (which rewrites the manifest and content-script inputs) never runs
// during unit tests — we only want to exercise the wallet's pure logic.
export default defineConfig({
  test: {
    // wallet.ts / legacy-api.ts touch `window.location`, `btoa`, and
    // `console`; a DOM environment provides all three.
    environment: "happy-dom",
    include: ["tests/unit/**/*.test.ts"],
    globals: true,
    clearMocks: true,
  },
});
