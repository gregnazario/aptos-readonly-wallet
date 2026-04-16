/**
 * Popup UI. Lives in the extension's own origin, has full `chrome.storage`
 * access, and never touches the page directly.
 *
 * Two jobs:
 *   1. Read + write the wallet state (address + network).
 *   2. Render + clear the log of intercepted payloads.
 */

import { AccountAddress } from "@aptos-labs/ts-sdk";
import { CHAIN_IDS, DEFAULT_STATE, type LoggedPayload, type WalletState } from "../shared/messages";

const STATE_KEY = "state";
const PAYLOADS_KEY = "payloads";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el as T;
};

const addressInput = $<HTMLInputElement>("#address");
const networkSelect = $<HTMLSelectElement>("#network");
const saveBtn = $<HTMLButtonElement>("#save");
const saveStatus = $<HTMLParagraphElement>("#save-status");
const clearBtn = $<HTMLButtonElement>("#clear");
const logEl = $<HTMLOListElement>("#log");

async function loadState(): Promise<WalletState> {
  const res = await chrome.storage.local.get(STATE_KEY);
  return (res[STATE_KEY] as WalletState | undefined) ?? DEFAULT_STATE;
}

async function saveState(state: WalletState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

function renderState(state: WalletState) {
  addressInput.value = state.address ?? "";
  networkSelect.value = state.network;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function renderLog(items: LoggedPayload[]) {
  logEl.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No payloads yet. Connect on a dApp and try a transaction.";
    logEl.appendChild(li);
    return;
  }
  for (const item of items) {
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

    const pre = document.createElement("pre");
    pre.textContent = item.pretty;

    li.append(head, pre);
    logEl.appendChild(li);
  }
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
      // Normalize (0x1 → 0x0…01) and validate.
      address = AccountAddress.from(raw).toString();
    } catch {
      saveStatus.textContent = "❌ Invalid Aptos address.";
      saveStatus.style.color = "crimson";
      return;
    }
  }

  const network = networkSelect.value as WalletState["network"];
  const state: WalletState = {
    address,
    network,
    chainId: CHAIN_IDS[network],
  };
  await saveState(state);
  saveStatus.textContent = address ? `✓ Saved ${address.slice(0, 10)}…` : "✓ Address cleared.";
  saveStatus.style.color = "";
});

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ [PAYLOADS_KEY]: [] });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[PAYLOADS_KEY]) {
    renderLog((changes[PAYLOADS_KEY].newValue as LoggedPayload[] | undefined) ?? []);
  }
  if (changes[STATE_KEY]) {
    renderState((changes[STATE_KEY].newValue as WalletState | undefined) ?? DEFAULT_STATE);
  }
});

(async () => {
  const [state, log] = await Promise.all([loadState(), loadLog()]);
  renderState(state);
  renderLog(log);
})();
