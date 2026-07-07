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
  type ApprovalRequest,
  type Decision,
  type LoggedPayload,
  type WalletState,
} from "../../src/shared/messages";

const ADDR = "0x1";

/**
 * A controllable stand-in for the MAIN-world bridge. Captures the wallet's
 * state-change subscription, records surfaced payloads, and lets a test drive
 * the approval decision returned for "prompt" mode.
 */
function makeBridge() {
  let stateCb: ((s: WalletState) => void) | undefined;
  const recorded: LoggedPayload[] = [];
  const decisionRequests: ApprovalRequest[] = [];
  const networkPersists: Array<{ network: WalletState["network"]; chainId: number }> = [];
  let answer: Decision = "reject";
  const bridge: ViewOnlyWalletBridge = {
    onStateChanged(cb) {
      stateCb = cb;
    },
    recordPayload(p) {
      recorded.push(p);
    },
    requestDecision(req) {
      decisionRequests.push(req);
      return Promise.resolve(answer);
    },
    persistNetwork(network, chainId) {
      networkPersists.push({ network, chainId });
    },
  };
  return {
    bridge,
    recorded,
    decisionRequests,
    networkPersists,
    setDecision(d: Decision) {
      answer = d;
    },
    emitState(s: WalletState) {
      if (!stateCb) throw new Error("wallet never subscribed to state changes");
      stateCb(s);
    },
  };
}

function state(overrides: Partial<WalletState> = {}): WalletState {
  return { ...DEFAULT_STATE, address: ADDR, ...overrides };
}

function makeWallet(overrides: Partial<WalletState> = {}) {
  const h = makeBridge();
  const wallet = new ViewOnlyWallet(state(overrides), h.bridge);
  return { wallet, ...h };
}

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
    expect(res.args.publicKey.toString()).toBe("0x" + "00".repeat(32));
    expect(wallet.accounts).toHaveLength(1);
  });

  it("connect is never gated behind the approval prompt", async () => {
    const { wallet, decisionRequests } = makeWallet({ responseMode: "prompt" });
    await wallet.features["aptos:connect"].connect(false, undefined);
    expect(decisionRequests).toHaveLength(0);
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

describe("signing — responseMode 'reject' (instant, no prompt)", () => {
  it("logs the payload and rejects without prompting", async () => {
    const { wallet, recorded, decisionRequests } = makeWallet({ responseMode: "reject" });
    const res = await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      payload: { function: "0x1::aptos_account::transfer" },
    } as never);
    expect(res.status).toBe(UserResponseStatus.REJECTED);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.pretty).toContain("aptos_account::transfer");
    expect(decisionRequests).toHaveLength(0);
  });

  it("rejects signTransaction and signMessage too", async () => {
    const { wallet } = makeWallet({ responseMode: "reject" });
    const st = await (wallet.features["aptos:signTransaction"].signTransaction as never as
      (a: unknown) => Promise<{ status: UserResponseStatus }>)({ payload: { foo: 1 } });
    expect(st.status).toBe(UserResponseStatus.REJECTED);
    const sm = await wallet.features["aptos:signMessage"].signMessage({ message: "hi", nonce: "1" });
    expect(sm.status).toBe(UserResponseStatus.REJECTED);
  });
});

describe("signing — responseMode 'accept' (instant fake-approve)", () => {
  it("fake-approves signAndSubmitTransaction with a zero hash, no prompt", async () => {
    const { wallet, decisionRequests } = makeWallet({ responseMode: "accept" });
    const res = await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      payload: {},
    } as never);
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    if (res.status !== UserResponseStatus.APPROVED) throw new Error("unreachable");
    expect(res.args.hash).toBe("0x" + "00".repeat(32));
    expect(decisionRequests).toHaveLength(0);
  });

  it("v1.1 signTransaction returns { authenticator, rawTransaction }", async () => {
    const { wallet } = makeWallet({ responseMode: "accept" });
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
    const { wallet } = makeWallet({ responseMode: "accept" });
    const res = await (wallet.features["aptos:signTransaction"].signTransaction as never as
      (a: unknown) => Promise<{ status: UserResponseStatus; args: unknown }>)({ rawTxNoPayloadField: 1 });
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    expect(res.args).toBeInstanceOf(AccountAuthenticatorEd25519);
  });

  it("signMessage returns the full APTOS envelope with a zero signature", async () => {
    const { wallet } = makeWallet({ responseMode: "accept" });
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
    expect(res.args.signature.toString()).toBe("0x" + "00".repeat(64));
  });
});

