/**
 * AIP-62 view-only Aptos wallet.
 *
 * Runs in the page's MAIN world. Does not hold a private key. All signing
 * methods:
 *   1. Serialize the payload to a human-readable form.
 *   2. Log it to the devtools console of the page.
 *   3. Ship it to the extension (via a window.postMessage bridge) so it
 *      shows up in the popup.
 *   4. Return `{ status: UserResponseStatus.REJECTED }` — the standard's
 *      well-defined "user said no" path. The dApp will handle it the way it
 *      handles any rejected signature request.
 *
 * The wallet intentionally claims ALL Aptos chains so dApps on any network
 * can connect. The reported `NetworkInfo` comes from the user's popup choice.
 */

import {
  AccountAddress,
  AccountAuthenticatorEd25519,
  Ed25519PublicKey,
  Ed25519Signature,
  Network,
  SigningScheme,
} from "@aptos-labs/ts-sdk";
import {
  APTOS_CHAINS,
  AccountInfo,
  type AptosFeatures,
  type AptosWallet,
  type AptosWalletAccount,
  type NetworkInfo,
  type UserResponse,
  UserResponseStatus,
  type WalletIcon,
} from "@aptos-labs/wallet-standard";
import {
  type ApprovalRequest,
  CHAIN_IDS,
  type Decision,
  type LoggedPayload,
  VOW_TAG,
  type WalletState,
} from "./shared/messages";
import { prettyPrint } from "./shared/serialize";

/**
 * Petra-style icon: black rounded square with the stylized white "P" mark.
 * Close enough visually for dApp wallet pickers that render small icons.
 * The real Petra icon is proprietary; this is a plain approximation so
 * the impersonation is *identity*-level (name + url), not asset theft.
 */
const PETRA_ICON = ("data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#000"/><path d="M15 12h12c5 0 9 3.5 9 9s-4 9-9 9h-6v6h-6V12zm6 6v6h5c1.7 0 3-1.3 3-3s-1.3-3-3-3h-5z" fill="#fff"/></svg>`,
  )) as WalletIcon;

/**
 * Honest icon for "View-Only Wallet" mode: a blue rounded square with a
 * white eye glyph. Visually signals "this is watching, not signing".
 */
const VIEW_ONLY_ICON = ("data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#2563eb"/><path d="M24 14c-7 0-12.5 5.6-14 10 1.5 4.4 7 10 14 10s12.5-5.6 14-10c-1.5-4.4-7-10-14-10zm0 16a6 6 0 1 1 0-12 6 6 0 0 1 0 12zm0-9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" fill="#fff"/></svg>`,
  )) as WalletIcon;

const PETRA_IDENTITY = {
  name: "Petra" as const,
  url: "https://petra.app",
  icon: PETRA_ICON,
};
const VIEW_ONLY_IDENTITY = {
  name: "View-Only Wallet" as const,
  url: "https://github.com/gregnazario/aptos-readonly-wallet",
  icon: VIEW_ONLY_ICON,
};

/**
 * Stable dummy Ed25519 public key used as a placeholder for the account we
 * are impersonating. The key is all zeros and clearly recognizable as fake;
 * the wallet cannot and will not sign with it.
 */
const DUMMY_PUBKEY = new Ed25519PublicKey(new Uint8Array(32));
const DUMMY_SIGNATURE = new Ed25519Signature(new Uint8Array(64));
const DUMMY_AUTHENTICATOR = new AccountAuthenticatorEd25519(
  DUMMY_PUBKEY,
  DUMMY_SIGNATURE,
);
const DUMMY_TX_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export class ViewOnlyWalletAccount implements AptosWalletAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: AptosWalletAccount["chains"];
  readonly features: AptosWalletAccount["features"];
  readonly signingScheme = SigningScheme.Ed25519;
  readonly label: string;

  constructor(address: AccountAddress, label: string) {
    this.address = address.toString();
    this.label = label;
    this.publicKey = DUMMY_PUBKEY.toUint8Array();
    this.chains = APTOS_CHAINS;
    this.features = [
      "aptos:connect",
      "aptos:disconnect",
      "aptos:account",
      "aptos:network",
      "aptos:onAccountChange",
      "aptos:onNetworkChange",
      "aptos:changeNetwork",
      "aptos:signTransaction",
      "aptos:signAndSubmitTransaction",
      "aptos:signMessage",
    ];
  }
}

