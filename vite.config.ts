import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "esnext",
    // CRXJS handles rollup inputs via the manifest; keep sourcemaps for debugging.
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
