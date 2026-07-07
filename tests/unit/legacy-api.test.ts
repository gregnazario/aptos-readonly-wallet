import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyPetraAPI, type LegacyApiBridge } from "../../src/legacy-api";
import {
  DEFAULT_STATE,
  type ApprovalRequest,
  type Decision,
  type LoggedPayload,
  type WalletState,
} from "../../src/shared/messages";

const ADDR = "0x1";

function makeBridge(initial: Partial<WalletState> = {}) {
  let current: WalletState = { ...DEFAULT_STATE, address: ADDR, ...initial };
  let stateCb: ((s: WalletState) => void) | undefined;
  const recorded: LoggedPayload[] = [];
  const decisionRequests: ApprovalRequest[] = [];
  let answer: Decision = "reject";
  const bridge: LegacyApiBridge = {
    getState: () => current,
    recordPayload: (p) => recorded.push(p),
    onStateChanged: (cb) => {
      stateCb = cb;
    },
    requestDecision: (req) => {
      decisionRequests.push(req);
      return Promise.resolve(answer);
    },
  };
  return {
    bridge,
    recorded,
    decisionRequests,
    setDecision(d: Decision) {
      answer = d;
    },
    setState(next: Partial<WalletState>) {
      current = { ...current, ...next };
      stateCb?.(current);
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "groupCollapsed").mockImplementation(() => {});
  vi.spyOn(console, "groupEnd").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("LegacyPetraAPI identity + reads", () => {
  it("advertises isPetra so name-gated dApps proceed", () => {
    const { bridge } = makeBridge();
    expect(new LegacyPetraAPI(bridge).isPetra).toBe(true);
  });

  it("connect returns the address + dummy public key", async () => {
    const { bridge } = makeBridge();
    const res = await new LegacyPetraAPI(bridge).connect();
    expect(res.address).toBe(ADDR);
    expect(res.publicKey).toBe("0x" + "00".repeat(32));
  });

  it("connect throws when no address configured", async () => {
    const { bridge } = makeBridge({ address: null });
    await expect(new LegacyPetraAPI(bridge).connect()).rejects.toThrow(/no address configured/i);
  });

  it("network capitalizes the name Petra-style and stringifies chainId", async () => {
    const { bridge } = makeBridge({ network: "testnet", chainId: 2 });
    const net = await new LegacyPetraAPI(bridge).network();
    expect(net.name).toBe("Testnet");
    expect(net.chainId).toBe("2");
  });
});

describe("LegacyPetraAPI signing — responseMode 'reject'", () => {
  it("throws a Petra-shaped 4001 error and still logs the payload", async () => {
    const { bridge, recorded, decisionRequests } = makeBridge({ responseMode: "reject" });
    const api = new LegacyPetraAPI(bridge);
    await expect(api.signAndSubmitTransaction({ function: "0x1::x::y" })).rejects.toMatchObject({
      code: 4001,
    });
    expect(recorded).toHaveLength(1);
    expect(decisionRequests).toHaveLength(0);
  });

  it("throws on signTransaction and signMessage too", async () => {
    const { bridge } = makeBridge({ responseMode: "reject" });
    const api = new LegacyPetraAPI(bridge);
    await expect(api.signTransaction({})).rejects.toMatchObject({ code: 4001 });
    await expect(api.signMessage({ message: "m", nonce: "1" })).rejects.toMatchObject({
      code: 4001,
    });
  });
});

describe("LegacyPetraAPI signing — responseMode 'accept'", () => {
  it("fake-approves signAndSubmitTransaction", async () => {
    const { bridge } = makeBridge({ responseMode: "accept" });
    const res = await new LegacyPetraAPI(bridge).signAndSubmitTransaction({});
    expect(res.hash).toBe("0x" + "00".repeat(32));
  });

  it("signTransaction returns a 96-byte zero blob", async () => {
    const { bridge } = makeBridge({ responseMode: "accept" });
    const res = await new LegacyPetraAPI(bridge).signTransaction({});
    expect(res).toBeInstanceOf(Uint8Array);
    expect(res).toHaveLength(96);
    expect(Array.from(res).every((b) => b === 0)).toBe(true);
  });

  it("signMessage returns the APTOS envelope with dummy signature", async () => {
    const { bridge } = makeBridge({ responseMode: "accept", chainId: 2 });
    const res = await new LegacyPetraAPI(bridge).signMessage({
      message: "hello",
      nonce: "9",
      application: true,
      chainId: true,
    });
    expect(res.prefix).toBe("APTOS");
    expect(res.signature).toBe("0x" + "00".repeat(64));
    expect(res.fullMessage).toContain("message: hello");
    expect(res.chainId).toBe(2);
  });
});

describe("LegacyPetraAPI signing — responseMode 'prompt'", () => {
  it("prompts, then throws when the user rejects", async () => {
    const h = makeBridge({ responseMode: "prompt" });
    h.setDecision("reject");
    await expect(
      new LegacyPetraAPI(h.bridge).signAndSubmitTransaction({ function: "0x1::a::b" }),
    ).rejects.toMatchObject({ code: 4001 });
    expect(h.decisionRequests).toHaveLength(1);
    expect(h.decisionRequests[0]!.pretty).toContain("0x1::a::b");
  });

  it("prompts, then fake-approves when the user accepts", async () => {
    const h = makeBridge({ responseMode: "prompt" });
    h.setDecision("accept");
    const res = await new LegacyPetraAPI(h.bridge).signAndSubmitTransaction({});
    expect(res.hash).toBe("0x" + "00".repeat(32));
    expect(h.decisionRequests).toHaveLength(1);
  });
});

describe("LegacyPetraAPI events", () => {
  it("emits accountChange when the popup sets a new address", () => {
    const h = makeBridge();
    const api = new LegacyPetraAPI(h.bridge);
    const cb = vi.fn();
    api.onAccountChange(cb);
    h.setState({ address: "0x2" });
    expect(cb).toHaveBeenCalledWith({ address: "0x2", publicKey: "0x" + "00".repeat(32) });
  });

  it("emits disconnect when the address is cleared", () => {
    const h = makeBridge();
    const api = new LegacyPetraAPI(h.bridge);
    const cb = vi.fn();
    api.onDisconnect(cb);
    h.setState({ address: null });
    expect(cb).toHaveBeenCalled();
  });

  it("supports the generic on()/off() subscription pattern", () => {
    const h = makeBridge();
    const api = new LegacyPetraAPI(h.bridge);
    const cb = vi.fn();
    api.on("networkChange", cb);
    h.setState({ network: "devnet", chainId: 3 });
    expect(cb).toHaveBeenCalledTimes(1);
    api.off("networkChange", cb);
    h.setState({ network: "testnet", chainId: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
