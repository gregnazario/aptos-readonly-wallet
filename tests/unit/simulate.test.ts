import { describe, expect, it } from "vitest";
import { DEFAULT_STATE, type LoggedPayload, type WalletState } from "../../src/shared/messages";
import {
  buildSimulationInput,
  isSimulatable,
  octasToApt,
  simulatePayload,
  summarizeResponse,
} from "../../src/shared/simulate";

function state(overrides: Partial<WalletState> = {}): WalletState {
  return { ...DEFAULT_STATE, address: "0x1", ...overrides };
}

function item(kind: LoggedPayload["kind"], payload: unknown): Pick<LoggedPayload, "kind" | "pretty"> {
  return { kind, pretty: JSON.stringify(payload) };
}

/** A minimal UserTransactionResponse-shaped object for summarizeResponse. */
function resp(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    vm_status: "Executed successfully",
    gas_used: "120",
    gas_unit_price: "100",
    events: [{}, {}],
    changes: [{}, {}, {}],
    ...overrides,
  } as never;
}

describe("isSimulatable", () => {
  it("is true for transactions, false for messages", () => {
    expect(isSimulatable("signAndSubmitTransaction")).toBe(true);
    expect(isSimulatable("signTransaction")).toBe(true);
    expect(isSimulatable("signMessage")).toBe(false);
  });
});

describe("buildSimulationInput", () => {
  it("reconstructs a single-signer entry-function call", () => {
    const built = buildSimulationInput(
      state(),
      item("signAndSubmitTransaction", {
        payload: {
          function: "0x1::aptos_account::transfer",
          typeArguments: [],
          functionArguments: ["0x2", 100],
        },
      }),
    );
    expect("unsupported" in built).toBe(false);
    if ("unsupported" in built) throw new Error("unreachable");
    expect(built.data.function).toBe("0x1::aptos_account::transfer");
    expect(built.data.functionArguments).toEqual(["0x2", 100]);
    expect(built.sender).toBe("0x1");
    expect(built.withFeePayer).toBe(false);
  });

  it("revives bigint-serialized arguments (strips the trailing n)", () => {
    const built = buildSimulationInput(
      state(),
      item("signAndSubmitTransaction", {
        payload: { function: "0x1::coin::transfer", functionArguments: ["10000000n", "0x2"] },
      }),
    );
    if ("unsupported" in built) throw new Error("unreachable");
    expect(built.data.functionArguments).toEqual(["10000000", "0x2"]);
  });

  it("prefers an explicit sender over the impersonated address", () => {
    const built = buildSimulationInput(
      state({ address: "0x1" }),
      item("signTransaction", {
        payload: { function: "0x1::a::b" },
        sender: { address: "0x99" },
      }),
    );
    if ("unsupported" in built) throw new Error("unreachable");
    expect(built.sender).toBe("0x99");
  });

  it("detects a sponsored (fee-payer) transaction", () => {
    const built = buildSimulationInput(
      state(),
      item("signTransaction", {
        payload: { function: "0x1::a::b" },
        feePayer: { address: "0xfee" },
      }),
    );
    if ("unsupported" in built) throw new Error("unreachable");
    expect(built.withFeePayer).toBe(true);
  });

  it("marks signMessage as unsupported", () => {
    const built = buildSimulationInput(state(), item("signMessage", { message: "hi", nonce: "1" }));
    expect("unsupported" in built).toBe(true);
  });

  it("marks multi-agent transactions as unsupported", () => {
    const built = buildSimulationInput(
      state(),
      item("signTransaction", {
        payload: { function: "0x1::a::b" },
        secondarySigners: [{ address: "0xaa" }],
      }),
    );
    expect(built).toHaveProperty("unsupported");
  });

  it("marks non-entry-function (raw/script) payloads as unsupported", () => {
    const built = buildSimulationInput(
      state(),
      item("signTransaction", { rawTransaction: { some: "bytes" }, asFeePayer: false }),
    );
    expect(built).toHaveProperty("unsupported");
  });

  it("marks a payload with no sender as unsupported", () => {
    const built = buildSimulationInput(
      state({ address: null }),
      item("signAndSubmitTransaction", { payload: { function: "0x1::a::b" } }),
    );
    expect(built).toHaveProperty("unsupported");
  });
});

describe("octasToApt", () => {
  it("formats octas as trimmed APT", () => {
    expect(octasToApt(100_000_000n)).toBe("1");
    expect(octasToApt(12_000n)).toBe("0.00012");
    expect(octasToApt(0n)).toBe("0");
    expect(octasToApt(150_000_000n)).toBe("1.5");
  });
});

describe("summarizeResponse", () => {
  it("summarizes a successful simulation and computes the fee", () => {
    const out = summarizeResponse(resp());
    expect(out.status).toBe("success");
    if (out.status !== "success") throw new Error("unreachable");
    expect(out.gasUsed).toBe("120");
    expect(out.gasUnitPrice).toBe("100");
    // 120 * 100 = 12000 octas = 0.00012 APT
    expect(out.feeApt).toBe("0.00012");
    expect(out.events).toBe(2);
    expect(out.changes).toBe(3);
  });

  it("marks a failing simulation with its VM status", () => {
    const out = summarizeResponse(resp({ success: false, vm_status: "MOVE_ABORT 0x1" }));
    expect(out.status).toBe("failure");
    if (out.status !== "failure") throw new Error("unreachable");
    expect(out.vmStatus).toBe("MOVE_ABORT 0x1");
  });
});

describe("simulatePayload", () => {
  const entryItem = item("signAndSubmitTransaction", {
    payload: { function: "0x1::aptos_account::transfer", functionArguments: ["0x2", 1] },
  });

  it("runs the injected simulator and normalizes the result", async () => {
    const out = await simulatePayload(state(), entryItem, {
      simulator: async () => resp(),
    });
    expect(out.status).toBe("success");
  });

  it("returns unsupported without calling the simulator", async () => {
    let called = false;
    const out = await simulatePayload(state(), item("signMessage", { message: "x", nonce: "1" }), {
      simulator: async () => {
        called = true;
        return resp();
      },
    });
    expect(out.status).toBe("unsupported");
    expect(called).toBe(false);
  });

  it("turns a simulator throw into an error outcome (never rejects)", async () => {
    const out = await simulatePayload(state(), entryItem, {
      simulator: async () => {
        throw new Error("network down");
      },
    });
    expect(out.status).toBe("error");
    if (out.status !== "error") throw new Error("unreachable");
    expect(out.reason).toContain("network down");
  });

  it("passes the selected network through to the simulator", async () => {
    let seen: string | undefined;
    await simulatePayload(state({ network: "testnet", chainId: 2 }), entryItem, {
      simulator: async (network) => {
        seen = network;
        return resp();
      },
    });
    expect(seen).toBe("testnet");
  });
});
