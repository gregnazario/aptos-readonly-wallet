import { test, expect } from "./fixtures";

/**
 * Live smoke test against the example dApp from the goal, https://app.thala.fi.
 *
 * This intentionally does NOT drive Thala's own "Connect Wallet" UI — that
 * markup changes without notice and would make the suite flaky. Instead it
 * proves the two things that actually matter on the *real target origin*:
 *
 *   1. our content scripts inject and register the AIP-62 wallet there, and
 *   2. the connect → sign → capture pipeline works end-to-end on that origin
 *      (so a payload built by real dApp code would be captured too).
 *
 * It is network-dependent, so it auto-skips when the site is unreachable or
 * when VOW_E2E_SKIP_LIVE is set.
 */
const THALA_URL = "https://app.thala.fi";
const IMPERSONATED =
  "0x000000000000000000000000000000000000000000000000000000000000cafe";

test.describe("live smoke: app.thala.fi", () => {
  test.skip(
    !!process.env.VOW_E2E_SKIP_LIVE,
    "VOW_E2E_SKIP_LIVE set — skipping network-dependent live test",
  );
  // Real site + wallet SDK load; give it room.
  test.setTimeout(90_000);

  test("injects, registers, and captures a payload on the real Thala origin", async ({
    context,
    setWalletState,
    getPayloads,
  }) => {
    await setWalletState({ address: IMPERSONATED, network: "mainnet", responseMode: "reject" });

    const page = await context.newPage();
    try {
      await page.goto(THALA_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      test.skip(true, `Could not reach ${THALA_URL}: ${(e as Error).message}`);
      return;
    }

    // Run the wallet-standard app-side handshake ourselves on Thala's origin
    // and confirm our impersonating wallet registered there.
    const names = await pollWalletNames(page);
    expect(names, `wallets registered on ${THALA_URL}: ${names.join(", ")}`).toContain(
      "Petra",
    );

    // Drive connect + signAndSubmit through the standard interface on the real
    // origin and assert a clean rejection (nothing signed).
    const result = await page.evaluate(async (impersonated) => {
      const wallets: any[] = [];
      const api = { register: (...w: any[]) => wallets.push(...w) };
      window.addEventListener("wallet-standard:register-wallet", (e: any) => e.detail(api));
      window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
      await new Promise((r) => setTimeout(r, 300));

      const w = wallets.find((x) => x.name === "Petra");
      if (!w) return { error: "petra-missing" };

      // Retry connect until the impersonated address has propagated.
      let connectStatus = "";
      let address: string | null = null;
      for (let i = 0; i < 20; i++) {
        const c = await w.features["aptos:connect"].connect(false, undefined);
        connectStatus = c.status;
        if (c.args) address = c.args.address.toString();
        if (connectStatus === "Approved") break;
        await new Promise((r) => setTimeout(r, 150));
      }

      const s = await w.features["aptos:signAndSubmitTransaction"].signAndSubmitTransaction({
        payload: {
          function: "0x1::aptos_account::transfer",
          functionArguments: [impersonated, 1],
        },
      });

      return { connectStatus, address, signStatus: s.status };
    }, IMPERSONATED);

    expect(result.error).toBeUndefined();
    expect(result.connectStatus).toBe("Approved");
    expect(result.address).toBe(IMPERSONATED);
    expect(result.signStatus).toBe("Rejected");

    // The payload was captured on the real origin.
    await expect
      .poll(() =>
        getPayloads().then((p) =>
          p.some(
            (x) =>
              x.origin.includes("thala.fi") &&
              x.pretty.includes("0x1::aptos_account::transfer"),
          ),
        ),
      )
      .toBe(true);
  });
});

async function pollWalletNames(page: import("@playwright/test").Page): Promise<string[]> {
  let names: string[] = [];
  await expect
    .poll(
      async () => {
        names = await page.evaluate(
          () =>
            new Promise<string[]>((resolve) => {
              const wallets: any[] = [];
              const api = { register: (...w: any[]) => wallets.push(...w) };
              window.addEventListener("wallet-standard:register-wallet", (e: any) =>
                e.detail(api),
              );
              window.dispatchEvent(
                new CustomEvent("wallet-standard:app-ready", { detail: api }),
              );
              setTimeout(() => resolve(wallets.map((w) => w.name)), 400);
            }),
        );
        return names.includes("Petra");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return names;
}
