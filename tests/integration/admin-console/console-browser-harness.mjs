import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../../../services/admin-console/web/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const assets = fileURLToPath(
  new URL("../../../services/admin-console/web/dist/", import.meta.url),
);

async function serve(request, response) {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    const file = resolve(
      assets,
      path === "/" ? "index.html" : decodeURIComponent(path).slice(1),
    );
    if (!file.startsWith(resolve(assets) + sep)) {
      response.writeHead(404).end();
      return;
    }
    const data = await readFile(file);
    const mime =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      }[extname(file)] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": mime }).end(data);
  } catch {
    response.writeHead(404).end();
  }
}

export async function assertNoOverflow(page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "page must fit viewport",
  );
}

export async function withConsoleBrowser(output, exercise) {
  await readFile(resolve(assets, "index.html"));
  await mkdir(output, { recursive: true });
  const server = createServer((request, response) => {
    void serve(request, response);
  });
  let browser;
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    browser = await chromium.launch({ headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const results = [];
    for (const [label, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      results.push(await exercise(browser, origin, viewport, label));
    }
    return results;
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
}
