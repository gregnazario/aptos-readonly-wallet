/**
 * MAIN-world content script. This runs in the page's own JS realm, which
 * means:
 *   - It can dispatch `wallet-standard:register-wallet` so dApps discover us.
 *   - It CANNOT use `chrome.*` APIs (those live in the ISOLATED world).
 *
 * State sync: we ask the ISOLATED content script for the current wallet
 * state via window.postMessage, then build a `ViewOnlyWallet` and register
 * it. If the state isn't ready yet (e.g. async storage read), we register
 * with default state and emit an account-change event once it arrives.
 *
 * NOTE: we intentionally do NOT touch `window.aptos` / `window.petra`. The
 * entire integration is through AIP-62's `wallet-standard:register-wallet`
 * event.
 */

import { registerWallet } from "@aptos-labs/wallet-standard";
import { LegacyPetraAPI } from "./legacy-api";
import {
  DEFAULT_STATE,
  type ContentToPage,
  type LoggedPayload,
  type PageToContent,
  VOW_TAG,
  type WalletState,
} from "./shared/messages";
import { ViewOnlyWallet, type ViewOnlyWalletBridge } from "./wallet";

type StateListener = (s: WalletState) => void;
const listeners = new Set<StateListener>();
let currentState: WalletState = DEFAULT_STATE;

const bridge: ViewOnlyWalletBridge = {
  onStateChanged(cb) {
    listeners.add(cb);
  },
  recordPayload(p: LoggedPayload) {
    const msg: PageToContent = { tag: VOW_TAG, kind: "record-payload", payload: p };
    window.postMessage(msg, window.location.origin);
  },
};

// Listen for state updates streamed back from the ISOLATED content script.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as ContentToPage | undefined;
  if (!data || data.tag !== VOW_TAG) return;
  if (data.kind === "state" || data.kind === "state-changed") {
    currentState = data.state;
    for (const cb of listeners) cb(data.state);

    // One-shot install of the legacy Petra shim once we know the flag.
    // Pre-existing `window.aptos` (real Petra) is *not* overwritten — we
    // only install when the slot is free, so coexistence is safe.
    if (data.kind === "state" && data.state.injectLegacyApi) {
      installLegacyApi();
    }
  }
});

// Ask the content script for the initial state. We register synchronously
// with DEFAULT_STATE first so that the wallet is discoverable immediately
// on page load; any address/network fetched from storage arrives shortly
// after and is applied via the state-change path.
const wallet = new ViewOnlyWallet(DEFAULT_STATE, bridge);
registerWallet(wallet);

// Startup banner. Makes it obvious at page-load time that the extension
// is injected, under what AIP-62 name, and which other wallet slots are
// already claimed (so we can tell if real Petra is coexisting, etc.).
{
  const w = window as unknown as { aptos?: unknown; petra?: unknown };
  const aptosClaimed = w.aptos ? "taken" : "free";
  const petraClaimed = w.petra ? "taken" : "free";
  // eslint-disable-next-line no-console
  console.log(
    `%c[View-Only Wallet] registered AIP-62 wallet "${wallet.name}" · window.aptos ${aptosClaimed} · window.petra ${petraClaimed}`,
    "color:#2563eb;font-weight:bold",
  );
}

const getStateMsg: PageToContent = { tag: VOW_TAG, kind: "get-state" };
window.postMessage(getStateMsg, window.location.origin);

let legacyInstalled = false;
function installLegacyApi() {
  if (legacyInstalled) return;
  legacyInstalled = true;
  const legacy = new LegacyPetraAPI({
    getState: () => currentState,
    recordPayload: bridge.recordPayload,
    onStateChanged: (cb) => listeners.add(cb),
  });
  const w = window as unknown as { aptos?: unknown; petra?: unknown };
  // Don't clobber a real Petra install. If the slot's free, claim it.
  const tookAptos = !w.aptos;
  const tookPetra = !w.petra;
  if (tookAptos) w.aptos = legacy;
  if (tookPetra) w.petra = legacy;
  // eslint-disable-next-line no-console
  console.log(
    `%c[View-Only Wallet] Legacy shim installed · window.aptos=${tookAptos ? "claimed" : "already taken (coexisting with real Petra?)"} · window.petra=${tookPetra ? "claimed" : "already taken"}`,
    "color:#2563eb;font-weight:bold",
  );
}
