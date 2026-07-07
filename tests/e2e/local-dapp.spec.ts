import { test, expect } from "./fixtures";

const IMPERSONATED =
  "0x000000000000000000000000000000000000000000000000000000000000dead";

/**
 * End-to-end coverage of the core promise: connect as an arbitrary account,
 * interact with a dApp, and have the transaction payload captured (so it can
 * be executed elsewhere) instead of signed.
 */
test.describe("connect + payload capture (AIP-62)", () => {
  test("connects as the impersonated account with a recognizably-fake key", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: IMPERSONATED, network: "testnet", chainId: 2 });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const connect = await page.evaluate(() => window.VOW_TEST.connect("Petra"));
    expect(connect.status).toBe("Approved");
    expect(connect.address).toBe(IMPERSONATED);
    expect(connect.publicKey).toBe("0x" + "00".repeat(32));

    const net = await page.evaluate(() => window.VOW_TEST.network("Petra"));
    expect(net.chainId).toBe(2);
  });

  test("captures a signAndSubmitTransaction payload and rejects (auto-reject ON)", async ({
    context,
    setWalletState,
    getPayloads,
  }) => {
    await setWalletState({ address: IMPERSONATED, autoReject: true });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const res = await page.evaluate(() =>
      window.VOW_TEST.signAndSubmit("Petra", {
        payload: {
          function: "0x1::aptos_account::transfer",
          functionArguments: [
            "0x000000000000000000000000000000000000000000000000000000000000beef",
            100,
          ],
        },
      }),
    );
    // Nothing is ever signed: the dApp sees a clean user-rejection.
    expect(res.status).toBe("Rejected");

    // …but the payload was captured for the user to execute elsewhere.
    await expect.poll(() => getPayloads().then((p) => p.length)).toBeGreaterThan(0);
    const payloads = await getPayloads();
    const entry = payloads.find((p) => p.kind === "signAndSubmitTransaction");
    expect(entry).toBeTruthy();
    expect(entry!.pretty).toContain("0x1::aptos_account::transfer");
    expect(entry!.pretty).toContain("beef");
    expect(entry!.origin).toContain("localhost");
  });

  test("fake-approves with a zero hash when auto-reject is OFF", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: IMPERSONATED, autoReject: false });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const res = await page.evaluate(() =>
      window.VOW_TEST.signAndSubmit("Petra", { payload: { function: "0x1::x::y" } }),
    );
    expect(res.status).toBe("Approved");
    expect(res.hash).toBe("0x" + "00".repeat(32));
  });

  test("captures signMessage input", async ({ context, setWalletState, getPayloads }) => {
    await setWalletState({ address: IMPERSONATED, autoReject: true });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const res = await page.evaluate(() =>
      window.VOW_TEST.signMessage("Petra", { message: "verify ownership", nonce: "7" }),
    );
    expect(res.status).toBe("Rejected");
    await expect
      .poll(() => getPayloads().then((p) => p.some((x) => x.kind === "signMessage")))
      .toBe(true);
    const entry = (await getPayloads()).find((p) => p.kind === "signMessage");
    expect(entry!.pretty).toContain("verify ownership");
  });

  test("legacy window.aptos path also captures payloads", async ({
    context,
    setWalletState,
    getPayloads,
  }) => {
    await setWalletState({ address: IMPERSONATED, autoReject: true, injectLegacyApi: true });
    const page = await context.newPage();
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => window.VOW_TEST.hasLegacy())).toBe(true);

    const legacyAddr = await page.evaluate(() => window.VOW_TEST.legacyConnect());
    expect(legacyAddr.address).toBe(IMPERSONATED);

    // Legacy API models auto-reject by throwing (Petra-style), but still logs.
    const threw = await page.evaluate(async () => {
      try {
        await window.VOW_TEST.legacySignAndSubmit({ function: "0x1::legacy::call" });
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);

    await expect
      .poll(() =>
        getPayloads().then((p) => p.some((x) => x.pretty.includes("0x1::legacy::call"))),
      )
      .toBe(true);
  });
});

/**
 * Wait until the wallet is registered AND the impersonated address has
 * propagated from storage, then leave the dApp connected. Registration is
 * deferred until state arrives, so both can lag a beat behind page load.
 */
async function connectWhenReady(page: import("@playwright/test").Page) {
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
