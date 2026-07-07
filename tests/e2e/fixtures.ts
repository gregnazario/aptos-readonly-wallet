/**
 * Playwright fixture that launches Chromium with the *built* extension
 * (`dist/`) loaded, and exposes helpers to drive the extension's state and
 * read back what it captured.
 *
 * Loading an unpacked extension requires:
 *   - the full Chromium build (channel: "chromium"), not headless-shell, and
 *   - a persistent context with --load-extension.
 * Headless works via Chromium's new headless mode.
 */
import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

export interface WalletStateInput {
  address: string | null;
  network?: "mainnet" | "testnet" | "devnet" | "localnet";
  chainId?: number;
  autoReject?: boolean;
  injectLegacyApi?: boolean;
  impersonatePetra?: boolean;
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  /** Overwrite the extension's stored wallet state. */
  setWalletState: (s: WalletStateInput) => Promise<void>;
  /** Read the captured payload log out of chrome.storage. */
  getPayloads: () => Promise<
    Array<{ kind: string; origin: string; pretty: string; timestamp: number }>
  >;
}>({
  context: async ({}, use) => {
    if (!existsSync(join(DIST, "manifest.json"))) {
      throw new Error(
        `Built extension not found at ${DIST}. Run \`pnpm build\` before the E2E suite ` +
          `(or use \`pnpm test:all\`, which builds first).`,
      );
    }
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    // chrome-extension://<id>/...
    const id = new URL(serviceWorker.url()).host;
    await use(id);
  },

  setWalletState: async ({ serviceWorker }, use) => {
    await use(async (s: WalletStateInput) => {
      const CHAIN_IDS = { mainnet: 1, testnet: 2, devnet: 3, localnet: 4 } as const;
      const network = s.network ?? "mainnet";
      const state = {
        address: s.address,
        network,
        chainId: s.chainId ?? CHAIN_IDS[network],
        autoReject: s.autoReject ?? true,
        injectLegacyApi: s.injectLegacyApi ?? true,
        impersonatePetra: s.impersonatePetra ?? true,
      };
      await serviceWorker.evaluate(
        (st) => chrome.storage.local.set({ state: st }),
        state,
      );
    });
  },

  getPayloads: async ({ serviceWorker }, use) => {
    await use(async () => {
      return (await serviceWorker.evaluate(() =>
        chrome.storage.local.get("payloads"),
      )).payloads ?? [];
    });
  },
});

export const expect = test.expect;