type AccountChangeCb = (acc: AccountInfo) => void;
type NetworkChangeCb = (net: NetworkInfo) => void;

function stateToNetworkInfo(state: WalletState): NetworkInfo {
  const nameMap: Record<WalletState["network"], Network> = {
    mainnet: Network.MAINNET,
    testnet: Network.TESTNET,
    devnet: Network.DEVNET,
    localnet: Network.LOCAL,
  };
  return {
    name: nameMap[state.network],
    chainId: state.chainId,
  };
}

/** SDK Network enum ("local") ↔ our state's network union ("localnet"). */
const NETWORK_NAME_MAP: Record<string, WalletState["network"]> = {
  mainnet: "mainnet",
  testnet: "testnet",
  devnet: "devnet",
  local: "localnet",
  localnet: "localnet",
};

/**
 * Resolve a dApp-requested `changeNetwork` into our constrained state. Prefers
 * the name; falls back to a reverse chain-id lookup; defaults to mainnet.
 */
function resolveNetwork(
  name: unknown,
  chainId: unknown,
): { network: WalletState["network"]; chainId: number } {
  const byName = typeof name === "string" ? NETWORK_NAME_MAP[name.toLowerCase()] : undefined;
  const cid = typeof chainId === "number" ? chainId : undefined;
  if (byName) return { network: byName, chainId: cid ?? CHAIN_IDS[byName] };
  const entry = (Object.entries(CHAIN_IDS) as [WalletState["network"], number][]).find(
    ([, id]) => id === cid,
  );
  if (entry) return { network: entry[0], chainId: cid as number };
  return { network: "mainnet", chainId: cid ?? 1 };
}

export interface ViewOnlyWalletBridge {
  /** Fires when the user changes the impersonated address via the popup. */
  onStateChanged(cb: (state: WalletState) => void): void;
  /** Record an intercepted payload (surfaces in extension popup / history). */
  recordPayload(p: LoggedPayload): void;
  /** Open the approval window and resolve with the user's decision. */
  requestDecision(request: ApprovalRequest): Promise<Decision>;
  /** Persist a dApp-requested network change to storage. */
  persistNetwork(network: WalletState["network"], chainId: number): void;
}

export class ViewOnlyWallet implements AptosWallet {
  readonly version = "1.0.0" as const;
  // Identity (name / url / icon) is frozen from the initial state at
  // registration time because wallet-standard caches wallets by name.
  // Flipping `impersonatePetra` at runtime therefore requires a page reload.
  readonly name: string;
  readonly url: string;
  readonly icon: WalletIcon;
  readonly chains = APTOS_CHAINS;

  private _state: WalletState;
  private _account: ViewOnlyWalletAccount | null = null;
  private _connected = false;
  private readonly _accountChangeCbs = new Set<AccountChangeCb>();
  private readonly _networkChangeCbs = new Set<NetworkChangeCb>();
  private readonly _bridge: ViewOnlyWalletBridge;

  constructor(initialState: WalletState, bridge: ViewOnlyWalletBridge) {
    this._state = initialState;
    const identity = initialState.impersonatePetra ? PETRA_IDENTITY : VIEW_ONLY_IDENTITY;
    this.name = identity.name;
    this.url = identity.url;
    this.icon = identity.icon;
    this._bridge = bridge;
    this._bridge.onStateChanged((next) => this._applyState(next));
    this._rebuildAccount();
  }

  private _rebuildAccount() {
    this._account =
      this._state.address != null
        ? new ViewOnlyWalletAccount(AccountAddress.from(this._state.address), this.name)
        : null;
  }

