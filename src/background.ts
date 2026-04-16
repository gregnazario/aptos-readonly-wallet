/**
 * Service worker. Owns chrome.storage.local and acts as a single source of
 * truth for:
 *   - the impersonated address + chosen network (`state`)
 *   - the log of intercepted payloads (`payloads`)
 *
 * Content scripts talk to it via chrome.runtime.sendMessage. The popup reads
 * / writes chrome.storage.local directly.
 */

import {
  DEFAULT_STATE,
  type LoggedPayload,
  VOW_TAG,
  type WalletState,
} from "./shared/messages";

const STATE_KEY = "state";
const PAYLOADS_KEY = "payloads";
const MAX_LOG = 50;

async function getState(): Promise<WalletState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return (stored[STATE_KEY] as WalletState | undefined) ?? DEFAULT_STATE;
}

async function appendPayload(payload: LoggedPayload): Promise<void> {
  const stored = await chrome.storage.local.get(PAYLOADS_KEY);
  const existing = (stored[PAYLOADS_KEY] as LoggedPayload[] | undefined) ?? [];
  const next = [payload, ...existing].slice(0, MAX_LOG);
  await chrome.storage.local.set({ [PAYLOADS_KEY]: next });

  // Badge the toolbar icon so the user notices a new intercepted payload.
  const countStr = String(Math.min(next.length, 99));
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  chrome.action.setBadgeText({ text: countStr });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.tag !== VOW_TAG) return;

  if (msg.kind === "get-state") {
    getState().then(sendResponse);
    return true; // async response
  }

  if (msg.kind === "record-payload") {
    appendPayload(msg.payload as LoggedPayload).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// When the popup clears the badge, reset it here too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[PAYLOADS_KEY]) {
    const next = changes[PAYLOADS_KEY].newValue as LoggedPayload[] | undefined;
    const count = next?.length ?? 0;
    chrome.action.setBadgeText({ text: count === 0 ? "" : String(Math.min(count, 99)) });
  }
});
