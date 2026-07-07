/**
 * Shared rendering helpers for intercepted payloads, used by the approval
 * window, the popup log, and the full history page. Parses the pretty-printed
 * JSON into a few readable fields and offers the raw JSON for copy/download.
 *
 * DOM-only — imported exclusively by extension-origin UI pages.
 */
import type { LoggedPayload } from "./messages";

export interface PayloadField {
  label: string;
  value: string;
}

export interface ParsedPayload {
  fields: PayloadField[];
  raw: string;
}

/** Pull a few human-readable fields out of the serialized payload. */
export function parsePayload(kind: LoggedPayload["kind"], pretty: string): ParsedPayload {
  let obj: any;
  try {
    obj = JSON.parse(pretty);
  } catch {
    return { fields: [], raw: pretty };
  }
  const fields: PayloadField[] = [];

  if (kind === "signMessage") {
    if (obj?.message != null) fields.push({ label: "Message", value: String(obj.message) });
    if (obj?.nonce != null) fields.push({ label: "Nonce", value: String(obj.nonce) });
    const includes = ["address", "application", "chainId"].filter((k) => obj?.[k]);
    if (includes.length) fields.push({ label: "Includes", value: includes.join(", ") });
    return { fields, raw: pretty };
  }

  // Transaction shapes: unwrap the common wrappers.
  const body = obj?.payload ?? obj?.data ?? obj ?? {};
  if (typeof body.function === "string") {
    fields.push({ label: "Function", value: body.function });
  }
  const typeArgs = body.typeArguments ?? body.type_arguments;
  if (Array.isArray(typeArgs) && typeArgs.length) {
    fields.push({ label: "Type args", value: typeArgs.map(String).join(", ") });
  }
  const args = body.functionArguments ?? body.arguments ?? body.args;
  if (Array.isArray(args)) {
    fields.push({
      label: `Arguments (${args.length})`,
      value: args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join("\n"),
    });
  }

  // Advanced transaction attributes (multi-agent / sponsored / orderless).
  if (obj?.sender) fields.push({ label: "Sender", value: addrOf(obj.sender) });
  if (obj?.feePayer) {
    fields.push({ label: "Fee payer (sponsored)", value: addrOf(obj.feePayer) });
  }
  if (obj?.asFeePayer === true || obj?.withFeePayer === true) {
    fields.push({ label: "Signing as", value: "fee payer (sponsored)" });
  }
  const secondary = obj?.secondarySigners ?? obj?.secondarySignerAddresses;
  if (Array.isArray(secondary) && secondary.length) {
    fields.push({
      label: `Secondary signers (multi-agent, ${secondary.length})`,
      value: secondary.map(addrOf).join("\n"),
    });
  }
  const opts = body?.options ?? obj?.options ?? {};
  const nonce = opts.replayProtectionNonce ?? opts.replay_protection_nonce;
  if (nonce != null) {
    fields.push({ label: "Orderless (replay nonce)", value: String(nonce) });
  }
  if (obj?.sequenceNumber != null) {
    fields.push({ label: "Sequence #", value: String(obj.sequenceNumber) });
  }
  if (obj?.network) fields.push({ label: "Network", value: String(obj.network) });
  return { fields, raw: pretty };
}

/** Extract an address from a string, an `{ address }`, or fall back to JSON. */
function addrOf(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof (x as { address?: unknown }).address === "string") {
    return (x as { address: string }).address;
  }
  return JSON.stringify(x);
}

export function button(
  label: string,
  variant: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = `vow-btn ${variant}`;
  b.addEventListener("click", onClick);
  return b;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A short, filesystem-safe filename for a payload's JSON. */
export function payloadFilename(p: LoggedPayload): string {
  const host = safeHost(p.origin);
  return `vow-${p.kind}-${host}-${p.timestamp}.json`;
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Build the parsed field list (<dl>) for a payload. Callers wrap it with
 * whatever surrounding chrome (header, buttons) they need.
 */
export function renderFields(parsed: ParsedPayload): HTMLElement {
  const dl = document.createElement("dl");
  dl.className = "vow-fields";
  if (parsed.fields.length === 0) {
    const note = document.createElement("p");
    note.className = "vow-muted";
    note.textContent = "No structured fields — see raw JSON below.";
    dl.appendChild(note);
    return dl;
  }
  for (const f of parsed.fields) {
    const dt = document.createElement("dt");
    dt.textContent = f.label;
    const dd = document.createElement("dd");
    dd.textContent = f.value;
    dl.append(dt, dd);
  }
  return dl;
}
