import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountAddress,
  AccountAuthenticatorEd25519,
} from "@aptos-labs/ts-sdk";
import { UserResponseStatus } from "@aptos-labs/wallet-standard";
import {
  ViewOnlyWallet,
  type ViewOnlyWalletBridge,
} from "../../src/wallet";
import {
  DEFAULT_STATE,
  type LoggedPayload,
  type WalletState,
} from "../../src/shared/messages";

const ADDR = "0x1";

/**
 * A controllable stand-in for the MAIN-world bridge. Captures the wallet's
 * state-change subscription so tests can push new state, and records every
 * surfaced payload for assertions.
 */
function makeBridge() {
  let stateCb: ((s: WalletState) => void) | undefined;
  const recorded: LoggedPayload[] = [];
  const bridge: ViewOnlyWalletBridge = {
    onStateChanged(cb) {
      stateCb = cb;
    },
    recordPayload(p) {
      recorded.push(p);
    },
  };
  return {
    bridge,
    recorded,
    emitState(s: WalletState) {
      if (!stateCb) throw new Error("wallet never subscribed to state changes");
      stateCb(s);
    },
  };
}

function state(overrides: Partial<WalletState> = {}): WalletState {
  return { ...DEFAULT_STATE, address: ADDR, ...overrides };
}

/** Convenience: build a wallet + bridge in one call. */
function makeWallet(overrides: Partial<WalletState> = {}) {
  const h = makeBridge();
  const wallet = new ViewOnlyWallet(state(overrides), h.bridge);
  return { wallet, ...h };
}

// Silence the wallet's devtools console noise during tests.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "groupCollapsed").mockImplementation(() => {});
  vi.spyOn(console, "groupEnd").mockImplementation(() => {});
});

describe("ViewOnlyWallet identity", () => {
  it("registers as Petra when impersonatePetra is on", () => {
    const { wallet } = makeWallet({ impersonatePetra: true });
    expect(wallet.name).toBe("Petra");
    expect(wallet.url).toBe("https://petra.app");
    expect(wallet.icon).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("registers honestly as View-Only Wallet when impersonation is off", () => {
    const { wallet } = makeWallet({ impersonatePetra: false });
    expect(wallet.name).toBe("View-Only Wallet");
    expect(wallet.url).toContain("github.com");
  });

  it("advertises every required AIP-62 feature", () => {
    const { wallet } = makeWallet();
    for (const f of [
      "aptos:connect",
      "aptos:disconnect",
      "aptos:account",
      "aptos:network",
      "aptos:onAccountChange",
      "aptos:onNetworkChange",
      "aptos:signTransaction",
      "aptos:signAndSubmitTransaction",
      "aptos:signMessage",
    ]) {
      expect(wallet.features).toHaveProperty(f);
    }
  });
});

describe("connect / account", () => {
  it("rejects connect when no address is configured", async () => {
    const h = makeBridge();
    const wallet = new ViewOnlyWallet(state({ address: null }), h.bridge);
    const res = await wallet.features["aptos:connect"].connect(false, undefined);
    expect(res.status).toBe(UserResponseStatus.REJECTED);
    expect(wallet.accounts).toHaveLength(0);
  });

  it("returns the impersonated account on connect", async () => {
    const { wallet } = makeWallet();
    const res = await wallet.features["aptos:connect"].connect(false, undefined);
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    if (res.status !== UserResponseStatus.APPROVED) throw new Error("unreachable");
    expect(res.args.address.toString()).toBe(AccountAddress.from(ADDR).toString());
    // Dummy all-zero public key, recognizably fake.
    expect(res.args.publicKey.toString()).toBe("0x" + "00".repeat(32));
    expect(wallet.accounts).toHaveLength(1);
  });

  it("exposes no accounts until connected", async () => {
    const { wallet } = makeWallet();
    expect(wallet.accounts).toHaveLength(0);
    await wallet.features["aptos:connect"].connect(false, undefined);
    expect(wallet.accounts).toHaveLength(1);
    await wallet.features["aptos:disconnect"].disconnect();
    expect(wallet.accounts).toHaveLength(0);
  });

  it("account() throws with a helpful message when no address set", async () => {
    const h = makeBridge();
    const wallet = new ViewOnlyWallet(state({ address: null }), h.bridge);
    await expect(wallet.features["aptos:account"].account()).rejects.toThrow(
      /no address configured/i,
    );
  });
});

describe("network", () => {
  it("reports the selected network and chain id", async () => {
    const { wallet } = makeWallet({ network: "testnet", chainId: 2 });
    const net = await wallet.features["aptos:network"].network();
    expect(net.chainId).toBe(2);
    expect(String(net.name).toLowerCase()).toBe("testnet");
  });
});

describe("signing — auto-reject ON (default, safe)", () => {
  it("logs the payload and rejects signAndSubmitTransaction", async () => {
    const { wallet, recorded } = makeWallet({ autoReject: true });
    const res = await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      payload: { function: "0x1::aptos_account::transfer" },
    } as never);
    expect(res.status).toBe(UserResponseStatus.REJECTED);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("signAndSubmitTransaction");
    expect(recorded[0]!.pretty).toContain("aptos_account::transfer");
  });

  it("logs and rejects signTransaction", async () => {
    const { wallet, recorded } = makeWallet({ autoReject: true });
    const res = await (wallet.features["aptos:signTransaction"].signTransaction as never as
      (a: unknown) => Promise<{ status: UserResponseStatus }>)({ payload: { foo: 1 } });
    expect(res.status).toBe(UserResponseStatus.REJECTED);
    expect(recorded[0]!.kind).toBe("signTransaction");
  });

  it("logs and rejects signMessage", async () => {
    const { wallet, recorded } = makeWallet({ autoReject: true });
    const res = await wallet.features["aptos:signMessage"].signMessage({
      message: "hi",
      nonce: "1",
    });
    expect(res.status).toBe(UserResponseStatus.REJECTED);
    expect(recorded[0]!.kind).toBe("signMessage");
    expect(recorded[0]!.pretty).toContain("hi");
  });
});

