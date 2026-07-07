# Aptos View-Only Wallet (AIP-62)

A Chrome MV3 extension that impersonates any Aptos address on any dApp via
the official [AIP-62 Wallet
Standard](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-62.md).
When a dApp asks it to sign or submit a transaction, it logs the **entire
payload** and (by default) opens an **approval window** showing the payload
parsed nicely, with buttons to **copy / download the raw JSON** and to
**Simulate Accept** or **Reject**. Nothing is ever actually signed — Simulate
Accept just returns an all-zero dummy signature. You can also switch to
"always reject" or "always accept" modes that skip the window.

In short: it turns any Aptos dApp into a **transaction-payload builder** that's
decoupled from signing. You drive the dApp's real UI as any account, and instead
of signing you get the exact payload — to inspect, to copy, or to execute with a
different signer.

## What it's for

- **See exactly what a dApp will make you sign — before you sign it.** Connect
  as your own address, click through the action, and read the fully-parsed
  payload (function, type args, arguments, fee payer, secondary signers). Catch
  a drainer, a wrong recipient, or a buggy amount while your real keys are still
  nowhere near the page.

- **Build in a dApp, sign somewhere safer.** The payload is one click to copy or
  download as JSON, so a dApp UI becomes a transaction *builder* for a signer it
  never sees: the [Aptos CLI](https://aptos.dev/tools/aptos-cli), the TS SDK, a
  **multisig / governance** proposal, or an **air-gapped / cold** wallet. Great
  when the account that should sign can't (or shouldn't) be pasted into a browser.

- **Impersonate any address to debug or investigate.** No private key required —
  connect as any account to reproduce a user's bug, see what a treasury / whale /
  multisig would actually submit, or QA account-specific UI you don't hold keys
  for.

- **Test your dApp's wallet integration end to end.** As a dApp developer, verify
  your app handles user **rejection**, the **post-signing success path** (Simulate
  Accept), **account / network changes**, and advanced transactions —
  **multi-agent**, **sponsored / fee-payer**, **orderless**, and **sign-message** —
  and that it doesn't secretly depend on the legacy `window.aptos` API.

- **Keep an audit trail.** Every intercepted request is logged with its origin and
  timestamp, browsable and exportable from the full-page history view.

> ⚠️ Nothing is ever signed or submitted on-chain. "Simulate Accept" returns an
> all-zero dummy signature so a dApp's success path can run, but that response is
> invalid — use the captured payload with a real signer to actually execute.

> Primary registration is done through `wallet-standard:register-wallet`,
> the event the AIP-62 / `@aptos-labs/wallet-standard` package standardizes.
>
> **By default it registers itself as "Petra"** (not "View-Only Wallet") so
> dApps that hard-allowlist wallet names — e.g. `optInWallets={['Petra']}`
> — still surface it. You can flip a toggle in the popup to register under
> the honest "View-Only Wallet" name + eye icon instead. The popup UI
> inside the extension is always labeled "View-Only Wallet" so *you*
> always know what you're actually running.
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

