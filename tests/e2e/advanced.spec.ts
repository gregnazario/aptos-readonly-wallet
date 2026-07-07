import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const IMPERSONATED =
  "0x000000000000000000000000000000000000000000000000000000000000dead";

test.describe("changeNetwork + advanced transaction types", () => {
  test("changeNetwork switches the reported network", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: IMPERSONATED, network: "mainnet", chainId: 1 });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const before = await page.evaluate(() => window.VOW_TEST.network("Petra"));
    expect(before.chainId).toBe(1);

    const res = await page.evaluate(() =>
      window.VOW_TEST.changeNetwork("Petra", "testnet", 2),
    );
    expect(res.status).toBe("Approved");
    expect(res.success).toBe(true);

    await expect
      .poll(() => page.evaluate(() => window.VOW_TEST.network("Petra").then((n) => n.chainId)))
      .toBe(2);
  });

  test("captures a sponsored + multi-agent signTransaction and returns an authenticator", async ({
    context,
    setWalletState,
    getPayloads,
  }) => {
    await setWalletState({ address: IMPERSONATED, responseMode: "accept" });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const res = await page.evaluate(() =>
      window.VOW_TEST.signTransaction("Petra", {
        payload: {
          function: "0x1::aptos_account::transfer",
          functionArguments: ["0x2", 1],
        },
        feePayer: { address: "0xfeepayer00" },
        secondarySigners: [{ address: "0xsecondaryaa" }],
        sequenceNumber: "10",
      }),
    );
    expect(res.status).toBe("Approved");
    expect(res.hasAuth).toBe(true);

    // Fee payer + secondary signer are captured in the logged payload.
    await expect
      .poll(() =>
        getPayloads().then((p) =>
          p.some(
            (x) => x.pretty.includes("0xfeepayer00") && x.pretty.includes("0xsecondaryaa"),
          ),
        ),
      )
      .toBe(true);
  });

  test("captures an orderless signAndSubmitTransaction (replay nonce)", async ({
    context,
    setWalletState,
    getPayloads,
  }) => {
    await setWalletState({ address: IMPERSONATED, responseMode: "reject" });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    await page.evaluate(() =>
      window.VOW_TEST.signAndSubmit("Petra", {
        payload: {
          function: "0x1::aptos_account::transfer",
          functionArguments: ["0x2", 1],
          options: { replayProtectionNonce: "555000555" },
        },
      }),
    );
    await expect
      .poll(() => getPayloads().then((p) => p.some((x) => x.pretty.includes("555000555"))))
      .toBe(true);
  });
});

async function connectWhenReady(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        try {
          if (!window.VOW_TEST.walletNames().includes("Petra")) return "no-wallet";
          return (await window.VOW_TEST.connect("Petra")).status;
        } catch {
          return "error";
        }
      }),
    )
    .toBe("Approved");
}
