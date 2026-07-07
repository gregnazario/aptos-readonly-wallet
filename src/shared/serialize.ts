/**
 * Payload serializer shared by the AIP-62 wallet (`wallet.ts`) and the legacy
 * `window.aptos` shim (`legacy-api.ts`). The whole point of this extension is
 * to surface a payload you can *re-execute elsewhere*, so the serialized form
 * has to survive the types the Aptos SDK hands us:
 *
 *   - `bigint`        → `"10000000n"` (suffixed `n`; JSON has no bigint)
 *   - `Uint8Array`    → `"0xabcd…"`   (hex, the form every tool accepts)
 *   - SDK class types → `value.toString()` (e.g. `AccountAddress` → `"0x1"`,
 *                       `Ed25519PublicKey` → `"0x00…"`)
 *   - anything else   → standard JSON
 *
 * IMPORTANT: we detect SDK class instances by `constructor !== Object` rather
 * than by `constructor.name`. The Aptos SDK ships minified, so class names are
 * mangled to things like `"e"` / `"bt"` at runtime — any name-based check is
 * dead code in a real build. `constructor !== Object` is minification-robust.
 */

export function toHexString(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function prettyPrint(value: unknown): string {
  return JSON.stringify(value, serializeReplacer, 2);
}

function serializeReplacer(_key: string, v: unknown): unknown {
  if (typeof v === "bigint") return v.toString() + "n";
  if (v instanceof Uint8Array) return toHexString(v);

  // Collapse SDK "class" instances (AccountAddress, Ed25519PublicKey,
  // authenticators, MoveVector, …) to their canonical string form. Plain
  // objects (`constructor === Object`) and arrays keep recursing so their
  // structure is preserved.
  if (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (v as { constructor?: unknown }).constructor !== Object &&
    (v as { constructor?: unknown }).constructor !== undefined &&
    typeof (v as { toString?: unknown }).toString === "function"
  ) {
    const s = (v as { toString(): string }).toString();
    // `[object Object]` means the type has no meaningful toString — fall back
    // to default structural serialization rather than emitting garbage.
    if (s !== "[object Object]") return s;
  }

  return v;
}
