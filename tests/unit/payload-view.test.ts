import { describe, expect, it } from "vitest";
import { parsePayload } from "../../src/shared/payload-view";

const field = (
  fields: { label: string; value: string }[],
  match: string,
) => fields.find((f) => f.label.includes(match));

describe("parsePayload — basic transaction", () => {
  it("extracts function, type args, and arguments", () => {
    const p = parsePayload(
      "signAndSubmitTransaction",
      JSON.stringify({
        payload: {
          function: "0x1::coin::transfer",
          typeArguments: ["0x1::aptos_coin::AptosCoin"],
          functionArguments: ["0x2", 100],
        },
      }),
    );
    expect(field(p.fields, "Function")!.value).toBe("0x1::coin::transfer");
    expect(field(p.fields, "Type args")!.value).toContain("AptosCoin");
    expect(field(p.fields, "Arguments")!.label).toContain("2");
  });

  it("falls back to raw when JSON can't parse", () => {
    const p = parsePayload("signTransaction", "not json");
    expect(p.fields).toHaveLength(0);
    expect(p.raw).toBe("not json");
  });
});

describe("parsePayload — advanced attributes", () => {
  it("surfaces a sponsored fee payer", () => {
    const p = parsePayload(
      "signTransaction",
      JSON.stringify({ payload: { function: "0x1::a::b" }, feePayer: { address: "0xfee" } }),
    );
    expect(field(p.fields, "Fee payer")!.value).toBe("0xfee");
  });

  it("surfaces multi-agent secondary signers with a count", () => {
    const p = parsePayload(
      "signTransaction",
      JSON.stringify({
        payload: { function: "x" },
        secondarySigners: [{ address: "0xaa" }, { address: "0xbb" }],
      }),
    );
    const f = field(p.fields, "Secondary signers");
    expect(f).toBeTruthy();
    expect(f!.label).toContain("2");
    expect(f!.value).toContain("0xaa");
    expect(f!.value).toContain("0xbb");
  });

  it("surfaces the orderless replay-protection nonce", () => {
    const p = parsePayload(
      "signAndSubmitTransaction",
      JSON.stringify({ payload: { function: "x", options: { replayProtectionNonce: "12345" } } }),
    );
    expect(field(p.fields, "Orderless")!.value).toBe("12345");
  });

  it("surfaces sender and sequence number", () => {
    const p = parsePayload(
      "signTransaction",
      JSON.stringify({ payload: { function: "x" }, sender: { address: "0x1" }, sequenceNumber: "7" }),
    );
    expect(field(p.fields, "Sender")!.value).toBe("0x1");
    expect(field(p.fields, "Sequence")!.value).toBe("7");
  });
});

describe("parsePayload — signMessage", () => {
  it("extracts message, nonce, and included fields", () => {
    const p = parsePayload(
      "signMessage",
      JSON.stringify({ message: "hi there", nonce: "42", address: true, application: true }),
    );
    expect(field(p.fields, "Message")!.value).toBe("hi there");
    expect(field(p.fields, "Nonce")!.value).toBe("42");
    expect(field(p.fields, "Includes")!.value).toContain("address");
  });
});
