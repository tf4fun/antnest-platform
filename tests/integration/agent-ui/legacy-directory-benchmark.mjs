import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { createWorkspaceHttpServer } from "../../../services/agent-ui/web/server/dist/http/node-server.js";
import { loadWorkspaceDocument } from "../../../services/agent-ui/web/server/dist/ssr-assets.js";
import { durablePath } from "../../support/storage.mjs";

// Opt-in, historical comparison. Build the pre-refactor HEAD SPA separately and
// provide its dist directory; never include that old client in a current image.
const legacyDist = process.env.ANTNEST_UI_LEGACY_DIST;
const output = process.env.ANTNEST_UI_BENCH_OUTPUT;
assert(
  legacyDist && output,
  "set ANTNEST_UI_LEGACY_DIST and ANTNEST_UI_BENCH_OUTPUT",
);
durablePath(output);
const viewportWidth = Number(process.env.ANTNEST_UI_BENCH_WIDTH ?? 1440);
const viewportHeight = Number(process.env.ANTNEST_UI_BENCH_HEIGHT ?? 900);
assert(
  Number.isInteger(viewportWidth) &&
    viewportWidth >= 320 &&
    Number.isInteger(viewportHeight) &&
    viewportHeight >= 480,
);
const root = resolve(legacyDist);
const names = ["Research Partner", "Operations Assistant"];
const legacyAgents = [
  {
    agent_id: "agent-one",
    name: names[0],
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
  },
  {
    agent_id: "agent-two",
    name: names[1],
    lifecycle_state: "created",
    activation_state: "disabled",
    runtime_state: "exited",
  },
];
const agents = [
  {
    agentId: "agent-one",
    name: names[0],
    lifecycle: "created",
    activation: "enabled",
    runtime: "available",
  },
  {
    agentId: "agent-two",
    name: names[1],
    lifecycle: "created",
    activation: "disabled",
    runtime: "exited",
  },
];
const legacy = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/api/app/bootstrap") {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(
        JSON.stringify({
          principal: {
            user_id: "user",
            organization_id: "org",
            administrator: false,
          },
          agents: legacyAgents,
        }),
      );
      return;
    }
    const asset = /^\/workspace\/assets\/([\w.-]+)$/.exec(path);
    const file = asset
      ? join(root, "assets", asset[1])
      : path === "/workspace/"
        ? join(root, "index.html")
        : null;
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "content-type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
const document = await loadWorkspaceDocument();
const current = createWorkspaceHttpServer(
  {
    async handle(request) {
      if (new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap")
        return null;
      return Response.json({
        principal: {
          userId: "user",
          organizationId: "org",
          administrator: false,
        },
        agents,
        renderedAt: "2026-09-25T00:00:00Z",
        bridgeEpoch: "benchmark-epoch",
      });
    },
  },
  document,
);
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const oldOrigin = await listen(legacy);
const newOrigin = await listen(current);
const browser = await chromium.launch({ headless: true });
const measurements = { old: [], new: [] };
const screenshots = {};
try {
  for (let iteration = 0; iteration < 12; iteration++) {
    for (const variant of iteration % 2 ? ["new", "old"] : ["old", "new"]) {
      const context = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        serviceWorkers: "block",
        extraHTTPHeaders:
          variant === "new"
            ? {
                "x-antnest-organization-id": "org",
                "x-antnest-principal-id": "user",
                "x-antnest-administrator": "false",
              }
            : {},
      });
      try {
        const page = await context.newPage();
        await page.addInitScript((expected) => {
          const mark = () => {
            if (window.__directoryReadyAt !== undefined) return;
            const heading = document.querySelector("h1");
            if (heading?.textContent !== "Your agents") return;
            const text = document.body?.textContent ?? "";
            if (expected.every((name) => text.includes(name))) {
              window.__directoryReadyAt = performance.now();
              observer.disconnect();
            }
          };
          const observer = new MutationObserver(mark);
          observer.observe(document, { childList: true, subtree: true });
          document.addEventListener("DOMContentLoaded", mark, { once: true });
          const markInteractive = () => {
            const button = document.querySelector(
              'button[aria-label="Refresh agents"]',
            );
            if (
              button &&
              Object.keys(button).some((key) => key.startsWith("__reactProps$"))
            ) {
              window.__refreshBoundAt = performance.now();
            } else {
              requestAnimationFrame(markInteractive);
            }
          };
          requestAnimationFrame(markInteractive);
        }, names);
        await page.goto(
          `${variant === "old" ? oldOrigin : newOrigin}/workspace/`,
          { waitUntil: "domcontentloaded" },
        );
        await page.waitForFunction(
          () => window.__directoryReadyAt !== undefined,
        );
        await page.waitForFunction(() => window.__refreshBoundAt !== undefined);
        await page.waitForFunction(() =>
          performance
            .getEntriesByType("paint")
            .some((entry) => entry.name === "first-contentful-paint"),
        );
        const result = await page.evaluate(() => {
          const navigation = performance.getEntriesByType("navigation")[0];
          return {
            ttfbMs: navigation.responseStart,
            fcpMs: performance.getEntriesByName("first-contentful-paint")[0]
              .startTime,
            directoryReadyMs: window.__directoryReadyAt,
            reactRefreshBoundMs: window.__refreshBoundAt,
          };
        });
        if (iteration >= 2) measurements[variant].push(result);
        if (iteration === 2) {
          await mkdir(dirname(output), { recursive: true });
          const path = output.replace(/\.json$/, `-${variant}.png`);
          const bytes = await page.screenshot({ path, fullPage: true });
          screenshots[variant] = {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }
        const bootstrapPath =
          variant === "old"
            ? "/api/app/bootstrap"
            : "/api/app/workspace/v1/bootstrap";
        const refreshed = page.waitForResponse(
          (response) => new URL(response.url()).pathname === bootstrapPath,
        );
        await page.getByRole("button", { name: "Refresh agents" }).click();
        await refreshed;
      } finally {
        await context.close();
      }
    }
  }
  const percentile = (values, rank) =>
    values.toSorted((a, b) => a - b)[Math.ceil(values.length * rank) - 1];
  const summary = Object.fromEntries(
    Object.entries(measurements).map(([variant, samples]) => [
      variant,
      Object.fromEntries(
        ["ttfbMs", "fcpMs", "directoryReadyMs", "reactRefreshBoundMs"].map(
          (metric) => [
            metric,
            {
              p50: percentile(
                samples.map((sample) => sample[metric]),
                0.5,
              ),
              p90: percentile(
                samples.map((sample) => sample[metric]),
                0.9,
              ),
            },
          ],
        ),
      ),
    ]),
  );
  const report = {
    scope:
      "two-agent directory, local Node static fixture versus local production SSR, 2 warmups and 10 measured navigations per variant",
    viewport: { width: viewportWidth, height: viewportHeight },
    legacyDist: root,
    measurements,
    summary,
    screenshots,
    screenshotsIdentical: screenshots.old.sha256 === screenshots.new.sha256,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
  legacy.closeAllConnections();
  current.closeAllConnections();
  legacy.close();
  current.close();
  await Promise.all([once(legacy, "close"), once(current, "close")]);
}
