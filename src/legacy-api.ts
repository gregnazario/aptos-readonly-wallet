/**
 * Legacy `window.aptos` / `window.petra` shim — the pre-AIP-62 API that
 * dApps like Aries, Pontem UI, and older third-party integrations still
 * rely on.
 *
 * This is intentionally a thin wrapper around the same state + surfacing
 * logic the AIP-62 wallet uses; there is no private key involved. The
 * legacy API has no `UserResponse` enum, so:
 *   - "auto-reject ON" is modeled by *throwing* (what real wallets do on
 *     user cancel).
 *   - "auto-reject OFF" returns dummy all-zero outputs.
 */

import { Ed25519Signature } from "@aptos-labs/ts-sdk";
import type { LoggedPayload, WalletState } from "./shared/messages";

type LegacyEvent = "accountChange" | "networkChange" | "disconnect";

const DUMMY_HEX_32 = "0x" + "00".repeat(32);
const DUMMY_HEX_64 = "0x" + "00".repeat(64);

export interface LegacyApiBridge {
  getState: () => WalletState;
  recordPayload: (p: LoggedPayload) => void;
  onStateChanged: (cb: (s: WalletState) => void) => void;
}

export class LegacyPetraAPI {
  // Petra marker — many dApps gate on this before calling the rest of the API.
  readonly isPetra = true;

  private readonly _bridge: LegacyApiBridge;
  private readonly _listeners: Record<LegacyEvent, Set<(arg?: unknown) => void>> = {
    accountChange: new Set(),
    networkChange: new Set(),
    disconnect: new Set(),
  };

  constructor(bridge: LegacyApiBridge) {
    this._bridge = bridge;
    bridge.onStateChanged((next) => {
      // Fire legacy events so subscribed dApps see state changes.
      if (next.address) {
        this._emit("accountChange", { address: next.address, publicKey: DUMMY_HEX_32 });
      } else {
        this._emit("disconnect");
      }
      this._emit("networkChange", next.network);
    });
  }

  private _emit(event: LegacyEvent, arg?: unknown) {
    for (const cb of this._listeners[event]) {
      try {
        cb(arg);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[View-Only Wallet] legacy listener threw:", e);
      }
    }
  }

