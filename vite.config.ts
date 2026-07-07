import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "esnext",
    // CRXJS derives most inputs from the manifest (popup via action, history via
    // options_page). The approval window is only referenced at runtime
    // (chrome.windows.create) and in web_accessible_resources, which CRXJS
    // copies raw — so we register it explicitly here to get its .ts/.css bundled.
    rollupOptions: {
      input: { approval: resolve(root, "src/approval/index.html") },
    },
    // Keep sourcemaps for debugging.
    sourcemap: true,
  },
  // The extension's popup is an HTML entry under src/popup/index.html; CRXJS
  // picks it up from the manifest's `action.default_popup`.
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
