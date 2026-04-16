# Aptos View-Only Wallet (AIP-62)

A Chrome MV3 extension that impersonates any Aptos address on any dApp via
the official [AIP-62 Wallet
Standard](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-62.md).
When a dApp asks it to sign or submit a transaction, it prints the **entire
payload** (to both the page's devtools console and the extension popup) and
returns a rejected `UserResponse` — nothing is ever signed.

Useful for:

- Previewing the full raw transaction a dApp is about to submit on your
  behalf before signing with a real wallet.
- Debugging dApp integrations where you don't have (or don't want to give
  up) the target account's private key.
- Testing that your AIP-62 wallet-adapter integration handles rejected
  signatures gracefully.

> Primary registration is done through `wallet-standard:register-wallet`,
> the event the AIP-62 / `@aptos-labs/wallet-standard` package standardizes.
>
> **It registers itself as "Petra"** (not "View-Only Wallet") so dApps that
> hard-allowlist wallet names — e.g. `optInWallets={['Petra']}` — still
> surface it. The popup UI inside the extension remains labeled "View-Only
> Wallet" so *you* always know what you're actually running.
>
> **Legacy `window.aptos` / `window.petra` shim** (on by default) — some
> dApps (Aries, Pontem UI, other older integrations) still predate AIP-62
> and discover wallets only by sniffing `window.aptos`. For these, the
> extension also installs a Petra-compatible shim on `window.aptos` and
> `window.petra` (only if nothing else has already claimed those slots).
> You can switch this off in the popup for a strict-AIP-62-only mode that
> never touches `window.*`.

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Install & build](#install--build)
- [Load the extension in Chrome](#load-the-extension-in-chrome)
- [First-run walkthrough](#first-run-walkthrough)
- [Using it on an Aptos dApp](#using-it-on-an-aptos-dapp)
- [Seeing the payload](#seeing-the-payload)
- [Development workflow](#development-workflow)
- [How it works (architecture)](#how-it-works-architecture)
- [What each AIP-62 method does](#what-each-aip-62-method-does)
- [Why a dummy public key?](#why-a-dummy-public-key)
- [Troubleshooting](#troubleshooting)
- [Uninstalling / upgrading](#uninstalling--upgrading)
- [Caveats](#caveats)

---

## Prerequisites

- **Node.js 20+** (Node 24 LTS recommended).
- **pnpm 10+** (`corepack enable && corepack prepare pnpm@latest --activate`
  if you don't already have it).
- A Chromium-based browser that supports MV3 content-script `world: "MAIN"`
  declarations (Chrome 111+, Edge 111+, Brave, Arc, etc.).

---

## Install & build

```bash
# 1. clone
git clone <this-repo> view-only-wallet
cd view-only-wallet

# 2. install deps
pnpm install

# 3. build the production extension
pnpm build
```

After `pnpm build` you'll have an unpacked extension in `dist/`:

```
dist/
├── manifest.json
├── service-worker-loader.js
├── src/popup/index.html
└── assets/            # bundled JS / CSS / sourcemaps
```

Available scripts:

| Script            | What it does                                                                  |
| :---------------- | :---------------------------------------------------------------------------- |
| `pnpm build`      | Production build → `dist/`. Load this folder into Chrome.                     |
| `pnpm dev`        | Vite dev server with HMR for the popup (content scripts require full reload). |
| `pnpm typecheck`  | `tsc --noEmit` — no code is emitted, strict types are verified.               |

---

## Load the extension in Chrome

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`,
   etc.).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Choose the `dist/` folder from this repo.
5. The extension appears as **"Aptos View-Only Wallet"**. Click the puzzle
   icon in the toolbar and **pin** it so you can open the popup easily.

> ⚠️ If you rebuild (`pnpm build`) you must click the little refresh icon on
> the extension's card in `chrome://extensions` for Chrome to pick up the
> new code. Then reload any open dApp tabs.

---

## First-run walkthrough

1. Click the pinned extension icon → the popup opens.
2. In the **Impersonated address** field, paste the Aptos address you want
   to pretend to be. Both short form (`0x1`) and full form
   (`0x0000…0001`) are accepted; the popup normalizes on save.
3. Choose the **Network** dropdown (Mainnet / Testnet / Devnet / Localnet).
   This sets the `chainId` the wallet reports to dApps.
4. **Auto-reject signing requests** checkbox:
   - **On** (default, safe): every `signTransaction` / `signAndSubmitTransaction`
     / `signMessage` call is logged and immediately returns
     `UserResponseStatus.REJECTED`. The dApp's "user cancelled" path runs.
   - **Off**: the wallet still can't actually sign anything, but it returns
     a fake `UserResponseStatus.APPROVED` with all-zero dummy signatures and
     a zero transaction hash. This lets you exercise the dApp's
     post-signing UI flow. ⚠️ The outputs are invalid — nothing is ever on
     chain, and any `waitForTransaction(hash)` call on the dApp side will
     error.
5. **Inject legacy `window.aptos` (Petra shim)** checkbox:
   - **On** (default): in addition to AIP-62 registration, the extension
     installs a Petra-compatible shim on `window.aptos` and `window.petra`
     (only if those slots are free). This is what makes the wallet visible
     to older dApps like Aries and Pontem UI that haven't migrated to the
     wallet-standard discovery path.
   - **Off**: strict AIP-62 only. The extension never touches `window.*`.
     Matches the original design intent — useful for verifying your dApp's
     AIP-62 integration doesn't secretly depend on the legacy API.
   - Changing this requires reloading the dApp tab.
6. Click **Save**. You'll see a confirmation like `✓ Saved 0x0000000… · auto-reject ON · window.aptos ON`.

You can come back to the popup at any time to change the address. The wallet
fires `aptos:onAccountChange` automatically, so any dApp that's already
connected will see the new account without a reconnect.

---

## Using it on an Aptos dApp

Open any Aptos dApp that uses `@aptos-labs/wallet-adapter-react`
(Echelon, Panora, Aries, [explorer.aptoslabs.com](https://explorer.aptoslabs.com),
your own app, etc.).

1. Click **Connect Wallet**.
2. In the wallet picker you'll see an entry named **"Petra"** (the
   extension impersonates Petra — see the note near the top of this README).
   If real Petra is *also* installed, both entries show up; pick the one
   with the plain rounded "P" icon (our impersonation) vs. Petra's
   gradient one.
3. Select it. The dApp calls `aptos:connect`; the extension returns the
   address you entered.
4. Trigger any action that requires signing — a swap, a transfer, a
   `signMessage` prompt, etc.

What you **won't** see is a signing pop-up — the wallet returns `REJECTED`
immediately. What you **will** see is the full payload, both in the page's
devtools console and in the extension popup. See below.

### Minimal dApp integration example

If you're building a dApp and want to test that it handles this wallet
correctly, the standard hook works unchanged:

```tsx
import { useWallet } from "@aptos-labs/wallet-adapter-react";

function Demo() {
  const { connect, wallets, account, signAndSubmitTransaction } = useWallet();

  return (
    <>
      {wallets?.map((w) => (
        <button key={w.name} onClick={() => connect(w.name)}>
          Connect {w.name}
        </button>
      ))}

      {account && (
        <button
          onClick={() =>
            signAndSubmitTransaction({
              data: {
                function: "0x1::aptos_account::transfer",
                functionArguments: [account.address, 100],
              },
            })
          }
        >
          Send 100 Octas
        </button>
      )}
    </>
  );
}
```

With the View-Only Wallet connected, clicking "Send 100 Octas" will:

- log the payload to the page's devtools console,
- append the payload to the extension popup's log,
- reject the promise from the dApp's point of view (your `onClick` catches
  it just like any user-rejection).

---

## Seeing the payload

**In the extension popup**: open it after triggering a transaction — the
**Intercepted payloads** section shows a reverse-chronological list with
the calling origin, the AIP-62 method, a timestamp, and the pretty-printed
payload (scrollable per entry). A blue badge on the toolbar icon shows the
total count. Click **Clear** to reset the log.

**In the page's devtools console**: open DevTools on the dApp tab and look
for a collapsed group tagged `[View-Only Wallet] signAndSubmitTransaction`
(or `signTransaction` / `signMessage`). Expand it to see the full payload.

The pretty-printer handles the tricky types:

| Type                                      | How it's shown                         |
| :---------------------------------------- | :------------------------------------- |
| `BigInt`                                  | `"10000000n"` (suffixed `n`)           |
| `Uint8Array`                              | `"0xabcd…"` (hex-prefixed)             |
| `AccountAddress` / `Ed25519PublicKey` / … | `AccountAddress(0x1)` (ctor-wrapped)   |
| anything else                             | standard JSON                          |

---

## Development workflow

```bash
# Terminal 1: watch-rebuild
pnpm build --watch

# Or: Vite dev server with HMR for the popup only
pnpm dev
```

Iteration loop:

1. Edit code in `src/`.
2. Let Vite rebuild `dist/` (automatic with `--watch`).
3. Go to `chrome://extensions` and click the **↻ reload** button on the
   extension card.
4. Reload any dApp tab you're testing against.

Why the manual reload? Content scripts with `world: "MAIN"` aren't
HMR-compatible because the page's JS realm can't subscribe to the Vite dev
server's WebSocket. The popup (which lives in the extension's own origin)
does get HMR.

Files you're most likely to edit:

| File                   | Purpose                                                      |
| :--------------------- | :----------------------------------------------------------- |
| `src/wallet.ts`        | The AIP-62 `ViewOnlyWallet` class itself.                    |
| `src/legacy-api.ts`    | Pre-AIP-62 `window.aptos` Petra shim (optional).             |
| `src/inject.ts`        | MAIN-world entry: builds the wallet + calls `registerWallet`. |
| `src/content.ts`       | ISOLATED-world bridge between MAIN and the service worker.    |
| `src/background.ts`    | Service worker: storage + toolbar badge.                     |
| `src/popup/popup.ts`   | Popup UI logic.                                              |
| `src/popup/popup.css`  | Popup styles.                                                |
| `manifest.config.ts`   | MV3 manifest as TypeScript (via `@crxjs/vite-plugin`).       |

---

## How it works (architecture)

```
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ page / MAIN world            │       │ content / ISOLATED world     │
│                              │       │                              │
│  ┌────────────────────────┐  │ post  │  chrome.runtime.sendMessage  │
│  │ ViewOnlyWallet         │──┼───────┼──▶ chrome.storage            │
│  │ (AIP-62 features)      │  │       │                              │
│  │                        │  │◀──────┤  storage.onChanged streams   │
│  │ registerWallet(this)   │  │ post  │  back "state-changed"        │
│  └────────────────────────┘  │       │                              │
└──────────────────────────────┘       └──────────────────────────────┘
```

- **`src/inject.ts`** runs in the page's MAIN world. It creates the
  `ViewOnlyWallet` and calls `registerWallet(wallet)`, which dispatches the
  standard `wallet-standard:register-wallet` event. dApps listening for
  that event discover the wallet immediately.
- **`src/wallet.ts`** implements every required AIP-62 feature
  (`aptos:connect`, `aptos:disconnect`, `aptos:account`, `aptos:network`,
  `aptos:onAccountChange`, `aptos:onNetworkChange`, `aptos:signTransaction`,
  `aptos:signAndSubmitTransaction`, `aptos:signMessage`). Signing methods
  pretty-print the payload and return `UserResponseStatus.REJECTED`.
- **`src/content.ts`** bridges MAIN ↔ service worker via
  `window.postMessage` ↔ `chrome.runtime.sendMessage`.
- **`src/background.ts`** owns `chrome.storage.local` (state + payload log)
  and drives the toolbar badge.
- **`src/popup/`** is a tiny vanilla-TS UI for setting the impersonated
  address + network and reviewing the log of intercepted payloads.

---

## What each AIP-62 method does

The three signing rows depend on the **Auto-reject** toggle in the popup.
Default is `on`.

| AIP-62 feature                    | `auto-reject: on`                                                         | `auto-reject: off`                                                                    |
| :-------------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------------------------------ |
| `aptos:connect`                   | Returns the impersonated `AccountInfo` (with a zero dummy public key).    | _(same)_                                                                              |
| `aptos:disconnect`                | Marks the wallet disconnected.                                            | _(same)_                                                                              |
| `aptos:account`                   | Returns the current `AccountInfo`.                                        | _(same)_                                                                              |
| `aptos:network`                   | Returns the selected `NetworkInfo` (name + chainId).                      | _(same)_                                                                              |
| `aptos:onAccountChange`           | Registers a callback; fires when you change address in the popup.         | _(same)_                                                                              |
| `aptos:onNetworkChange`           | Registers a callback; fires when you change network in the popup.         | _(same)_                                                                              |
| `aptos:signAndSubmitTransaction`  | Logs payload, returns `REJECTED`.                                         | Logs payload, returns `APPROVED` with `hash = 0x0…0`.                                 |
| `aptos:signTransaction` (v1.0)    | Logs payload, returns `REJECTED`.                                         | Logs payload, returns `APPROVED` with an all-zero `AccountAuthenticatorEd25519`.      |
| `aptos:signTransaction` (v1.1)    | Logs payload, returns `REJECTED`.                                         | Logs payload, returns `APPROVED` with `{ authenticator, rawTransaction }` (both dummy). |
| `aptos:signMessage`               | Logs input, returns `REJECTED`.                                           | Logs input, returns `APPROVED` with an all-zero `Ed25519Signature` + full `APTOS…` envelope. |

---

## Why a dummy public key?

A view-only wallet has no private key and therefore no authoritative public
key. Because `AccountInfo.publicKey` is required by the wallet standard, the
wallet returns an all-zero `Ed25519PublicKey`. This is intentionally
recognizable as "not real" — if any dApp tries to verify a signature against
it, the verification will fail loudly rather than silently accepting bogus
signatures.

---

## Troubleshooting

**"Petra" doesn't show up in the dApp's wallet picker.**
- Make sure you reloaded the dApp tab *after* loading the extension.
- Confirm the extension is enabled in `chrome://extensions`.
- Open the page's devtools console on the dApp; you should see the wallet
  log its own registration noise when you trigger a transaction. If
  nothing at all happens, the content script likely isn't injecting — check
  that the URL isn't on a Chrome-restricted origin (like
  `chrome://extensions`, the Chrome Web Store, etc., which all block
  content scripts).
- If the dApp is older (Aries, Pontem UI, etc.) and discovers wallets via
  `window.aptos`, make sure **Inject legacy window.aptos** is ON in the
  popup and reload the dApp tab.
- If real Petra is also installed, it owns `window.aptos` first — the shim
  won't overwrite it. Disable Petra temporarily in `chrome://extensions`
  to let the shim claim the slot.

**Connect fails / wallet says "no address configured".**
- Open the popup and save an address first. Until an address is saved,
  `aptos:connect` returns `REJECTED` so the dApp treats it as a cancelled
  connection.

**I see the payload in the popup but not in the devtools console.**
- The console log is on the *page's* devtools, not the extension's. Open
  DevTools on the dApp tab itself, then look for a collapsed group named
  `[View-Only Wallet] …`.

**I updated the code but Chrome is running the old version.**
- Run `pnpm build` (or have `pnpm build --watch` running), then click the
  **↻** icon on the extension's card in `chrome://extensions`, and
  reload the dApp tab.

**Popup shows an "Invalid Aptos address" error.**
- The input must parse via `AccountAddress.from(...)` from
  `@aptos-labs/ts-sdk`. Both `0x1` and the zero-padded 64-hex form are
  valid; arbitrary strings are not.

---

## Uninstalling / upgrading

- **Uninstall**: go to `chrome://extensions` and click **Remove** on the
  extension card. This deletes `chrome.storage.local`, so your impersonated
  address and payload log are gone.
- **Upgrade**: `git pull && pnpm install && pnpm build`, then click the
  **↻** icon on the extension card. Saved state survives.

---

## Caveats

- By default, returns `REJECTED` for every signing request. This is a
  correct status in the standard, but if a dApp treats "rejected" as "fatal
  error" it will surface an error UI. Toggle **Auto-reject** off in the
  popup if you need the dApp to see an `APPROVED` response — note that the
  signatures and hash produced are all-zero dummies and will not round-trip
  through the chain.
- No simulated-transaction support. The payload is recorded as-is; the
  wallet does not call `aptos.transaction.simulate` for you.
- Firefox is not supported yet — MV3 content-script `world: "MAIN"` ships
  in Firefox 128+, and this extension hasn't been tested there. PRs welcome.
- The Aptos SDK is bundled at ~900 KB (~520 KB gzipped). Loaded lazily via
  dynamic import, so the inject entry itself is only ~7 KB.
