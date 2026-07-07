/**
 * Content script (ISOLATED world). The only realm that can touch both
 * `window.postMessage` (to reach the page / MAIN world) and
 * `chrome.runtime` / `chrome.storage` (to reach the extension).
 *
 * Bridge duties:
 *   1. Forward page → background messages (state requests, payload logs,
 *      approval requests).
 *   2. Stream state changes from chrome.storage back into the page.
 *   3. Relay approval decisions from the background back into the page so the
 *      MAIN-world wallet can resolve its pending signing promise.
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

  if (data.kind === "open-approval") {
    chrome.runtime.sendMessage({
      tag: VOW_TAG,
      kind: "open-approval",
      request: data.request,
    });
    return;
  }
});

// Decision routed back from the background (via chrome.tabs.sendMessage to
// this specific frame). Relay it into the page for the waiting wallet.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.tag !== VOW_TAG) return;
  if (msg.kind === "decision") {
    sendToPage({ tag: VOW_TAG, kind: "decision", id: msg.id, decision: msg.decision });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.state) return;
  const newState = (changes.state.newValue as WalletState | undefined) ?? DEFAULT_STATE;
  sendToPage({ tag: VOW_TAG, kind: "state-changed", state: newState });
});
