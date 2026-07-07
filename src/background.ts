/**
 * Service worker. Single source of truth for:
 *   - the wallet state (`state`) and the log of intercepted payloads (`payloads`)
 *   - the lifecycle of approval windows: when the wallet needs the user to
 *     decide on a signing request, it asks here; we open a dedicated approval
 *     window, wait for the click, and route the decision back to the exact
 *     tab/frame that asked.
 *
 * Pending-approval bookkeeping lives in `chrome.storage.session` (not just an
 * in-memory map) so it survives the service worker being suspended while the
 * user takes their time in the approval window.
 */

import {
  type ApprovalRequest,
  type Decision,
  type LoggedPayload,
  normalizeState,
  VOW_TAG,
  type WalletState,
} from "./shared/messages";

const STATE_KEY = "state";
const PAYLOADS_KEY = "payloads";
const MAX_LOG = 200;

const REQUEST_KEY = (id: string) => `approval:${id}`;
const ROUTE_KEY = (id: string) => `route:${id}`;

interface ApprovalRoute {
  id: string;
  tabId: number;
  frameId: number;
  windowId: number;
}

async function getState(): Promise<WalletState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return normalizeState(stored[STATE_KEY]);
}

async function appendPayload(payload: LoggedPayload): Promise<void> {
  const stored = await chrome.storage.local.get(PAYLOADS_KEY);
  const existing = (stored[PAYLOADS_KEY] as LoggedPayload[] | undefined) ?? [];
  const next = [payload, ...existing].slice(0, MAX_LOG);
  await chrome.storage.local.set({ [PAYLOADS_KEY]: next });

  const countStr = String(Math.min(next.length, 99));
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  chrome.action.setBadgeText({ text: countStr });
}

// ---- Approval window lifecycle --------------------------------------------

async function openApproval(
  request: ApprovalRequest,
  tabId: number,
  frameId: number,
): Promise<void> {
  // Persist the request first so the approval page can read it on load.
  await chrome.storage.session.set({ [REQUEST_KEY(request.id)]: request });

  const url = chrome.runtime.getURL(`src/approval/index.html?id=${request.id}`);
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 440,
    height: 680,
    focused: true,
  });

  const route: ApprovalRoute = {
    id: request.id,
    tabId,
    frameId,
    windowId: win?.id ?? -1,
  };
  await chrome.storage.session.set({ [ROUTE_KEY(request.id)]: route });
}

/** Send the decision to the originating content script and clean up. */
async function resolveApproval(id: string, decision: Decision): Promise<void> {
  const stored = await chrome.storage.session.get(ROUTE_KEY(id));
  const route = stored[ROUTE_KEY(id)] as ApprovalRoute | undefined;
  if (!route) return; // already resolved (double click / close race)

  // Remove routing first so the window-closed handler doesn't double-reject.
  await chrome.storage.session.remove([ROUTE_KEY(id), REQUEST_KEY(id)]);

  try {
    await chrome.tabs.sendMessage(
      route.tabId,
      { tag: VOW_TAG, kind: "decision", id, decision },
      { frameId: route.frameId },
    );
  } catch {
    // Tab may have navigated away; nothing more we can do.
  }

  if (route.windowId >= 0) {
    try {
      await chrome.windows.remove(route.windowId);
    } catch {
      // Window already gone.
    }
  }
}

async function findRouteByWindow(windowId: number): Promise<ApprovalRoute | undefined> {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("route:") && (value as ApprovalRoute).windowId === windowId) {
      return value as ApprovalRoute;
    }
  }
  return undefined;
}

// ---- Message routing -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.tag !== VOW_TAG) return;

  if (msg.kind === "get-state") {
    getState().then(sendResponse);
    return true;
  }

  if (msg.kind === "record-payload") {
    appendPayload(msg.payload as LoggedPayload).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.kind === "open-approval") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return true;
    }
    openApproval(msg.request as ApprovalRequest, tabId, sender.frameId ?? 0).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }

  // From the approval window: the user clicked Simulate Accept / Reject.
  if (msg.kind === "approval-decision") {
    resolveApproval(msg.id as string, msg.decision as Decision).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }
});

// If the user just closes the approval window, treat it as a rejection so the
// dApp's promise doesn't hang forever.
chrome.windows.onRemoved.addListener((windowId) => {
  findRouteByWindow(windowId).then((route) => {
    if (route) void resolveApproval(route.id, "reject");
  });
});

// Keep the toolbar badge in sync when the popup / history page clears the log.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[PAYLOADS_KEY]) {
    const next = changes[PAYLOADS_KEY].newValue as LoggedPayload[] | undefined;
    const count = next?.length ?? 0;
    chrome.action.setBadgeText({ text: count === 0 ? "" : String(Math.min(count, 99)) });
  }
});