describe("signing — auto-reject OFF (fake-approve dummy data)", () => {
  it("fake-approves signAndSubmitTransaction with a zero hash", async () => {
    const { wallet } = makeWallet({ autoReject: false });
    const res = await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      payload: {},
    } as never);
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    if (res.status !== UserResponseStatus.APPROVED) throw new Error("unreachable");
    expect(res.args.hash).toBe("0x" + "00".repeat(32));
  });

  it("v1.1 signTransaction returns { authenticator, rawTransaction }", async () => {
    const { wallet } = makeWallet({ autoReject: false });
    const raw = { some: "rawtxn" };
    const res = await (wallet.features["aptos:signTransaction"].signTransaction as never as
      (a: unknown) => Promise<{ status: UserResponseStatus; args: Record<string, unknown> }>)({
      payload: raw,
    });
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    expect(res.args.authenticator).toBeInstanceOf(AccountAuthenticatorEd25519);
    expect(res.args.rawTransaction).toBe(raw);
  });

  it("v1.0 signTransaction returns a bare authenticator", async () => {
    const { wallet } = makeWallet({ autoReject: false });
    const res = await (wallet.features["aptos:signTransaction"].signTransaction as never as
      (a: unknown) => Promise<{ status: UserResponseStatus; args: unknown }>)({ rawTxNoPayloadField: 1 });
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    expect(res.args).toBeInstanceOf(AccountAuthenticatorEd25519);
  });

  it("signMessage returns the full APTOS envelope with a zero signature", async () => {
    const { wallet } = makeWallet({ autoReject: false });
    const res = await wallet.features["aptos:signMessage"].signMessage({
      message: "gm",
      nonce: "42",
      address: true,
      chainId: true,
      application: true,
    });
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    if (res.status !== UserResponseStatus.APPROVED) throw new Error("unreachable");
    expect(res.args.prefix).toBe("APTOS");
    expect(res.args.fullMessage).toContain("nonce: 42");
    expect(res.args.fullMessage).toContain("message: gm");
    expect(res.args.signature.toString()).toBe("0x" + "00".repeat(64));
  });
});

describe("live state changes", () => {
  it("fires onAccountChange when the popup changes address while connected", async () => {
    const { wallet, emitState } = makeWallet();
    await wallet.features["aptos:connect"].connect(false, undefined);

    const cb = vi.fn();
    await wallet.features["aptos:onAccountChange"].onAccountChange(cb);

    emitState(state({ address: "0x2" }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].address.toString()).toBe(AccountAddress.from("0x2").toString());
  });

  it("does NOT fire onAccountChange when disconnected", async () => {
    const { wallet, emitState } = makeWallet();
    const cb = vi.fn();
    await wallet.features["aptos:onAccountChange"].onAccountChange(cb);
    emitState(state({ address: "0x2" }));
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires onNetworkChange when the popup changes network", async () => {
    const { wallet, emitState } = makeWallet();
    const cb = vi.fn();
    await wallet.features["aptos:onNetworkChange"].onNetworkChange(cb);
    emitState(state({ network: "devnet", chainId: 3 }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].chainId).toBe(3);
  });
});

describe("prettyPrint serialization (via surfaced payloads)", () => {
  it("stringifies BigInt, Uint8Array, and SDK types into re-executable forms", async () => {
    const { wallet, recorded } = makeWallet({ autoReject: true });
    await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      data: {
        function: "0x1::coin::transfer",
        functionArguments: [
          10000000n,
          new Uint8Array([0xab, 0xcd]),
          AccountAddress.from("0x5"),
        ],
      },
    } as never);
    const pretty = recorded[0]!.pretty;
    // bigint keeps its `n` suffix so it round-trips unambiguously.
    expect(pretty).toContain('"10000000n"');
    // raw bytes become hex.
    expect(pretty).toContain("0xabcd");
    // SDK class instances collapse to their canonical string (minification
    // mangles constructor names, so this must not depend on the class name).
    expect(pretty).toContain('"0x5"');
  });
});
