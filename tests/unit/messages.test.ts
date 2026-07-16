import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  DEFAULT_STATE,
  normalizeState,
  VOW_TAG,
  type WalletState,
} from "../../src/shared/messages";

describe("shared/messages contract", () => {
  it("uses a stable postMessage discriminator tag", () => {
    expect(VOW_TAG).toBe("view-only-wallet");
  });

  it("defaults to prompting the user for each signing request", () => {
    expect(DEFAULT_STATE).toEqual({
      address: null,
      network: "mainnet",
      chainId: 1,
      responseMode: "prompt",
      injectLegacyApi: true,
      impersonatePetra: true,
      simulate: true,
    } satisfies WalletState);
  });

  it("maps every network to its canonical Aptos chain id", () => {
    expect(CHAIN_IDS).toEqual({
      mainnet: 1,
      testnet: 2,
      devnet: 3,
      localnet: 4,
    });
  });

  it("keeps DEFAULT_STATE.chainId in sync with CHAIN_IDS", () => {
    expect(DEFAULT_STATE.chainId).toBe(CHAIN_IDS[DEFAULT_STATE.network]);
  });
});

describe("normalizeState", () => {
  it("fills defaults for empty / nullish input", () => {
    expect(normalizeState(undefined)).toEqual(DEFAULT_STATE);
    expect(normalizeState({})).toEqual(DEFAULT_STATE);
  });

  it("migrates the legacy autoReject flag to responseMode", () => {
    expect(normalizeState({ autoReject: true }).responseMode).toBe("reject");
    expect(normalizeState({ autoReject: false }).responseMode).toBe("accept");
  });

  it("prefers an explicit responseMode over the legacy flag", () => {
    expect(
      normalizeState({ responseMode: "prompt", autoReject: true }).responseMode,
    ).toBe("prompt");
  });

  it("derives chainId from the network when absent and rejects junk networks", () => {
    expect(normalizeState({ network: "testnet" }).chainId).toBe(2);
    const bad = normalizeState({ network: "bogus" as WalletState["network"] });
    expect(bad.network).toBe("mainnet");
    expect(bad.chainId).toBe(1);
  });

  it("preserves a valid full state", () => {
    const s: WalletState = {
      address: "0x1",
      network: "devnet",
      chainId: 3,
      responseMode: "accept",
      injectLegacyApi: false,
      impersonatePetra: false,
      simulate: false,
    };
    expect(normalizeState(s)).toEqual(s);
  });

  it("defaults simulate to on and preserves an explicit choice", () => {
    expect(normalizeState({}).simulate).toBe(true);
    expect(normalizeState({ simulate: false }).simulate).toBe(false);
    expect(normalizeState({ simulate: true }).simulate).toBe(true);
  });
});