  /**
   * Compact one-line trace for every legacy entry point. Helps you see when
   * a dApp is reaching us via `window.aptos` / `window.petra` vs. the
   * AIP-62 wallet-standard path.
   */
  private _logCall(method: string, extra?: unknown): void {
    const origin = window.location.origin;
    const tag = `[View-Only Wallet · legacy window.aptos] ${method}`;
    // eslint-disable-next-line no-console
    if (extra !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`%c${tag}`, "color:#db2777;font-weight:bold", origin, extra);
    } else {
      // eslint-disable-next-line no-console
      console.log(`%c${tag}`, "color:#db2777;font-weight:bold", origin);
    }
  }

  private _requireAddress(): string {
    const { address } = this._bridge.getState();
    if (!address) {
      throw new Error(
        "View-Only Wallet: no address configured. Open the extension popup and set an address.",
      );
    }
    return address;
  }

  private _surface(kind: LoggedPayload["kind"], raw: unknown) {
    const pretty = JSON.stringify(
      raw,
      (_k, v) => {
        if (typeof v === "bigint") return v.toString() + "n";
        if (v instanceof Uint8Array)
          return "0x" + Array.from(v).map((b) => b.toString(16).padStart(2, "0")).join("");
        return v;
      },
      2,
    );
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `%c[View-Only Wallet · legacy] ${kind}`,
      "color:#2563eb;font-weight:bold",
    );
    // eslint-disable-next-line no-console
    console.log(pretty);
    // eslint-disable-next-line no-console
    console.groupEnd();
    this._bridge.recordPayload({
      timestamp: Date.now(),
      origin: window.location.origin,
      kind,
      pretty,
    });
  }

  async connect(): Promise<{ address: string; publicKey: string }> {
    this._logCall("connect");
    const address = this._requireAddress();
    return { address, publicKey: DUMMY_HEX_32 };
  }

  async isConnected(): Promise<boolean> {
    const connected = this._bridge.getState().address != null;
    this._logCall("isConnected", { connected });
    return connected;
  }

  async disconnect(): Promise<void> {
    this._logCall("disconnect");
    this._emit("disconnect");
  }

  async account(): Promise<{ address: string; publicKey: string }> {
    this._logCall("account");
    const address = this._requireAddress();
    return { address, publicKey: DUMMY_HEX_32 };
  }

  async network(): Promise<{ name: string; chainId: string; url?: string }> {
    this._logCall("network");
    const { network, chainId } = this._bridge.getState();
    // Petra historically returns the capitalized name.
    const name = network.charAt(0).toUpperCase() + network.slice(1);
    return { name, chainId: String(chainId) };
  }

  async getNetwork(): Promise<{ name: string; chainId: string; url?: string }> {
    this._logCall("getNetwork");
    return this.network();
  }

  private _rejectedError(action: string): Error {
    const err = new Error(
      `View-Only Wallet: ${action} rejected (auto-reject ON; toggle it off in the popup to fake-approve).`,
    );
    // Match Petra's error shape so dApps that inspect .code still branch correctly.
    (err as unknown as { code: number }).code = 4001;
    return err;
  }

  async signAndSubmitTransaction(transaction: unknown): Promise<{ hash: string; output?: unknown }> {
    this._requireAddress();
    this._surface("signAndSubmitTransaction", transaction);
    if (this._bridge.getState().autoReject) {
      throw this._rejectedError("signAndSubmitTransaction");
    }
    return { hash: DUMMY_HEX_32 };
  }

  async signTransaction(transaction: unknown): Promise<Uint8Array> {
    this._requireAddress();
    this._surface("signTransaction", transaction);
    if (this._bridge.getState().autoReject) {
      throw this._rejectedError("signTransaction");
    }
    // Legacy API returns a serialized signed-txn byte blob. We return 96
    // zero bytes (matches Ed25519 signed-txn auth + signature length).
    return new Uint8Array(96);
  }

  async signMessage(payload: {
    message: string;
    nonce: string;
    address?: boolean;
    chainId?: boolean;
    application?: boolean;
  }): Promise<{
    address?: string;
    application?: string;
    chainId?: number;
    fullMessage: string;
    message: string;
    nonce: string;
    prefix: "APTOS";
    signature: string;
  }> {
    this._requireAddress();
    this._surface("signMessage", payload);
    if (this._bridge.getState().autoReject) {
      throw this._rejectedError("signMessage");
    }
    const { address, chainId } = this._bridge.getState();
    const parts: string[] = ["APTOS"];
    if (payload.address && address) parts.push(`address: ${address}`);
    if (payload.chainId) parts.push(`chainId: ${chainId}`);
    if (payload.application) parts.push(`application: ${window.location.origin}`);
    parts.push(`nonce: ${payload.nonce}`, `message: ${payload.message}`);
    return {
      prefix: "APTOS",
      fullMessage: parts.join("\n"),
      message: payload.message,
      nonce: payload.nonce,
      signature: DUMMY_HEX_64,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ...(payload.address && address ? { address } : {}),
      ...(payload.chainId ? { chainId } : {}),
      ...(payload.application ? { application: window.location.origin } : {}),
    };
  }

  onAccountChange(cb: (acc: { address: string; publicKey: string }) => void): void {
    this._logCall("onAccountChange");
    this._listeners.accountChange.add(cb as (arg?: unknown) => void);
  }

  onNetworkChange(cb: (net: string) => void): void {
    this._logCall("onNetworkChange");
    this._listeners.networkChange.add(cb as (arg?: unknown) => void);
  }

  onDisconnect(cb: () => void): void {
    this._logCall("onDisconnect");
    this._listeners.disconnect.add(cb as (arg?: unknown) => void);
  }

  // Some integrations use a generic on/off pattern.
  on(event: LegacyEvent, cb: (arg?: unknown) => void): void {
    this._logCall(`on("${event}")`);
    if (this._listeners[event]) this._listeners[event].add(cb);
  }

  off(event: LegacyEvent, cb: (arg?: unknown) => void): void {
    this._logCall(`off("${event}")`);
    this._listeners[event]?.delete(cb);
  }
}

// Silence unused-import warning for Ed25519Signature (kept for future use).
void Ed25519Signature;
