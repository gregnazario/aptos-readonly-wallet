/**
 * Transaction simulation. The whole point of a view-only wallet is to see what
 * a transaction *would* do without signing it — simulation is how we show that.
 *
 * The Aptos fullnode can simulate a transaction with no valid signature: the
 * TS SDK's `simulate.simple` skips the authentication-key check when no
 * `signerPublicKey` is supplied, so we can preview a transaction for an
 * arbitrary impersonated address that we hold no key for.
 *
 * This module is deliberately split into pure, unit-testable pieces
 * (`buildSimulationInput`, `summarizeResponse`) and a thin network layer
 * (`simulatePayload`, whose fullnode call is injectable so tests never hit the
 * network). It runs only from extension-origin pages (popup / approval), which
 * have host permissions to reach the fullnode; the MAIN-world wallet never
 * simulates (page CSP would block it).
 */
import {
  Aptos,
  AptosConfig,
  type InputEntryFunctionData,
  Network,
  type UserTransactionResponse,
} from "@aptos-labs/ts-sdk";
import type { LoggedPayload, WalletState } from "./messages";

/** A reconstructed, simulation-ready single-signer entry-function call. */
export interface SimulationInput {
  sender: string;
  withFeePayer: boolean;
  data: {
    function: `${string}::${string}::${string}`;
    typeArguments: string[];
    functionArguments: unknown[];
  };
}

/** Normalized, UI-ready result of a simulation attempt. */
export type SimulationOutcome =
  | {
      status: "success" | "failure";
      vmStatus: string;
      gasUsed: string;
      gasUnitPrice: string;
      feeApt: string;
      events: number;
      changes: number;
      raw: unknown;
    }
  | { status: "unsupported"; reason: string }
  | { status: "error"; reason: string };

/** Only transactions can be simulated — signMessage has nothing to execute. */
export function isSimulatable(kind: LoggedPayload["kind"]): boolean {
  return kind === "signAndSubmitTransaction" || kind === "signTransaction";
}

/**
 * Revive a serialized argument back toward the "simple" form the SDK's
 * ABI-driven builder expects. `prettyPrint` renders bigints as `"123n"`; strip
 * the trailing `n` so integer arguments parse. Everything else (hex strings,
 * numbers, booleans) is already in an acceptable shape.
 */
function reviveArg(v: unknown): unknown {
  if (typeof v === "string" && /^\d+n$/.test(v)) return v.slice(0, -1);
  if (Array.isArray(v)) return v.map(reviveArg);
  return v;
}

function addrOf(x: unknown): string | undefined {
  if (typeof x === "string") return x;
  if (x && typeof x === "object" && typeof (x as { address?: unknown }).address === "string") {
    return (x as { address: string }).address;
  }
  return undefined;
}

/**
 * Reconstruct a simulation input from a logged payload, or explain why we
 * can't. We support the common case: a single-signer entry-function call
 * (optionally sponsored/fee-payer). Multi-agent transactions and raw v1.0
 * transactions (already-built, opaque byte blobs) aren't reconstructable from
 * the logged shape.
 */
export function buildSimulationInput(
  state: WalletState,
  item: Pick<LoggedPayload, "kind" | "pretty">,
): SimulationInput | { unsupported: string } {
  if (!isSimulatable(item.kind)) {
    return { unsupported: "Only transactions can be simulated." };
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(item.pretty) as Record<string, unknown>;
  } catch {
    return { unsupported: "Payload isn't valid JSON — can't reconstruct it." };
  }

  const secondary = obj.secondarySigners ?? obj.secondarySignerAddresses;
  if (Array.isArray(secondary) && secondary.length > 0) {
    return { unsupported: "Multi-agent transactions aren't supported for simulation yet." };
  }

  const body = ((obj.payload ?? obj.data ?? obj) ?? {}) as Record<string, unknown>;
  const fn = body.function;
  if (typeof fn !== "string" || fn.split("::").length !== 3) {
    return {
      unsupported:
        "Not a reconstructable entry-function call (e.g. a raw or script transaction).",
    };
  }

  const sender = addrOf(obj.sender) ?? state.address ?? undefined;
  if (!sender) {
    return { unsupported: "No sender address — set an impersonated address first." };
  }

  const typeArgsRaw = body.typeArguments ?? body.type_arguments ?? [];
  const typeArguments = Array.isArray(typeArgsRaw) ? typeArgsRaw.map(String) : [];
  const argsRaw = body.functionArguments ?? body.arguments ?? body.args ?? [];
  const functionArguments = (Array.isArray(argsRaw) ? argsRaw : []).map(reviveArg);

  const withFeePayer =
    obj.feePayer != null || obj.withFeePayer === true || obj.asFeePayer === true;

  return {
    sender,
    withFeePayer,
    data: {
      function: fn as `${string}::${string}::${string}`,
      typeArguments,
      functionArguments,
    },
  };
}

/** Octas (u64, 1 APT = 1e8 octas) → a trimmed decimal APT string. */
export function octasToApt(octas: bigint): string {
  const neg = octas < 0n;
  const abs = neg ? -octas : octas;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  const s = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

/** Normalize a fullnode `UserTransactionResponse` into a UI-ready summary. */
export function summarizeResponse(resp: UserTransactionResponse): SimulationOutcome {
  const gasUsed = String(resp.gas_used ?? "0");
  const gasUnitPrice = String(resp.gas_unit_price ?? "0");
  let feeApt = "0";
  try {
    feeApt = octasToApt(BigInt(gasUsed) * BigInt(gasUnitPrice));
  } catch {
    feeApt = "?";
  }
  return {
    status: resp.success ? "success" : "failure",
    vmStatus: String(resp.vm_status ?? ""),
    gasUsed,
    gasUnitPrice,
    feeApt,
    events: Array.isArray(resp.events) ? resp.events.length : 0,
    changes: Array.isArray(resp.changes) ? resp.changes.length : 0,
    raw: resp,
  };
}

const SDK_NETWORK: Record<WalletState["network"], Network> = {
  mainnet: Network.MAINNET,
  testnet: Network.TESTNET,
  devnet: Network.DEVNET,
  localnet: Network.LOCAL,
};

/** The actual fullnode round-trip (build + simulate). Injectable for tests. */
export type Simulator = (
  network: WalletState["network"],
  input: SimulationInput,
) => Promise<UserTransactionResponse>;

const defaultSimulator: Simulator = async (network, input) => {
  const aptos = new Aptos(new AptosConfig({ network: SDK_NETWORK[network] }));
  const transaction = await aptos.transaction.build.simple({
    sender: input.sender,
    data: input.data as InputEntryFunctionData,
    withFeePayer: input.withFeePayer,
  });
  const [resp] = await aptos.transaction.simulate.simple({
    transaction,
    options: { estimateGasUnitPrice: true, estimateMaxGasAmount: true },
  });
  if (!resp) throw new Error("Fullnode returned an empty simulation result.");
  return resp;
};

/**
 * Reconstruct, simulate, and normalize a logged payload. Never throws: a
 * reconstruction gap becomes `unsupported`, a network/VM failure becomes
 * `error`, so callers can always render something (and offer Retry).
 */
export async function simulatePayload(
  state: WalletState,
  item: Pick<LoggedPayload, "kind" | "pretty">,
  deps: { simulator?: Simulator } = {},
): Promise<SimulationOutcome> {
  const built = buildSimulationInput(state, item);
  if ("unsupported" in built) return { status: "unsupported", reason: built.unsupported };
  try {
    const simulator = deps.simulator ?? defaultSimulator;
    const resp = await simulator(state.network, built);
    return summarizeResponse(resp);
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}
