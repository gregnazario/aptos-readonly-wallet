import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Aptos View-Only Wallet",
  version: "0.1.0",
  description:
    "Impersonates an Aptos address and prints AIP-62 transaction payloads instead of signing them.",
  action: {
    default_title: "Aptos View-Only Wallet",
    default_popup: "src/popup/index.html",
  },
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  permissions: ["storage"],
  host_permissions: ["<all_urls>"],
  // Two content scripts: one runs in the page's MAIN world to register the
  // AIP-62 wallet; the other runs in the ISOLATED world to bridge to the
  // service worker (which owns chrome.storage).
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/inject.ts"],
      run_at: "document_start",
      world: "MAIN",
      all_frames: true,
    },
    {
      matches: ["<all_urls>"],
      js: ["src/content.ts"],
      run_at: "document_start",
      world: "ISOLATED",
      all_frames: true,
    },
  ],
});
