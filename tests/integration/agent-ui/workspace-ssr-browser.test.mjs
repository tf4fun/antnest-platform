import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { createWorkspaceHttpServer } from "../../../services/agent-ui/web/server/dist/http/node-server.js";
import { loadWorkspaceDocument } from "../../../services/agent-ui/web/server/dist/ssr-assets.js";

test("production workspace SSR renders before JavaScript and hydrates without crossing identities", { timeout: 60_000 }, async () => {
  const document = await loadWorkspaceDocument();
  const server = createWorkspaceHttpServer({
    async handle(request) {
      if (new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap") return null;
      const userId = request.headers.get("x-antnest-principal-id");
      return Response.json({
        principal: { userId, organizationId: "org", administrator: false },
        agents: [{ agentId: "agent-1", name: `Agent ${userId}`,
          lifecycle: "created", activation: "enabled", runtime: "available" }],
        renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch",
      });
    },
  }, document);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await chromium.launch({ headless: true });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const userId of ["one", "two"]) for (const javaScriptEnabled of [false, true]) {
      const context = await browser.newContext({
        javaScriptEnabled,
        extraHTTPHeaders: {
          "x-antnest-organization-id": "org",
          "x-antnest-principal-id": userId,
          "x-antnest-administrator": "false",
        },
      });
      try {
        const page = await context.newPage();
        const hydrationErrors = [];
        page.on("console", (message) => {
          if (/hydration|did not match/i.test(message.text())) hydrationErrors.push(message.text());
        });
        page.on("pageerror", (error) => hydrationErrors.push(error.message));
        const hydratedBootstrap = javaScriptEnabled
          ? page.waitForResponse((response) =>
            new URL(response.url()).pathname === "/api/app/workspace/v1/bootstrap")
          : null;
        await page.goto(`http://127.0.0.1:${address.port}/workspace/?agent=agent-1`);
        if (hydratedBootstrap) await hydratedBootstrap;
        await page.getByText(`Agent ${userId}`).first().waitFor();
        assert.equal(await page.getByText(`Agent ${userId === "one" ? "two" : "one"}`).count(), 0);
        assert.deepEqual(hydrationErrors, []);
        assert.equal(await page.locator("#workspace-bootstrap").count(), 1);
        if (!javaScriptEnabled) {
          assert.equal(await page.locator("#root[data-ssr]").count(), 0,
            "The authorized navigation must come from SSR, not the fallback shell");
          assert.equal(await page.locator(".agent-option")
            .filter({ hasText: `Agent ${userId}` }).count(), 1);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("failed server render mounts the client shell and recovers from a fresh bootstrap", { timeout: 60_000 }, async () => {
  const document = await loadWorkspaceDocument();
  let bootstraps = 0;
  const server = createWorkspaceHttpServer({
    async handle(request) {
      if (new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap") return null;
      if (++bootstraps === 1) return Response.json({ invalid: "bootstrap" });
      return Response.json({
        principal: { userId: "recovered", organizationId: "org", administrator: false },
        agents: [{ agentId: "agent-1", name: "Recovered Agent",
          lifecycle: "created", activation: "enabled", runtime: "available" }],
        renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch",
      });
    },
  }, document);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await chromium.launch({ headless: true });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const context = await browser.newContext({ extraHTTPHeaders: {
      "x-antnest-organization-id": "org",
      "x-antnest-principal-id": "recovered",
      "x-antnest-administrator": "false",
    } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (/hydration|did not match/i.test(message.text())) errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${address.port}/workspace/?agent=agent-1`);
      await page.getByText("Recovered Agent").first().waitFor();
      assert.equal(bootstraps >= 2, true);
      assert.equal(await page.locator('#root[data-ssr="fallback"]').count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
