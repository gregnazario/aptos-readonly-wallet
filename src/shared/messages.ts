/**
 * Message types shared across the extension's JS realms:
 *   - MAIN world (page) — where the AIP-62 wallet lives and dApps run.
 *   - ISOLATED world (content script) — bridges MAIN ↔ service worker.
 *   - Service worker (background) — owns chrome.storage, the payload log,
 *     and the approval-window lifecycle.
 *   - Approval window + popup + history page — extension-origin UIs.
 *
 * MAIN ↔ ISOLATED communicates via `window.postMessage` using the
 * `VOW_TAG` discriminator. ISOLATED ↔ background uses `chrome.runtime`.
 */

export const VOW_TAG = "view-only-wallet" as const;

/** How the wallet responds to a signing request. */
export type ResponseMode = "prompt" | "accept" | "reject";

/** The user's answer to an approval prompt. */
export type Decision = "accept" | "reject";

/**
 * A signing request awaiting the user's decision in the approval window.
 * `pretty` is the already-serialized (valid JSON) payload — the approval UI
 * both parses it for a readable view and offers it raw for copy/download.
 */
export interface ApprovalRequest {
  id: string;
  origin: string;
  kind: LoggedPayload["kind"];
  pretty: string;
  timestamp: number;
}

/** Messages flowing *from* the page into the content script. */
export type PageToContent =
  | { tag: typeof VOW_TAG; kind: "get-state" }
  | { tag: typeof VOW_TAG; kind: "record-payload"; payload: LoggedPayload }
  | { tag: typeof VOW_TAG; kind: "open-approval"; request: ApprovalRequest };

/** Messages flowing *from* the content script back into the page. */
export type ContentToPage =
  | { tag: typeof VOW_TAG; kind: "state"; state: WalletState }
  | { tag: typeof VOW_TAG; kind: "state-changed"; state: WalletState }
  | { tag: typeof VOW_TAG; kind: "decision"; id: string; decision: Decision };

/** The fully-resolved wallet state the page can consume. */
export interface WalletState {
  /** Hex-prefixed AccountAddress string, or null if the user hasn't set one yet. */
  address: string | null;
  /** Network name (lowercase) — one of mainnet/testnet/devnet/localnet. */
  network: "mainnet" | "testnet" | "devnet" | "localnet";
  /** Chain ID for the chosen network. */
  chainId: number;
  /**
   * How signing requests are answered:
   *   - "prompt"  (default): open the approval window and wait for the user
   *     to click Simulate Accept / Reject.
   *   - "reject": every signing request instantly returns `REJECTED` — the
   *     original safe behavior, no window shown.
   *   - "accept": every signing request instantly returns a fake `APPROVED`
   *     with dummy all-zero signatures / zero hash so the dApp's success
   *     path runs. Anything produced this way is of course invalid on-chain.
   */
  responseMode: ResponseMode;
  /**
   * When true (default), install a legacy Petra-compatible shim on
   * `window.aptos` + `window.petra` in addition to AIP-62 registration.
   * Needed for older dApps (Aries, Pontem, etc.) that haven't migrated
   * to the wallet-standard discovery path.
   *
   * When false, the extension is strict AIP-62 only — it never touches
   * `window.*`. Changing this requires a page reload to take effect.
   */
  injectLegacyApi: boolean;
  /**
   * When true (default), register the AIP-62 wallet as "Petra" so dApps
   * that hard-allowlist wallet names (the common `optInWallets={['Petra']}`
   * pattern) discover it.
   *
   * When false, register under the honest "View-Only Wallet" name. Changing
   * this requires a page reload because wallet-standard caches by name.
   */
  impersonatePetra: boolean;
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
  responseMode: "prompt",
  injectLegacyApi: true,
  impersonatePetra: true,
};

export const CHAIN_IDS: Record<WalletState["network"], number> = {
  mainnet: 1,
  testnet: 2,
  devnet: 3,
  localnet: 4,
};

/**
 * Coerce a possibly-partial / legacy stored state into a complete
 * `WalletState`. Handles the migration from the old `autoReject: boolean`
 * flag to `responseMode` (autoReject ON → "reject", OFF → "accept"), so a
 * user who upgrades keeps their prior behavior instead of suddenly getting
 * prompts they didn't ask for.
 */
export function normalizeState(raw: unknown): WalletState {
  const s = (raw ?? {}) as Partial<WalletState> & { autoReject?: boolean };
  let responseMode: ResponseMode;
  if (s.responseMode === "prompt" || s.responseMode === "accept" || s.responseMode === "reject") {
    responseMode = s.responseMode;
  } else if (typeof s.autoReject === "boolean") {
    responseMode = s.autoReject ? "reject" : "accept";
  } else {
    responseMode = DEFAULT_STATE.responseMode;
  }
  const network =
    s.network && s.network in CHAIN_IDS ? s.network : DEFAULT_STATE.network;
  return {
    address: s.address ?? null,
    network,
    chainId: typeof s.chainId === "number" ? s.chainId : CHAIN_IDS[network],
    responseMode,
    injectLegacyApi: s.injectLegacyApi ?? DEFAULT_STATE.injectLegacyApi,
    impersonatePetra: s.impersonatePetra ?? DEFAULT_STATE.impersonatePetra,
  };
}
