/**
 * Shared DOM for the simulation panel, used by both the popup log and the
 * approval window. Renders a "Simulate" / "Retry" control plus the outcome —
 * a success/failure badge, estimated gas, and the raw response for copy.
 *
 * DOM-only; imported exclusively by extension-origin UI pages.
 */
import type { LoggedPayload, WalletState } from "./messages";
import { button, copyToClipboard } from "./payload-view";
import { simulatePayload, type SimulationOutcome, type Simulator } from "./simulate";

export interface SimulationViewOptions {
  /** Kick a simulation off immediately on mount (vs. waiting for a click). */
  autoRun?: boolean;
  /** Injectable fullnode call — omit to use the real SDK. */
  simulator?: Simulator;
}

/**
 * Build a self-contained simulation panel for one logged payload. Manages its
 * own run/retry lifecycle; the caller just appends the returned element.
 */
export function renderSimulation(
  state: WalletState,
  item: Pick<LoggedPayload, "kind" | "pretty">,
  opts: SimulationViewOptions = {},
): HTMLElement {
  const root = document.createElement("section");
  root.className = "vow-sim";

  const head = document.createElement("div");
  head.className = "vow-sim-head";
  const title = document.createElement("span");
  title.className = "vow-sim-title";
  title.textContent = "Simulation";
  const runBtn = button("Simulate", "ghost vow-sim-run", () => void run());
  head.append(title, runBtn);

  const result = document.createElement("div");
  result.className = "vow-sim-result";

  root.append(head, result);

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = "Simulating…";
    result.textContent = "";
    const pending = document.createElement("p");
    pending.className = "vow-muted";
    pending.textContent = "Running against the selected network…";
    result.appendChild(pending);

    const outcome = await simulatePayload(state, item, { simulator: opts.simulator });
    running = false;
    runBtn.disabled = false;
    render(outcome);
  }

  function render(outcome: SimulationOutcome) {
    result.textContent = "";
    if (outcome.status === "unsupported") {
      runBtn.textContent = "Simulate";
      runBtn.disabled = true;
      const note = document.createElement("p");
      note.className = "vow-muted";
      note.textContent = `Can't simulate: ${outcome.reason}`;
      result.appendChild(note);
      return;
    }

    runBtn.textContent = "Retry";

    if (outcome.status === "error") {
      const badge = makeBadge("bad", "Simulation error");
      const msg = document.createElement("p");
      msg.className = "vow-sim-error";
      msg.textContent = outcome.reason;
      result.append(badge, msg);
      return;
    }

    const ok = outcome.status === "success";
    result.appendChild(makeBadge(ok ? "ok" : "bad", ok ? "Would succeed" : "Would fail"));

    const dl = document.createElement("dl");
    dl.className = "vow-fields";
    const rows: Array<[string, string]> = [];
    if (!ok) rows.push(["VM status", outcome.vmStatus]);
    rows.push(["Est. fee", `${outcome.feeApt} APT`]);
    rows.push(["Gas used", outcome.gasUsed]);
    rows.push(["Gas unit price", `${outcome.gasUnitPrice} octas`]);
    rows.push(["Events", String(outcome.events)]);
    rows.push(["State changes", String(outcome.changes)]);
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    result.appendChild(dl);

    const raw = JSON.stringify(outcome.raw, null, 2);
    const details = document.createElement("details");
    details.className = "vow-sim-raw";
    const summary = document.createElement("summary");
    summary.textContent = "Raw simulation result";
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.appendChild(
      button("Copy", "ghost", async (e) => {
        const b = e.currentTarget as HTMLButtonElement;
        const copied = await copyToClipboard(raw);
        b.textContent = copied ? "Copied ✓" : "Failed";
        setTimeout(() => (b.textContent = "Copy"), 1500);
      }),
    );
    const pre = document.createElement("pre");
    pre.textContent = raw;
    details.append(summary, actions, pre);
    result.appendChild(details);
  }

  if (opts.autoRun) void run();
  return root;
}

function makeBadge(kind: "ok" | "bad", text: string): HTMLElement {
  const badge = document.createElement("span");
  badge.className = `vow-sim-badge ${kind}`;
  badge.textContent = text;
  return badge;
}
