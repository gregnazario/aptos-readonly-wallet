import { describe, expect, it } from "vitest";
import {
  AccountAddress,
  Ed25519PublicKey,
  Ed25519Signature,
} from "@aptos-labs/ts-sdk";
import { prettyPrint, toHexString } from "../../src/shared/serialize";

describe("toHexString", () => {
  it("hex-encodes bytes with a 0x prefix and zero-padding", () => {
    expect(toHexString(new Uint8Array([0, 1, 15, 16, 255]))).toBe("0x00010f10ff");
    expect(toHexString(new Uint8Array())).toBe("0x");
  });
});

describe("prettyPrint", () => {
  it("suffixes bigints with n so they survive JSON", () => {
    expect(prettyPrint({ amount: 10000000n })).toContain('"10000000n"');
  });

  it("hex-encodes Uint8Array", () => {
    expect(prettyPrint({ data: new Uint8Array([0xab, 0xcd]) })).toContain('"0xabcd"');
  });

  it("collapses SDK class instances to their canonical string, minification-safe", () => {
    // These classes have mangled constructor names in the shipped SDK build
    // (e.g. "e"), so the collapse must NOT rely on the class name.
    const fullAddr = "0x" + "abc".padStart(64, "0");
    const out = prettyPrint({
      addr: AccountAddress.from(fullAddr),
      pubkey: new Ed25519PublicKey(new Uint8Array(32)),
      sig: new Ed25519Signature(new Uint8Array(64)),
    });
    expect(out).toContain(`"${fullAddr}"`);
    expect(out).toContain('"0x' + "00".repeat(32) + '"'); // pubkey
    expect(out).toContain('"0x' + "00".repeat(64) + '"'); // signature
    // No leaked internal structure.
    expect(out).not.toContain('"data"');
  });

  it("preserves plain objects and arrays structurally", () => {
    const out = prettyPrint({
      function: "0x1::coin::transfer",
      typeArguments: ["0x1::aptos_coin::AptosCoin"],
      functionArguments: ["0x2", 100],
    });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      function: "0x1::coin::transfer",
      typeArguments: ["0x1::aptos_coin::AptosCoin"],
      functionArguments: ["0x2", 100],
    });
  });

  it("keeps null and primitives intact", () => {
    expect(prettyPrint(null)).toBe("null");
    expect(prettyPrint({ a: null, b: true, c: 3 })).toBe(
      '{\n  "a": null,\n  "b": true,\n  "c": 3\n}',
    );
  });
});
