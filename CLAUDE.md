# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension implementing an AIP-62 view-only Aptos wallet. It impersonates any Aptos address, and instead of signing transactions it pretty-prints the full payload (to the page's devtools console and the extension popup) and returns a rejected (or optionally a fake-approved, all-zero-dummy) `UserResponse`. It holds no private key.

## Commands

```bash
pnpm install          # install deps (pnpm 10+, Node 20+ required)
pnpm build            # production build → dist/ (load this unpacked in Chrome)
pnpm build --watch    # watch-rebuild during development
pnpm dev              # Vite dev server; HMR works for the popup ONLY
pnpm typecheck        # tsc --noEmit, strict mode
pnpm test             # Vitest unit tests (tests/unit/, happy-dom env)
pnpm test:e2e         # Playwright E2E (tests/e2e/) — loads dist/ in real Chromium
pnpm test:all         # typecheck → unit → build → e2e (the full gate)
```

After any rebuild you must click ↻ on the extension card in `chrome://extensions` and reload the dApp tab — MAIN-world content scripts are not HMR-compatible.

**Testing.** Unit tests exercise wallet/legacy-shim/serializer logic with a mock bridge (no browser). E2E launches headless Chromium (`channel: "chromium"` — the full build supports extensions; headless-shell does not) with the built `dist/` loaded, seeds `chrome.storage` via the service worker, and drives a local test dApp (`tests/e2e/dapp/`, served by `tests/e2e/server.mjs`) plus a live `app.thala.fi` smoke test that auto-skips when offline (or with `VOW_E2E_SKIP_LIVE=1`). E2E requires `pnpm build` first and `npx playwright install chromium`. Note `tsconfig.json` only includes `src/`, so `pnpm typecheck` does not cover the `tests/` dir — the test runners transpile those.

## Architecture: three JS realms

The extension runs across three isolated JavaScript realms that cannot share memory or call each other directly. Understanding which realm code runs in is essential — it determines which APIs are available.

