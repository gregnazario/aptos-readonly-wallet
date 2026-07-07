/**
 * Shape of the `window.VOW_TEST` helper the local test dApp
 * (`tests/e2e/dapp/index.html`) exposes for Playwright to drive.
 */
export {};

declare global {
  interface Window {
    VOW_TEST: {
      walletNames: () => string[];
      connect: (
        name: string,
      ) => Promise<{ status: string; address: string | null; publicKey: string | null }>;
      network: (name: string) => Promise<{ name: string; chainId: number }>;
      signAndSubmit: (
        name: string,
        payload: unknown,
      ) => Promise<{ status: string; hash: string | null }>;
      signMessage: (
        name: string,
        input: unknown,
      ) => Promise<{ status: string; fullMessage: string | null }>;
      hasLegacy: () => boolean;
      legacyConnect: () => Promise<{ address: string; publicKey: string }>;
      legacySignAndSubmit: (payload: unknown) => Promise<{ hash: string }>;
    };
  }
}