  private _applyState(next: WalletState) {
    const addrChanged = next.address !== this._state.address;
    const netChanged =
      next.network !== this._state.network || next.chainId !== this._state.chainId;
    this._state = next;
    if (addrChanged) {
      this._rebuildAccount();
      if (this._connected && this._account) {
        const info = new AccountInfo({
          address: this._account.address,
          publicKey: DUMMY_PUBKEY,
        });
        for (const cb of this._accountChangeCbs) cb(info);
      }
    }
    if (netChanged) {
      const info = stateToNetworkInfo(this._state);
      for (const cb of this._networkChangeCbs) cb(info);
    }
  }

  get accounts() {
    return this._account && this._connected ? [this._account] : [];
  }

  private _accountInfoOrThrow(): AccountInfo {
    if (!this._account) {
      throw new Error(
        "View-Only Wallet: no address configured. Open the extension popup and set an address.",
      );
    }
    return new AccountInfo({
      address: this._account.address,
      publicKey: DUMMY_PUBKEY,
    });
  }

  /**
   * Compact one-line trace for every AIP-62 entry point. Goes to the *page's*
   * devtools console only (not the popup log — that's reserved for signing
   * payloads). Useful for diagnosing which wallet surface a dApp is actually
   * hitting when multiple are registered (AIP-62 vs legacy window.aptos).
   */
  private _logCall(method: string, extra?: unknown): void {
    const origin = window.location.origin;
    const tag = `[View-Only Wallet · AIP-62 · ${this.name}] ${method}`;
    // eslint-disable-next-line no-console
    if (extra !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`%c${tag}`, "color:#2563eb;font-weight:bold", origin, extra);
    } else {
      // eslint-disable-next-line no-console
      console.log(`%c${tag}`, "color:#2563eb;font-weight:bold", origin);
    }
  }

  /**
   * Log the payload (console + popup history), then resolve how to respond:
   *   - responseMode "reject" / "accept" → answer instantly, no window.
   *   - responseMode "prompt" → open the approval window and await the click.
   */
  private async _surfaceAndDecide(
    kind: LoggedPayload["kind"],
    rawPayload: unknown,
  ): Promise<Decision> {
    const pretty = prettyPrint(rawPayload);
    const origin = window.location.origin;
    const timestamp = Date.now();

    // Print to page console in a neatly boxed format.
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `%c[View-Only Wallet] ${kind}`,
      "color:#2563eb;font-weight:bold",
    );
    // eslint-disable-next-line no-console
    console.log(pretty);
    // eslint-disable-next-line no-console
    console.groupEnd();

    this._bridge.recordPayload({ timestamp, origin, kind, pretty });

    const mode = this._state.responseMode;
    if (mode === "reject") return "reject";
    if (mode === "accept") return "accept";
    return this._bridge.requestDecision({
      id: crypto.randomUUID(),
      origin,
      kind,
      pretty,
      timestamp,
    });
  }

  readonly features: AptosFeatures = {
    "aptos:connect": {
      version: "1.0.0",
      connect: async (silent, networkInfo): Promise<UserResponse<AccountInfo>> => {
        this._logCall("connect", { silent, networkInfo, hasAddress: this._account != null });
        if (!this._account) {
          return { status: UserResponseStatus.REJECTED };
        }
        this._connected = true;
        return {
          status: UserResponseStatus.APPROVED,
          args: this._accountInfoOrThrow(),
        };
      },
    },
    "aptos:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        this._logCall("disconnect");
        this._connected = false;
      },
    },
    "aptos:account": {
      version: "1.0.0",
      account: async () => {
        this._logCall("account");
        return this._accountInfoOrThrow();
      },
    },
    "aptos:network": {
      version: "1.0.0",
      network: async () => {
        this._logCall("network");
        return stateToNetworkInfo(this._state);
      },
    },
    "aptos:onAccountChange": {
      version: "1.0.0",
      onAccountChange: async (cb) => {
        this._logCall("onAccountChange");
        this._accountChangeCbs.add(cb);
      },
    },
    "aptos:onNetworkChange": {
      version: "1.0.0",
      onNetworkChange: async (cb) => {
        this._logCall("onNetworkChange");
        this._networkChangeCbs.add(cb);
      },
    },
    "aptos:changeNetwork": {
      version: "1.0.0",
      changeNetwork: async (
        input,
      ): Promise<UserResponse<{ success: boolean; reason?: string }>> => {
        this._logCall("changeNetwork", input);
        const resolved = resolveNetwork(
          (input as { name?: unknown }).name,
          (input as { chainId?: unknown }).chainId,
        );
        const changed =
          resolved.network !== this._state.network ||
          resolved.chainId !== this._state.chainId;
        // Update in-memory first so the storage round-trip's state-changed
        // (same values) is a no-op and doesn't double-fire onNetworkChange.
        this._state = { ...this._state, network: resolved.network, chainId: resolved.chainId };
        if (changed) {
          const info = stateToNetworkInfo(this._state);
          for (const cb of this._networkChangeCbs) cb(info);
        }
        this._bridge.persistNetwork(resolved.network, resolved.chainId);
        return { status: UserResponseStatus.APPROVED, args: { success: true } };
      },
    },
    "aptos:signTransaction": {
      version: "1.1.0",
      // The signature is union'd between the v1.0 positional form and the v1.1
      // object form; we accept either at runtime and log whichever came in.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTransaction: (async (firstArg: any, maybeFeePayer?: boolean) => {
        const looksLikeV11 =
          firstArg !== null &&
          typeof firstArg === "object" &&
          "payload" in firstArg;

        const toLog = looksLikeV11
          ? firstArg
          : { rawTransaction: firstArg, asFeePayer: maybeFeePayer ?? false };

        const decision = await this._surfaceAndDecide("signTransaction", toLog);
        if (decision === "reject") {
          return { status: UserResponseStatus.REJECTED };
        }
        // V1.1 callers pass an object and expect { authenticator, rawTransaction }.
        // V1.0 callers pass the raw transaction positionally and expect just the authenticator.
        if (looksLikeV11) {
          return {
            status: UserResponseStatus.APPROVED,
            args: {
              authenticator: DUMMY_AUTHENTICATOR,
              rawTransaction: firstArg.payload ?? firstArg,
            },
          };
        }
        return {
          status: UserResponseStatus.APPROVED,
          args: DUMMY_AUTHENTICATOR,
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    "aptos:signAndSubmitTransaction": {
      version: "1.1.0",
      signAndSubmitTransaction: async (tx) => {
        const decision = await this._surfaceAndDecide("signAndSubmitTransaction", tx);
        if (decision === "reject") {
          return { status: UserResponseStatus.REJECTED };
        }
        return {
          status: UserResponseStatus.APPROVED,
          args: { hash: DUMMY_TX_HASH },
        };
      },
    },
    "aptos:signMessage": {
      version: "1.0.0",
      signMessage: async (input) => {
        const decision = await this._surfaceAndDecide("signMessage", input);
        if (decision === "reject") {
          return { status: UserResponseStatus.REJECTED };
        }
        // Build the full signed-message envelope with zero signature.
        const parts: string[] = ["APTOS"];
        if (input.address && this._account) parts.push(`address: ${this._account.address}`);
        if (input.chainId) parts.push(`chainId: ${this._state.chainId}`);
        if (input.application) parts.push(`application: ${window.location.origin}`);
        parts.push(`nonce: ${input.nonce}`, `message: ${input.message}`);
        const fullMessage = parts.join("\n");

        return {
          status: UserResponseStatus.APPROVED,
          args: {
            prefix: "APTOS" as const,
            fullMessage,
            message: input.message,
            nonce: input.nonce,
            signature: DUMMY_SIGNATURE,
            ...(input.address && this._account ? { address: this._account.address } : {}),
            ...(input.chainId ? { chainId: this._state.chainId } : {}),
            ...(input.application ? { application: window.location.origin } : {}),
          },
        };
      },
    },
  };
}

export { CHAIN_IDS };
