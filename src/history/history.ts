/**
 * Full-page history view (also the extension's options page). Lists every
 * captured payload with per-entry Copy / Download / Delete, plus Copy-all,
 * Download-all, and Clear-all. Reads/writes the same `payloads` array the
 * popup shows.
 */
import type { LoggedPayload } from "../shared/messages";
import {
  button,
  copyToClipboard,
  downloadJson,
  formatTime,
  parsePayload,
  payloadFilename,
  renderFields,
} from "../shared/payload-view";

const PAYLOADS_KEY = "payloads";

const listEl = document.getElementById("list") as HTMLElement;
const countEl = document.getElementById("count") as HTMLElement;
const copyAllBtn = document.getElementById("copy-all") as HTMLButtonElement;
const downloadAllBtn = document.getElementById("download-all") as HTMLButtonElement;
const clearAllBtn = document.getElementById("clear-all") as HTMLButtonElement;

async function load(): Promise<LoggedPayload[]> {
  const res = await chrome.storage.local.get(PAYLOADS_KEY);
  return (res[PAYLOADS_KEY] as LoggedPayload[] | undefined) ?? [];
}

async function save(items: LoggedPayload[]): Promise<void> {
  await chrome.storage.local.set({ [PAYLOADS_KEY]: items });
}

/** Stable identity for a log entry (no id field, so use its contents). */
function sameEntry(a: LoggedPayload, b: LoggedPayload): boolean {
  return (
    a.timestamp === b.timestamp &&
    a.origin === b.origin &&
    a.kind === b.kind &&
    a.pretty === b.pretty
  );
}

function render(items: LoggedPayload[]) {
  countEl.textContent =
    items.length === 0
      ? "No payloads captured yet."
      : `${items.length} payload${items.length === 1 ? "" : "s"}`;
  const hasItems = items.length > 0;
  copyAllBtn.disabled = !hasItems;
  downloadAllBtn.disabled = !hasItems;
  clearAllBtn.disabled = !hasItems;

  listEl.textContent = "";
  if (!hasItems) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "Nothing here yet. Connect on a dApp and trigger a transaction — it'll show up here.";
    listEl.appendChild(empty);
    return;
  }

  for (const item of items) {
    listEl.appendChild(renderEntry(item));
  }
}

function renderEntry(item: LoggedPayload): HTMLElement {
  const card = document.createElement("article");
  card.className = "entry";

  const head = document.createElement("div");
  head.className = "entry-head";
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = item.kind;
  const origin = document.createElement("span");
  origin.className = "origin";
  origin.textContent = item.origin;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime(item.timestamp);
  head.append(kind, origin, time);

  const fields = renderFields(parsePayload(item.kind, item.pretty));

  const pre = document.createElement("pre");
  pre.textContent = item.pretty;

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  actions.append(
    button("Copy JSON", "ghost", async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      const ok = await copyToClipboard(item.pretty);
      b.textContent = ok ? "Copied ✓" : "Failed";
      setTimeout(() => (b.textContent = "Copy JSON"), 1500);
    }),
    button("Download", "ghost", () => downloadJson(payloadFilename(item), item.pretty)),
    button("Delete", "ghost danger", async () => {
      const items = await load();
      await save(items.filter((x) => !sameEntry(x, item)));
    }),
  );

  card.append(head, fields, pre, actions);
  return card;
}

copyAllBtn.addEventListener("click", async () => {
  const items = await load();
  const ok = await copyToClipboard(JSON.stringify(items, null, 2));
  copyAllBtn.textContent = ok ? "Copied ✓" : "Failed";
  setTimeout(() => (copyAllBtn.textContent = "Copy all"), 1500);
});

downloadAllBtn.addEventListener("click", async () => {
  const items = await load();
  downloadJson("vow-history.json", JSON.stringify(items, null, 2));
});

clearAllBtn.addEventListener("click", async () => {
  if (!confirm("Delete all captured payloads? This can't be undone.")) return;
  await save([]);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[PAYLOADS_KEY]) return;
  render((changes[PAYLOADS_KEY].newValue as LoggedPayload[] | undefined) ?? []);
});

void load().then(render);
