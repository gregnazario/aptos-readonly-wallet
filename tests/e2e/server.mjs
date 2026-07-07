// Tiny static file server for the E2E test dApp. Content scripts only inject
// on real http(s) origins (not file:// or data:), so we need an actual server.
// Kept dependency-free on purpose.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "dapp");
const port = Number(process.env.VOW_E2E_PORT ?? 5411);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname));
    if (path === "/" || path.endsWith("/")) path += "index.html";
    // Prevent path traversal outside the dapp root.
    const filePath = join(root, path);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[vow-e2e] test dApp server on http://localhost:${port}`);
});
