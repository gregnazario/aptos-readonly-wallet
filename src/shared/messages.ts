/**
 * Message types shared across the extension's three JS realms:
 *   - MAIN world (page) — where the AIP-62 wallet lives and dApps run.
 *   - ISOLATED world (content script) — bridges MAIN ↔ service worker.
 *   - Service worker (background) — owns chrome.storage and fan-out.
 *
 * MAIN ↔ ISOLATED communicates via `window.postMessage` using the
 * `VOW_TAG` discriminator. ISOLATED ↔ background uses `chrome.runtime`.
 */

export const VOW_TAG = "view-only-wallet" as const;

/** Messages flowing *from* the page into the content script. */
export type PageToContent =
  | { tag: typeof VOW_TAG; kind: "get-state" }
  | {
      tag: typeof VOW_TAG;
      kind: "record-payload";
      payload: LoggedPayload;
    };

/** Messages flowing *from* the content script back into the page. */
export type ContentToPage =
  | { tag: typeof VOW_TAG; kind: "state"; state: WalletState }
  | { tag: typeof VOW_TAG; kind: "state-changed"; state: WalletState };

/** The fully-resolved wallet state the page can consume. */
export interface WalletState {
  /** Hex-prefixed AccountAddress string, or null if the user hasn't set one yet. */
  address: string | null;
  /** Network name (lowercase) — one of mainnet/testnet/devnet/localnet. */
  network: "mainnet" | "testnet" | "devnet" | "localnet";
  /** Chain ID for the chosen network. */
  chainId: number;
}

export interface LoggedPayload {
  /** Monotonic client timestamp (ms since epoch). */
  timestamp: number;
  /** Origin that initiated the request. */
  origin: string;
  /** Which AIP-62 method was called. */
  kind: "signAndSubmitTransaction" | "signTransaction" | "signMessage";
  /** Human-readable pretty-printed payload (already serialized in MAIN world). */
  pretty: string;
}

export const DEFAULT_STATE: WalletState = {
  address: null,
  network: "mainnet",
  chainId: 1,
};

export const CHAIN_IDS: Record<WalletState["network"], number> = {
  mainnet: 1,
  testnet: 2,
  devnet: 3,
  localnet: 4,
};
