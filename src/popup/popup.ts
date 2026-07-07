/**
 * Popup UI. Lives in the extension's own origin, has full `chrome.storage`
 * access, and never touches the page directly.
 *
 * Jobs:
 *   1. Read + write the wallet state (address, network, response mode, modes).
 *   2. Render a compact log of intercepted payloads (parsed + copy/download).
 *   3. Link out to the full-page history view.
 */

import { AccountAddress } from "@aptos-labs/ts-sdk";
import {
  CHAIN_IDS,
  type LoggedPayload,
  normalizeState,
  type ResponseMode,
  type WalletState,
} from "../shared/messages";
import {
  button,
  copyToClipboard,
  downloadJson,
  formatTime,
  parsePayload,
  payloadFilename,
  renderFields,
} from "../shared/payload-view";

const STATE_KEY = "state";
const PAYLOADS_KEY = "payloads";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el as T;
};

const addressInput = $<HTMLInputElement>("#address");
const networkSelect = $<HTMLSelectElement>("#network");
const responseModeSelect = $<HTMLSelectElement>("#response-mode");
const injectLegacyInput = $<HTMLInputElement>("#inject-legacy");
const impersonatePetraInput = $<HTMLInputElement>("#impersonate-petra");
const saveBtn = $<HTMLButtonElement>("#save");
const saveStatus = $<HTMLParagraphElement>("#save-status");
const clearBtn = $<HTMLButtonElement>("#clear");
const historyBtn = $<HTMLButtonElement>("#history");
const logEl = $<HTMLOListElement>("#log");

async function loadState(): Promise<WalletState> {
  const res = await chrome.storage.local.get(STATE_KEY);
  return normalizeState(res[STATE_KEY]);
}

function renderState(state: WalletState) {
  addressInput.value = state.address ?? "";
  networkSelect.value = state.network;
  responseModeSelect.value = state.responseMode;
  injectLegacyInput.checked = state.injectLegacyApi;
  impersonatePetraInput.checked = state.impersonatePetra;
}

function renderLog(items: LoggedPayload[]) {
  logEl.textContent = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No payloads yet. Connect on a dApp and try a transaction.";
    logEl.appendChild(li);
    return;
  }
  for (const item of items.slice(0, 10)) {
    logEl.appendChild(renderEntry(item));
  }
  if (items.length > 10) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `+ ${items.length - 10} more — open “View all”.`;
    logEl.appendChild(li);
  }
}

function renderEntry(item: LoggedPayload): HTMLLIElement {
  const li = document.createElement("li");

  const head = document.createElement("div");
  head.className = "head";
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = item.kind;
  const origin = document.createElement("span");
  origin.className = "origin";
  origin.textContent = `${item.origin} · ${formatTime(item.timestamp)}`;
  head.append(kind, origin);

  const parsed = parsePayload(item.kind, item.pretty);
  const fields = renderFields(parsed);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Raw JSON";
  const actions = document.createElement("div");
  actions.className = "entry-actions";
  actions.append(
    button("Copy", "ghost", async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      const ok = await copyToClipboard(item.pretty);
      b.textContent = ok ? "Copied ✓" : "Failed";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    }),
    button("Download", "ghost", () => downloadJson(payloadFilename(item), item.pretty)),
  );
  const pre = document.createElement("pre");
  pre.textContent = item.pretty;
  details.append(summary, actions, pre);

  li.append(head, fields, details);
  return li;
}

async function loadLog(): Promise<LoggedPayload[]> {
  const res = await chrome.storage.local.get(PAYLOADS_KEY);
  return (res[PAYLOADS_KEY] as LoggedPayload[] | undefined) ?? [];
}

saveBtn.addEventListener("click", async () => {
  const raw = addressInput.value.trim();
  let address: string | null = null;

  if (raw.length > 0) {
    try {
      address = AccountAddress.from(raw).toString();
    } catch {
      saveStatus.textContent = "❌ Invalid Aptos address.";
      saveStatus.style.color = "crimson";
      return;
    }
  }

  const network = networkSelect.value as WalletState["network"];
  const responseMode = responseModeSelect.value as ResponseMode;
  const state: WalletState = {
    address,
    network,
    chainId: CHAIN_IDS[network],
    responseMode,
    injectLegacyApi: injectLegacyInput.checked,
    impersonatePetra: impersonatePetraInput.checked,
  };
  await chrome.storage.local.set({ [STATE_KEY]: state });

  const modeLabel = {
    prompt: "ask me",
    accept: "always accept",
    reject: "always reject",
  }[responseMode];
  const modes = [
    state.impersonatePetra ? "as Petra" : "as View-Only Wallet",
    modeLabel,
    state.injectLegacyApi ? "window.aptos ON" : "AIP-62 only",
  ].join(" · ");
  saveStatus.textContent = address
    ? `✓ Saved ${address.slice(0, 10)}… · ${modes}`
    : `✓ Address cleared · ${modes}`;
  saveStatus.style.color = "";
});

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ [PAYLOADS_KEY]: [] });
});

historyBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/history/index.html") });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[PAYLOADS_KEY]) {
    renderLog((changes[PAYLOADS_KEY].newValue as LoggedPayload[] | undefined) ?? []);
  }
  if (changes[STATE_KEY]) {
    renderState(normalizeState(changes[STATE_KEY].newValue));
  }
});

(async () => {
  const [state, log] = await Promise.all([loadState(), loadLog()]);
  renderState(state);
  renderLog(log);
})();
