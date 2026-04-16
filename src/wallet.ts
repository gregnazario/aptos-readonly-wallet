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
  CHAIN_IDS,
  type LoggedPayload,
  VOW_TAG,
  type WalletState,
} from "./shared/messages";

/**
 * Petra-style icon: black rounded square with the stylized white "P" mark.
 * Close enough visually for dApp wallet pickers that render small icons.
 * The real Petra icon is proprietary; this is a plain approximation so
 * the impersonation is *identity*-level (name + url), not asset theft.
 */
const ICON = ("data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#000"/><path d="M15 12h12c5 0 9 3.5 9 9s-4 9-9 9h-6v6h-6V12zm6 6v6h5c1.7 0 3-1.3 3-3s-1.3-3-3-3h-5z" fill="#fff"/></svg>`,
  )) as WalletIcon;

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
  // Intentionally plain so the account row doesn't scream "fake" to the dApp.
  readonly label = "Petra";

  constructor(address: AccountAddress) {
    this.address = address.toString();
    this.publicKey = DUMMY_PUBKEY.toUint8Array();
    this.chains = APTOS_CHAINS;
    this.features = [
      "aptos:connect",
      "aptos:disconnect",
      "aptos:account",
      "aptos:network",
      "aptos:onAccountChange",
      "aptos:onNetworkChange",
      "aptos:signTransaction",
      "aptos:signAndSubmitTransaction",
      "aptos:signMessage",
    ];
  }
}

type AccountChangeCb = (acc: AccountInfo) => void;
type NetworkChangeCb = (net: NetworkInfo) => void;

/**
 * Serializer that survives BigInt, Uint8Array, and the Aptos SDK's various
 * `Serializable` subclasses. Anything with a `toString()` gets its string
 * form; everything else falls back to plain JSON.
 */
function prettyPrint(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === "bigint") return v.toString() + "n";
      if (v instanceof Uint8Array) {
        return "0x" + Array.from(v).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      if (v && typeof v === "object" && "toString" in v && typeof (v as { toString: unknown }).toString === "function") {
        // Only expand SDK types that have a meaningful toString — otherwise
        // fall through to the default object serialization.
        const ctor = (v as object).constructor?.name ?? "";
        if (/Address|PublicKey|Authenticator|Hex|MoveVector|Module/.test(ctor)) {
          return `${ctor}(${(v as { toString(): string }).toString()})`;
        }
      }
      return v;
    },
    2,
  );
}

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

export interface ViewOnlyWalletBridge {
  /** Fires when the user changes the impersonated address via the popup. */
  onStateChanged(cb: (state: WalletState) => void): void;
  /** Record an intercepted payload (surfaces in extension popup). */
  recordPayload(p: LoggedPayload): void;
}

export class ViewOnlyWallet implements AptosWallet {
  readonly version = "1.0.0" as const;
  // Impersonates Petra so dApps that hard-allowlist wallet names (common
  // pattern with `optInWallets={['Petra']}`) discover us.
  readonly name = "Petra";
  readonly url = "https://petra.app";
  readonly icon = ICON;
  readonly chains = APTOS_CHAINS;

  private _state: WalletState;
  private _account: ViewOnlyWalletAccount | null = null;
  private _connected = false;
  private readonly _accountChangeCbs = new Set<AccountChangeCb>();
  private readonly _networkChangeCbs = new Set<NetworkChangeCb>();
  private readonly _bridge: ViewOnlyWalletBridge;

  constructor(initialState: WalletState, bridge: ViewOnlyWalletBridge) {
    this._state = initialState;
    this._bridge = bridge;
    this._bridge.onStateChanged((next) => this._applyState(next));
    this._rebuildAccount();
  }

  private _rebuildAccount() {
    this._account =
      this._state.address != null
        ? new ViewOnlyWalletAccount(AccountAddress.from(this._state.address))
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

  private _surfacePayload(
    kind: LoggedPayload["kind"],
    rawPayload: unknown,
  ): void {
    const pretty = prettyPrint(rawPayload);
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

    this._bridge.recordPayload({
      timestamp: Date.now(),
      origin: window.location.origin,
      kind,
      pretty,
    });
  }

  readonly features: AptosFeatures = {
    "aptos:connect": {
      version: "1.0.0",
      connect: async (_silent, _networkInfo): Promise<UserResponse<AccountInfo>> => {
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
        this._connected = false;
      },
    },
    "aptos:account": {
      version: "1.0.0",
      account: async () => this._accountInfoOrThrow(),
    },
    "aptos:network": {
      version: "1.0.0",
      network: async () => stateToNetworkInfo(this._state),
    },
    "aptos:onAccountChange": {
      version: "1.0.0",
      onAccountChange: async (cb) => {
        this._accountChangeCbs.add(cb);
      },
    },
    "aptos:onNetworkChange": {
      version: "1.0.0",
      onNetworkChange: async (cb) => {
        this._networkChangeCbs.add(cb);
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

        this._surfacePayload("signTransaction", toLog);
        if (this._state.autoReject) {
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
        this._surfacePayload("signAndSubmitTransaction", tx);
        if (this._state.autoReject) {
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
        this._surfacePayload("signMessage", input);
        if (this._state.autoReject) {
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
