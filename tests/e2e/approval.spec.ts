import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const IMPERSONATED =
  "0x000000000000000000000000000000000000000000000000000000000000dead";

/**
 * The headline feature: in "prompt" mode a signing request opens the approval
 * window and the dApp's promise stays pending until the user clicks Simulate
 * Accept / Reject (or closes the window).
 */
test.describe("interactive approval window (prompt mode)", () => {
  test("Simulate Accept resolves the dApp with APPROVED and shows the parsed payload", async ({
    context,
    setWalletState,
    getPayloads,
  }) => {
    await setWalletState({ address: IMPERSONATED, responseMode: "prompt" });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    // Kick off the signing request without awaiting — it blocks on approval.
    const approvalPromise = waitForApproval(context);
    const signPromise = page.evaluate(() =>
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

    const approval = await approvalPromise;
    await approval.waitForLoadState();
    // The parsed view shows the function.
    await expect(approval.locator(".vow-fields")).toContainText(
      "0x1::aptos_account::transfer",
    );

    await approval.getByRole("button", { name: "Simulate Accept" }).click();

    const res = await signPromise;
    expect(res.status).toBe("Approved");
    expect(res.hash).toBe("0x" + "00".repeat(32));

    // Payload was captured too.
    await expect
      .poll(() =>
        getPayloads().then((p) => p.some((x) => x.pretty.includes("0x1::aptos_account::transfer"))),
      )
      .toBe(true);
  });

  test("Reject resolves the dApp with a user-rejection", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: IMPERSONATED, responseMode: "prompt" });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const approvalPromise = waitForApproval(context);
    const signPromise = page.evaluate(() =>
      window.VOW_TEST.signAndSubmit("Petra", { payload: { function: "0x1::x::y" } }),
    );

    const approval = await approvalPromise;
    await approval.waitForLoadState();
    await approval.getByRole("button", { name: "Reject" }).click();

    const res = await signPromise;
    expect(res.status).toBe("Rejected");
  });

  test("closing the approval window counts as a rejection (dApp doesn't hang)", async ({
    context,
    setWalletState,
  }) => {
    await setWalletState({ address: IMPERSONATED, responseMode: "prompt" });
    const page = await context.newPage();
    await page.goto("/");
    await connectWhenReady(page);

    const approvalPromise = waitForApproval(context);
    const signPromise = page.evaluate(() =>
      window.VOW_TEST.signMessage("Petra", { message: "prove it", nonce: "1" }),
    );

    const approval = await approvalPromise;
    await approval.waitForLoadState();
    await approval.close();

    const res = await signPromise;
    expect(res.status).toBe("Rejected");
  });
});

function waitForApproval(context: import("@playwright/test").BrowserContext): Promise<Page> {
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
