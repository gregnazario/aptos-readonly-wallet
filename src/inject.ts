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
    for (const cb of listeners) cb(data.state);
  }
});

// Ask the content script for the initial state. We register synchronously
// with DEFAULT_STATE first so that the wallet is discoverable immediately
// on page load; any address/network fetched from storage arrives shortly
// after and is applied via the state-change path.
const wallet = new ViewOnlyWallet(DEFAULT_STATE, bridge);
registerWallet(wallet);

const getStateMsg: PageToContent = { tag: VOW_TAG, kind: "get-state" };
window.postMessage(getStateMsg, window.location.origin);