describe("signing — responseMode 'prompt' (approval window)", () => {
  it("opens an approval request carrying the parsed payload", async () => {
    const { wallet, decisionRequests, setDecision } = makeWallet({ responseMode: "prompt" });
    setDecision("reject");
    await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      payload: { function: "0x1::coin::transfer" },
    } as never);
    expect(decisionRequests).toHaveLength(1);
    const req = decisionRequests[0]!;
    expect(req.kind).toBe("signAndSubmitTransaction");
    expect(req.id).toBeTruthy();
    expect(req.pretty).toContain("0x1::coin::transfer");
  });

  it("returns APPROVED when the user accepts the prompt", async () => {
    const { wallet, setDecision } = makeWallet({ responseMode: "prompt" });
    setDecision("accept");
    const res = await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      payload: {},
    } as never);
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    if (res.status !== UserResponseStatus.APPROVED) throw new Error("unreachable");
    expect(res.args.hash).toBe("0x" + "00".repeat(32));
  });

  it("returns REJECTED when the user rejects the prompt", async () => {
    const { wallet, setDecision } = makeWallet({ responseMode: "prompt" });
    setDecision("reject");
    const res = await wallet.features["aptos:signMessage"].signMessage({
      message: "hi",
      nonce: "1",
    });
    expect(res.status).toBe(UserResponseStatus.REJECTED);
  });
});

describe("changeNetwork", () => {
  it("switches network, fires onNetworkChange, persists, and reports success", async () => {
    const { wallet, networkPersists } = makeWallet({ network: "mainnet", chainId: 1 });
    const cb = vi.fn();
    await wallet.features["aptos:onNetworkChange"].onNetworkChange(cb);

    const res = await wallet.features["aptos:changeNetwork"]!.changeNetwork({
      name: "testnet",
      chainId: 2,
    });
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    if (res.status !== UserResponseStatus.APPROVED) throw new Error("unreachable");
    expect(res.args.success).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(networkPersists).toEqual([{ network: "testnet", chainId: 2 }]);

    const net = await wallet.features["aptos:network"].network();
    expect(net.chainId).toBe(2);
  });

  it("maps the SDK 'local' network to our 'localnet'", async () => {
    const { wallet, networkPersists } = makeWallet();
    await wallet.features["aptos:changeNetwork"]!.changeNetwork({ name: "local", chainId: 4 });
    expect(networkPersists[0]).toEqual({ network: "localnet", chainId: 4 });
  });

  it("does not fire onNetworkChange when already on that network", async () => {
    const { wallet } = makeWallet({ network: "mainnet", chainId: 1 });
    const cb = vi.fn();
    await wallet.features["aptos:onNetworkChange"].onNetworkChange(cb);
    await wallet.features["aptos:changeNetwork"]!.changeNetwork({ name: "mainnet", chainId: 1 });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("advanced transaction shapes (multi-agent / sponsored / orderless)", () => {
  const signTx = (wallet: ViewOnlyWallet, input: unknown) =>
    (wallet.features["aptos:signTransaction"].signTransaction as never as
      (a: unknown) => Promise<{ status: UserResponseStatus; args: Record<string, unknown> }>)(input);

  it("captures a sponsored (fee-payer) transaction and returns authenticator + rawTransaction", async () => {
    const { wallet, recorded } = makeWallet({ responseMode: "accept" });
    const res = await signTx(wallet, {
      payload: { function: "0x1::coin::transfer", functionArguments: ["0x2", 1] },
      feePayer: { address: "0xfeepayer" },
    });
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    expect(res.args.authenticator).toBeInstanceOf(AccountAuthenticatorEd25519);
    expect(res.args.rawTransaction).toBeTruthy();
    expect(recorded[0]!.pretty).toContain("0xfeepayer");
  });

  it("captures a multi-agent transaction's secondary signers", async () => {
    const { wallet, recorded } = makeWallet({ responseMode: "accept" });
    const res = await signTx(wallet, {
      payload: { function: "0x1::x::y" },
      secondarySigners: [{ address: "0xsecondary1" }, { address: "0xsecondary2" }],
    });
    expect(res.status).toBe(UserResponseStatus.APPROVED);
    expect(recorded[0]!.pretty).toContain("0xsecondary1");
    expect(recorded[0]!.pretty).toContain("0xsecondary2");
  });

  it("captures an orderless transaction's replay-protection nonce", async () => {
    const { wallet, recorded } = makeWallet({ responseMode: "reject" });
    await wallet.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
      payload: { function: "0x1::x::y", options: { replayProtectionNonce: "987654321" } },
    } as never);
    expect(recorded[0]!.pretty).toContain("987654321");
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
    const { wallet, recorded } = makeWallet({ responseMode: "reject" });
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
    expect(pretty).toContain('"10000000n"');
    expect(pretty).toContain("0xabcd");
    expect(pretty).toContain('"0x5"');
  });
});
