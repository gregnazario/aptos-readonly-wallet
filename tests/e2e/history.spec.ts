import { test, expect } from "./fixtures";

/** The full-page history view: list, delete one, clear all. */
test.describe("history page", () => {
  test("lists captured payloads, deletes one, and clears all", async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await serviceWorker.evaluate(() =>
      chrome.storage.local.set({
        payloads: [
          {
            timestamp: 1000,
            origin: "https://a.test",
            kind: "signAndSubmitTransaction",
            pretty: JSON.stringify({ payload: { function: "0x1::alpha::one" } }, null, 2),
          },
          {
            timestamp: 2000,
            origin: "https://b.test",
            kind: "signMessage",
            pretty: JSON.stringify({ message: "hi", nonce: "1" }, null, 2),
          },
        ],
      }),
    );

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/history/index.html`);

    await expect(page.locator(".entry")).toHaveCount(2);
    await expect(page.locator("#count")).toContainText("2 payloads");
    await expect(page.locator(".entry").first()).toContainText("0x1::alpha::one");

    // Delete the first entry.
    await page.locator(".entry").first().getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".entry")).toHaveCount(1);
    await expect(page.locator(".entry").first()).toContainText("signMessage");

    // Clear all (confirm() dialog).
    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.locator(".empty")).toBeVisible();
    await expect(page.locator(".entry")).toHaveCount(0);
  });
});