1. **MAIN world** (the page's own realm) — `src/inject.ts`, `src/wallet.ts`, `src/legacy-api.ts`. Can dispatch `wallet-standard:register-wallet` and touch `window.aptos`/`window.petra`, but **cannot** use `chrome.*` APIs. `inject.ts` synchronously registers a `ViewOnlyWallet` with `DEFAULT_STATE` at `document_start` (so the wallet is discoverable immediately), then fetches real state asynchronously and applies it via the state-change path.
2. **ISOLATED world** (content script) — `src/content.ts`. The only realm touching *both* `window.postMessage` and `chrome.*`. Pure bridge: forwards page→background messages and streams `chrome.storage` changes back to the page.
3. **Service worker** — `src/background.ts`. Owns `chrome.storage.local` and the toolbar badge.

The **popup** (`src/popup/`, vanilla TS) is its own extension-origin page and reads/writes `chrome.storage.local` **directly** (not via the service worker).

### Message flow

```
MAIN (wallet) ──window.postMessage(VOW_TAG)──▶ ISOLATED ──chrome.runtime──▶ background ──▶ chrome.storage
MAIN (wallet) ◀──window.postMessage(VOW_TAG)── ISOLATED ◀──storage.onChanged── (state-changed)
```

`src/shared/messages.ts` is the **contract** shared by all realms — message types (`VOW_TAG` discriminator), `WalletState`, `LoggedPayload`, `DEFAULT_STATE`, `CHAIN_IDS`. Changing a shape here affects every realm; keep it in sync.

## Key invariants

- **No private key.** All signatures/pubkey/hash are all-zero dummies (`DUMMY_PUBKEY`, `DUMMY_SIGNATURE`, `DUMMY_AUTHENTICATOR`, `DUMMY_TX_HASH` in `wallet.ts`), intentionally recognizable as fake so signature verification fails loudly.
- **Wallet identity is frozen at registration.** `wallet-standard` caches wallets by name, so `name`/`url`/`icon` are read from the initial state in the `ViewOnlyWallet` constructor and never change at runtime. `inject.ts` therefore **defers `registerWallet()` until the first stored state arrives** (500 ms fallback) so the correct identity (`impersonatePetra` → "Petra" vs "View-Only Wallet") is used — registering with hardcoded defaults would make that toggle dead. Changing `impersonatePetra`/`injectLegacyApi` afterward still needs a dApp reload. Address and network changes, by contrast, propagate live via `aptos:onAccountChange` / `aptos:onNetworkChange`.
- **Payload serialization lives in `src/shared/serialize.ts`** (shared by `wallet.ts` and `legacy-api.ts`). It detects SDK class instances via `constructor !== Object`, NOT by class name — the SDK ships minified, so `constructor.name` is mangled (`"e"`, `"bt"`) and any name-based check is dead code.
- **`responseMode` (default `"prompt"`)** decides how signing methods answer: `"reject"`/`"accept"` resolve instantly; `"prompt"` opens the **approval window** and the dApp's promise stays pending until the user clicks Simulate Accept / Reject (closing the window = reject). `"accept"` (and Simulate Accept) returns dummy all-zero data — nothing is on-chain and `waitForTransaction` will fail. `normalizeState()` in `messages.ts` migrates the old `autoReject` boolean (true→reject, false→accept).
- **Approval round-trip:** `wallet.ts` → `inject.ts` bridge (`requestDecision`, pending resolvers keyed by request id) → `window.postMessage` → `content.ts` → `background.ts` (opens the window, tracks pending in `chrome.storage.session`, routes the decision back via `chrome.tabs.sendMessage` to the originating frame). `connect` never prompts — only the three signing methods do.
- **Extension UI pages:** `src/approval/` (the prompt window), `src/popup/` (config + compact log), `src/history/` (options page; full log with bulk copy/download/delete). They share parse/render helpers in `src/shared/payload-view.ts`.
- **Legacy `window.aptos`/`window.petra` shim** (`legacy-api.ts`, default on) only claims those slots if free — it never clobbers a real Petra install.
- **`aptos:signTransaction` handles both v1.0 (positional raw tx → returns authenticator) and v1.1 (object with `payload` → returns `{authenticator, rawTransaction}`)** forms at runtime; see the union handling in `wallet.ts`. The v1.1 input carries **multi-agent** (`secondarySigners`), **sponsored/fee-payer** (`feePayer`), and **orderless** (`options.replayProtectionNonce`) transactions — all captured and surfaced as parsed fields by `parsePayload` in `payload-view.ts`. Returning one dummy `AccountAuthenticator` per signer is correct for all of these.
- **`aptos:changeNetwork`** switches the reported network and **persists** it (via a `set-network` message → background → `chrome.storage.local`) so the popup and `onNetworkChange` subscribers follow. It updates in-memory state first so the storage round-trip's `state-changed` doesn't double-fire `onNetworkChange`. The SDK `Network` enum uses `"local"`; our state uses `"localnet"` — `resolveNetwork()` maps between them.

## Build config

`manifest.config.ts` is the MV3 manifest authored as TypeScript, consumed by `@crxjs/vite-plugin` in `vite.config.ts`. Two content scripts are declared: `inject.ts` (`world: "MAIN"`) and `content.ts` (`world: "ISOLATED"`), both at `document_start`, `all_frames`. The `@aptos-labs/ts-sdk` (~900 KB) is imported for SDK types/classes used in serialization.

**CRXJS gotcha:** CRXJS only bundles HTML pages it finds in the manifest — the popup (via `action.default_popup`) and history (via `options_page`). The **approval page is not a manifest page**, so it must be listed as an explicit `build.rollupOptions.input` in `vite.config.ts` (plus `web_accessible_resources`) or its `<script>` won't be bundled and 404s at runtime. **Icons:** the toolbar/extension icon is the blue eye — Chrome needs PNGs (no SVG), generated from the wallet's eye SVG by `scripts/gen-icons.mjs` (rasterizes via headless Chromium) into `icons/`. Re-run that script if the mark changes.