- [What it's for](#what-its-for)
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
4. **On signing request** dropdown:
   - **Ask me (approval window)** (default): every `signTransaction` /
     `signAndSubmitTransaction` / `signMessage` call opens an approval window
     showing the parsed payload + raw JSON (with Copy / Download) and
     **Simulate Accept** / **Reject** buttons. The dApp's promise stays
     pending until you click; closing the window counts as a rejection.
   - **Always reject**: every request is logged and immediately returns
     `UserResponseStatus.REJECTED`, no window. The dApp's "user cancelled"
     path runs.
   - **Always simulate accept**: immediately returns a fake
     `UserResponseStatus.APPROVED` with all-zero dummy signatures and a zero
     transaction hash, no window. Exercises the dApp's post-signing UI flow.
     ⚠️ The outputs are invalid — nothing is ever on chain, and any
     `waitForTransaction(hash)` call will error.

   **Simulate Accept** (whether via the window or "always accept") produces
   the same all-zero dummy outputs — it is never a real signature.
5. **Register as Petra** checkbox:
   - **On** (default): the AIP-62 wallet registers with `name: "Petra"`
     and a Petra-style P icon. Required for dApps that allowlist wallets
     by name.
   - **Off**: registers with `name: "View-Only Wallet"` and a blue eye
     icon. Honest, but dApps that filter on `"Petra"` won't see it.
   - Changing this requires reloading the dApp tab because
     `wallet-standard` caches wallets by name.
6. **Inject legacy `window.aptos` (Petra shim)** checkbox:
   - **On** (default): in addition to AIP-62 registration, the extension
     installs a Petra-compatible shim on `window.aptos` and `window.petra`
     (only if those slots are free). This is what makes the wallet visible
     to older dApps like Aries and Pontem UI that haven't migrated to the
     wallet-standard discovery path.
   - **Off**: strict AIP-62 only. The extension never touches `window.*`.
     Matches the original design intent — useful for verifying your dApp's
     AIP-62 integration doesn't secretly depend on the legacy API.
   - Changing this requires reloading the dApp tab.
7. Click **Save**. You'll see a confirmation like `✓ Saved 0x0000000… · as Petra · ask me · window.aptos ON`.

You can come back to the popup at any time to change the address. The wallet
fires `aptos:onAccountChange` automatically, so any dApp that's already
connected will see the new account without a reconnect.

### The payload log & full history

Every intercepted payload is logged. The popup shows the most recent few
(parsed, each with Copy / Download). Click **View all ↗** (or right-click the
extension → **Options**) to open the **full-page history**: every captured
payload with per-entry **Copy** / **Download** / **Delete**, plus **Copy all**,
**Download all**, and **Clear all**. The toolbar badge shows the count.

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
| `AccountAddress` / `Ed25519PublicKey` / … | `"0x1"` (canonical string)             |
| anything else                             | standard JSON                          |

SDK class instances are collapsed to their canonical string via
`constructor !== Object` rather than by class name — the Aptos SDK ships
minified, so any name-based check would be dead code in a real build. The
serializer lives in `src/shared/serialize.ts` and is shared by the AIP-62
wallet and the legacy shim.

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

### Testing

| Command             | What it runs                                                                   |
| :------------------ | :----------------------------------------------------------------------------- |
| `pnpm test`         | Vitest unit tests (`tests/unit/`) — wallet logic, legacy shim, serializer.     |
| `pnpm test:watch`   | Vitest in watch mode.                                                          |
| `pnpm test:e2e`     | Playwright E2E (`tests/e2e/`) — loads the built extension in real Chromium.    |
| `pnpm test:all`     | `typecheck` → unit → `build` → E2E, in order. The full gate.                   |

**Unit tests** run in a `happy-dom` environment and exercise the wallet /
legacy-shim behavior directly with a mock bridge (no browser needed).

**E2E tests** launch headless Chromium with the built `dist/` extension
loaded (`channel: "chromium"` — the full build, not headless-shell), seed
`chrome.storage` via the service worker, and drive a local test dApp
(`tests/e2e/dapp/`, served by `tests/e2e/server.mjs`) through the real
AIP-62 discovery handshake. They assert the payload is captured in storage.

Before running E2E the first time:

```bash
pnpm build                       # produce dist/ (the extension under test)
npx playwright install chromium  # download the browser
pnpm test:e2e
```

The suite includes a **live smoke test against `https://app.thala.fi`**
(`tests/e2e/thala.spec.ts`) that verifies the extension injects and captures
a payload on the real target origin. It auto-skips when the site is
unreachable, or set `VOW_E2E_SKIP_LIVE=1` to skip it deliberately.

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

- **`src/inject.ts`** runs in the page's MAIN world. It requests the stored
  state, then creates the `ViewOnlyWallet` and calls `registerWallet(wallet)`,
  which dispatches the standard `wallet-standard:register-wallet` event.
  Registration is deferred until the first state arrives (with a 500 ms
  fallback) so the wallet registers under the correct identity — Petra vs.
  View-Only Wallet — since `wallet-standard` caches wallets by name and can't
  rename them afterward. wallet-standard's late-registration path re-announces
  the wallet to dApps that are already listening.
- **`src/wallet.ts`** implements every required AIP-62 feature plus
  `aptos:changeNetwork` (`aptos:connect`, `aptos:disconnect`, `aptos:account`,
  `aptos:network`, `aptos:onAccountChange`, `aptos:onNetworkChange`,
  `aptos:changeNetwork`, `aptos:signTransaction`,
  `aptos:signAndSubmitTransaction`, `aptos:signMessage`). Signing methods
  pretty-print the payload, then resolve per `responseMode`: instant
  reject/accept, or — in "prompt" mode — await the user's decision from the
  approval window before returning. `changeNetwork` switches the reported
  network (persisting it so the popup and `onNetworkChange` subscribers
  follow).
- **`src/content.ts`** bridges MAIN ↔ service worker via
  `window.postMessage` ↔ `chrome.runtime.sendMessage`, and relays approval
  decisions from the background back into the page.
- **`src/background.ts`** owns `chrome.storage.local` (state + payload log),
  drives the toolbar badge, and manages the **approval-window lifecycle**:
  it opens a window per prompt (tracking it in `chrome.storage.session`),
  routes the Accept/Reject decision back to the exact tab/frame that asked,
  and treats a closed window as a rejection.
- **`src/approval/`** is the approval window UI (parsed payload + raw JSON
  copy/download + Simulate Accept / Reject).
- **`src/popup/`** sets the impersonated address / network / response mode
  and shows a compact payload log.
- **`src/history/`** is the full-page history view (also the options page):
  every captured payload with per-entry and bulk copy/download/delete.
- **`src/shared/`** holds the cross-realm message contract
  (`messages.ts`), the payload serializer (`serialize.ts`), and the shared
  payload-rendering helpers (`payload-view.ts`).

---

## What each AIP-62 method does

The three signing rows depend on the **On signing request** mode in the popup
(default **Ask me**). In Ask-me mode the approval window is shown first, then
the row behaves as the "reject" or "accept" column below depending on which
button you click (or the "reject" column if you close the window).

| AIP-62 feature                    | reject (window Reject, or "always reject")                               | accept (window Simulate Accept, or "always accept")                                   |
| :-------------------------------- | :------------------------------------------------------------------------ | :------------------------------------------------------------------------------------ |
| `aptos:connect`                   | Returns the impersonated `AccountInfo` (never prompts).                   | _(same)_                                                                              |
| `aptos:disconnect`                | Marks the wallet disconnected.                                            | _(same)_                                                                              |
| `aptos:account`                   | Returns the current `AccountInfo`.                                        | _(same)_                                                                              |
| `aptos:network`                   | Returns the selected `NetworkInfo` (name + chainId).                      | _(same)_                                                                              |
| `aptos:onAccountChange`           | Registers a callback; fires when you change address in the popup.         | _(same)_                                                                              |
| `aptos:onNetworkChange`           | Registers a callback; fires when you change network (popup or `changeNetwork`). | _(same)_                                                                        |
| `aptos:changeNetwork`             | Switches + persists the reported network, returns `{ success: true }` (never prompts). | _(same)_                                                              |
| `aptos:signAndSubmitTransaction`  | Logs payload, returns `REJECTED`.                                         | Logs payload, returns `APPROVED` with `hash = 0x0…0`.                                 |
| `aptos:signTransaction` (v1.0)    | Logs payload, returns `REJECTED`.                                         | Logs payload, returns `APPROVED` with an all-zero `AccountAuthenticatorEd25519`.      |
| `aptos:signTransaction` (v1.1)    | Logs payload, returns `REJECTED`.                                         | Logs payload, returns `APPROVED` with `{ authenticator, rawTransaction }` (both dummy). |
| `aptos:signMessage`               | Logs input, returns `REJECTED`.                                           | Logs input, returns `APPROVED` with an all-zero `Ed25519Signature` + full `APTOS…` envelope. |

**Advanced transaction types.** `signTransaction` accepts the full AIP-62 v1.1
input, so **multi-agent** (secondary signers), **sponsored / fee-payer**, and
**orderless** (replay-protection nonce) transactions all work: they're captured
in full and the approval window / log surface the sender, fee payer, secondary
signers, sequence number, and orderless nonce as parsed fields. A view-only
wallet returns one dummy `AccountAuthenticator` per signer (as each signer
would), so the output shape is correct even though the signature is all-zero.

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

**"Petra" / "View-Only Wallet" doesn't show up in the dApp's wallet picker.**
- Make sure you reloaded the dApp tab *after* loading the extension (or
  after toggling **Register as Petra** — wallet-standard caches by name).
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

- Any "approved" response is a fake. Simulate Accept returns all-zero dummy
  signatures / a zero hash so a dApp's success path runs, but nothing is on
  chain — a dApp that then calls `waitForTransaction(hash)` will error. Use
  the captured payload with a real signer to actually execute.
- In "Always reject" mode the wallet returns `REJECTED`, which is a correct
  status in the standard — but a dApp that treats "rejected" as a fatal error
  will surface an error UI. Use "Ask me" or "Always accept" if you need the
  dApp to see an `APPROVED` response.
- No simulated-transaction support. The payload is recorded as-is; the
  wallet does not call `aptos.transaction.simulate` for you.
- Firefox is not supported yet — MV3 content-script `world: "MAIN"` ships
  in Firefox 128+, and this extension hasn't been tested there. PRs welcome.
- The Aptos SDK (~900 KB, ~520 KB gzipped) is bundled into a separate chunk
  and loaded with the MAIN-world content script on every page.
