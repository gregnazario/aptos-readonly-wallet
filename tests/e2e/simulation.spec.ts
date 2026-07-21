import { test, expect } from "./fixtures";
import type { BrowserContext, Page } from "@playwright/test";

const IMPERSONATED =
  "0x000000000000000000000000000000000000000000000000000000000000dead";

/**
 * With the `simulate` toggle on, the approval window shows a Simulation panel
 * with a Retry button. We assert the panel renders end-to-end (the actual
 * fullnode result is network-dependent, so we don't assert its contents) and
 * that the decision buttons still work alongside it.
 */
test.describe("transaction simulation panel", () => {
  test("approval window renders a Simulation panel with a run/retry control", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({
      address: IMPERSONATED,
      responseMode: "prompt",
      simulate: true,
    });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const approvalPromise = waitForApproval(context);
    const signPromise = page.evaluate(() =>
      window.VOW_TEST.signAndSubmit("Petra", {
        payload: {
          function: "0x1::aptos_account::transfer",
          functionArguments: [
            "0x000000000000000000000000000000000000000000000000000000000000beef",
            1,
          ],
        },
      }),
    );

    const approval = await approvalPromise;
    await approval.waitForLoadState();

    // The Simulation panel is present with its run/retry control.
    await expect(approval.locator(".vow-sim .vow-sim-title")).toHaveText("Simulation");
    await expect(approval.locator(".vow-sim .vow-sim-run")).toBeVisible();
    // The run button settles to either "Retry" (ran) or "Simulate"/"Simulating…".
    await expect(approval.locator(".vow-sim .vow-sim-run")).toContainText(
      /Retry|Simulat/,
    );

    // The decision buttons still work with the panel present.
    await approval.getByRole("button", { name: "Reject" }).click();
    const res = await signPromise;
    expect(res.status).toBe("Rejected");
  });

  test("no Simulation panel when the simulate toggle is off", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({
      address: IMPERSONATED,
      responseMode: "prompt",
      simulate: false,
    });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const approvalPromise = waitForApproval(context);
    const signPromise = page.evaluate(() =>
      window.VOW_TEST.signAndSubmit("Petra", { payload: { function: "0x1::x::y" } }),
    );

    const approval = await approvalPromise;
    await approval.waitForLoadState();
    await expect(approval.locator(".vow-fields")).toBeVisible();
    await expect(approval.locator(".vow-sim")).toHaveCount(0);

    await approval.getByRole("button", { name: "Reject" }).click();
    const res = await signPromise;
    expect(res.status).toBe("Rejected");
  });
});

function waitForApproval(context: BrowserContext): Promise<Page> {
  return context.waitForEvent("page", {
    predicate: (p) => p.url().includes("approval/index.html"),
  });
}

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
