/**
 * Approval window. Opened by the background service worker for each signing
 * request when responseMode is "prompt". Shows the payload parsed + raw, and
 * sends the user's Simulate Accept / Reject decision back to the background,
 * which routes it to the waiting wallet and closes this window.
 */
import { type ApprovalRequest, type Decision, VOW_TAG } from "../shared/messages";
import {
  button,
  copyToClipboard,
  downloadJson,
  formatTime,
  parsePayload,
  payloadFilename,
  renderFields,
} from "../shared/payload-view";

const params = new URLSearchParams(location.search);
const id = params.get("id");
const content = document.getElementById("content") as HTMLElement;

const KIND_LABEL: Record<ApprovalRequest["kind"], string> = {
  signAndSubmitTransaction: "Sign & submit transaction",
  signTransaction: "Sign transaction",
  signMessage: "Sign message",
};

async function init() {
  if (!id) {
    content.textContent = "Missing request id.";
    return;
  }
  const key = `approval:${id}`;
  const stored = await chrome.storage.session.get(key);
  const req = stored[key] as ApprovalRequest | undefined;
  if (!req) {
    content.textContent = "This request is no longer pending.";
    return;
  }
  render(req);
}

function render(req: ApprovalRequest) {
  content.textContent = "";

  const kindEl = document.createElement("h1");
  kindEl.className = "kind";
  kindEl.textContent = KIND_LABEL[req.kind] ?? req.kind;

  const origin = document.createElement("p");
  origin.className = "origin";
  origin.textContent = req.origin;

  const time = document.createElement("p");
  time.className = "time";
  time.textContent = formatTime(req.timestamp);

  const parsed = parsePayload(req.kind, req.pretty);
  const fields = renderFields(parsed);

  // Raw JSON, collapsible, with copy/download.
  const details = document.createElement("details");
  details.className = "raw";
  const summary = document.createElement("summary");
  summary.textContent = "Raw JSON";
  const actions = document.createElement("div");
  actions.className = "raw-actions";
  const copyBtn = button("Copy", "ghost", async () => {
    const ok = await copyToClipboard(req.pretty);
    copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  });
  const dlBtn = button("Download .json", "ghost", () =>
    downloadJson(payloadFilename(req), req.pretty),
  );
  actions.append(copyBtn, dlBtn);
  const pre = document.createElement("pre");
  pre.textContent = req.pretty;
  details.append(summary, actions, pre);

  // Decision buttons.
  const decideRow = document.createElement("div");
  decideRow.className = "decide";
  const status = document.createElement("p");
  status.className = "status";

  const acceptBtn = button("Simulate Accept", "accept", () => decide("accept"));
  const rejectBtn = button("Reject", "reject", () => decide("reject"));
  decideRow.append(acceptBtn, rejectBtn);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Simulate Accept returns a fake all-zero signature (nothing is signed or " +
    "submitted on-chain). Reject returns a user-rejection to the dApp.";

  function decide(decision: Decision) {
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    status.textContent = decision === "accept" ? "Accepted — closing…" : "Rejected — closing…";
    chrome.runtime.sendMessage({ tag: VOW_TAG, kind: "approval-decision", id, decision });
  }

  content.append(kindEl, origin, time, fields, details, note, decideRow, status);
}

void init();
