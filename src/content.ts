/**
 * Content script (ISOLATED world). The only realm that can touch both
 * `window.postMessage` (to reach the page / MAIN world) and
 * `chrome.runtime` / `chrome.storage` (to reach the extension).
 *
 * Bridge duties:
 *   1. Forward page → background messages (state requests, payload logs).
 *   2. Stream state changes from chrome.storage back into the page so the
 *      MAIN-world wallet can emit `aptos:onAccountChange` / network change.
 */

import {
  type ContentToPage,
  DEFAULT_STATE,
  type PageToContent,
  VOW_TAG,
  type WalletState,
} from "./shared/messages";

function sendToPage(msg: ContentToPage) {
  window.postMessage(msg, window.location.origin);
}

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages from the same frame. The page and the isolated
  // content script share `window`, so `event.source === window` is the right
  // guard.
  if (event.source !== window) return;
  const data = event.data as PageToContent | undefined;
  if (!data || data.tag !== VOW_TAG) return;

  if (data.kind === "get-state") {
    chrome.runtime.sendMessage({ tag: VOW_TAG, kind: "get-state" }, (state) => {
      sendToPage({ tag: VOW_TAG, kind: "state", state: state ?? DEFAULT_STATE });
    });
    return;
  }

  if (data.kind === "record-payload") {
    chrome.runtime.sendMessage({
      tag: VOW_TAG,
      kind: "record-payload",
      payload: data.payload,
    });
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.state) return;
  const newState = (changes.state.newValue as WalletState | undefined) ?? DEFAULT_STATE;
  sendToPage({ tag: VOW_TAG, kind: "state-changed", state: newState });
});
