/**
 * MAIN-world content script. This runs in the page's own JS realm, which
 * means:
 *   - It can dispatch `wallet-standard:register-wallet` so dApps discover us.
 *   - It CANNOT use `chrome.*` APIs (those live in the ISOLATED world).
 *
 * State sync: we ask the ISOLATED content script for the current wallet
 * state via window.postMessage, then build a `ViewOnlyWallet` and register
 * it. Registration is deferred until that first state arrives (with a short
 * fallback) so the wallet registers under the user's chosen identity —
 * wallet-standard caches wallets by name and can't rename them later.
 * Subsequent address/network changes propagate live to the registered wallet.
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

// The wallet's identity (Petra vs. View-Only Wallet) is frozen at
// registration time because wallet-standard caches wallets by name. That
// means we must know the user's `impersonatePetra` choice *before* we
// register — so registration is deferred until the first state arrives from
// storage (or a short fallback fires). Registering a few ms late is safe:
// wallet-standard's late-registration path re-announces us to dApps that are
// already listening, and the common case (dApps prompt on user click) is
// unaffected.
let wallet: ViewOnlyWallet | null = null;
let registered = false;

function registerOnce(initialState: WalletState) {
  if (registered) return;
  registered = true;
  currentState = initialState;

  wallet = new ViewOnlyWallet(initialState, bridge);
  registerWallet(wallet);

  // Startup banner. Makes it obvious at page-load time that the extension
  // is injected, under what AIP-62 name, and which other wallet slots are
  // already claimed (so we can tell if real Petra is coexisting, etc.).
  const w = window as unknown as { aptos?: unknown; petra?: unknown };
  const aptosClaimed = w.aptos ? "taken" : "free";
  const petraClaimed = w.petra ? "taken" : "free";
  // eslint-disable-next-line no-console
  console.log(
    `%c[View-Only Wallet] registered AIP-62 wallet "${wallet.name}" · window.aptos ${aptosClaimed} · window.petra ${petraClaimed}`,
    "color:#2563eb;font-weight:bold",
  );

  // Install the legacy Petra shim once we know the flag. Pre-existing
  // `window.aptos` (real Petra) is *not* overwritten — we only install when
  // the slot is free, so coexistence is safe.
  if (initialState.injectLegacyApi) {
    installLegacyApi();
  }
}

// Listen for state updates streamed back from the ISOLATED content script.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as ContentToPage | undefined;
  if (!data || data.tag !== VOW_TAG) return;
  if (data.kind === "state" || data.kind === "state-changed") {
    // The very first state we see determines our registered identity.
    if (!registered) {
      registerOnce(data.state);
      return;
    }
    currentState = data.state;
    for (const cb of listeners) cb(data.state);
  }
});

// Ask the content script for the initial state, then register with it.
const getStateMsg: PageToContent = { tag: VOW_TAG, kind: "get-state" };
window.postMessage(getStateMsg, window.location.origin);

// Fallback: if the bridge never answers (e.g. the ISOLATED content script
// failed to load), still register with defaults so the wallet is usable.
setTimeout(() => registerOnce(DEFAULT_STATE), 500);

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
