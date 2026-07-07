import { test, expect } from "./fixtures";

test.describe("AIP-62 wallet registration", () => {
  test("registers as Petra and installs the legacy window.aptos shim by default", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: "0x1", impersonatePetra: true, injectLegacyApi: true });

    const page = await context.newPage();
    await page.goto("/");

    // The wallet should surface via the standard discovery handshake.
    await expect
      .poll(() => page.evaluate(() => window.VOW_TEST.walletNames()))
      .toContain("Petra");

    // Legacy shim present for older dApps.
    await expect
      .poll(() => page.evaluate(() => window.VOW_TEST.hasLegacy()))
      .toBe(true);
  });

  test("registers honestly as View-Only Wallet when impersonation is off", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: "0x1", impersonatePetra: false });

    const page = await context.newPage();
    await page.goto("/");

    await expect
      .poll(() => page.evaluate(() => window.VOW_TEST.walletNames()))
      .toContain("View-Only Wallet");
  });

  test("strict AIP-62 mode never touches window.aptos", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: "0x1", injectLegacyApi: false });

    const page = await context.newPage();
    await page.goto("/");

    await expect
      .poll(() => page.evaluate(() => window.VOW_TEST.walletNames().length))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.VOW_TEST.hasLegacy())).toBe(false);
  });
});
