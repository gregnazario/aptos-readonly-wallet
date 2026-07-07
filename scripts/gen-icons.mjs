// Rasterizes the wallet's blue "eye" mark to PNG toolbar icons at the sizes
// Chrome wants (16/32/48/128). Chrome doesn't accept SVG for extension icons,
// so we render the same SVG the wallet uses via headless Chromium (already a
// dev dependency) and write PNGs. Re-run with: node scripts/gen-icons.mjs
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 32, 48, 128];

const eye = (s) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="10" fill="#2563eb"/>
  <path d="M24 14c-7 0-12.5 5.6-14 10 1.5 4.4 7 10 14 10s12.5-5.6 14-10c-1.5-4.4-7-10-14-10zm0 16a6 6 0 1 1 0-12 6 6 0 0 1 0 12zm0-9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" fill="#fff"/>
</svg>`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const s of SIZES) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}</style>${eye(s)}`,
  );
  const el = await page.$("svg");
  const buf = await el.screenshot({ omitBackground: true });
  await writeFile(join(OUT, `eye-${s}.png`), buf);
  // eslint-disable-next-line no-console
  console.log(`wrote icons/eye-${s}.png`);
}
await browser.close();
