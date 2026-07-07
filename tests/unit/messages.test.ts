import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  DEFAULT_STATE,
  VOW_TAG,
  type WalletState,
} from "../../src/shared/messages";

describe("shared/messages contract", () => {
  it("uses a stable postMessage discriminator tag", () => {
    expect(VOW_TAG).toBe("view-only-wallet");
  });

  it("defaults to the safe view-preserving configuration", () => {
    // auto-reject ON is the safety default: nothing is ever fake-approved
    // unless the user explicitly opts out in the popup.
    expect(DEFAULT_STATE).toEqual({
      address: null,
      network: "mainnet",
      chainId: 1,
      autoReject: true,
      injectLegacyApi: true,
      impersonatePetra: true,
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
