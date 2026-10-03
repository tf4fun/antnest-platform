import { verifiedRequestContext } from "../../../services/agent-ui/web/server/dist/http/trusted-identity.js";
import {
  createTestWorkspaceHttpServer as createWorkspaceHttpServer,
  testBrowserContext,
} from "./auth-fixture.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";

import { loadWorkspaceDocument } from "../../../services/agent-ui/web/server/dist/ssr-assets.js";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/dist/workspace-runtime.js";

test(
  "production workspace SSR renders before JavaScript and hydrates without crossing identities",
  { timeout: 60_000 },
  async () => {
    const document = await loadWorkspaceDocument();
    const server = createWorkspaceHttpServer(
      {
        async handle(request) {
          if (
            new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap"
          )
            return null;
          const userId = verifiedRequestContext(request.headers)?.claims.sub;
          return Response.json({
            principal: {
              organizationSlug: "engineering",
              organizationName: "Engineering",
              userId,
              organizationId: "org",
              administrator: false,
            },
            agents: [
              {
                agentId: "agent-1",
                name: `Agent ${userId}`,
                lifecycle: "created",
                activation: "enabled",
                runtime: "available",
              },
            ],
            renderedAt: "2026-09-23T00:00:00Z",
            bridgeEpoch: "epoch",
          });
        },
      },
      document,
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const browser = await chromium.launch({ headless: true });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      for (const userId of ["one", "two"])
        for (const javaScriptEnabled of [false, true]) {
          const context = await testBrowserContext(browser, {
            javaScriptEnabled,
            extraHTTPHeaders: {
              "x-antnest-organization-id": "org",
              "x-antnest-principal-id": userId,
              "x-antnest-administrator": "false",
              "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
              "x-antnest-organization-name": "RW5naW5lZXJpbmc",
            },
          });
          try {
            const page = await context.newPage();
            if (javaScriptEnabled)
              await page.addInitScript(() => {
                window.workspacePolicyViolations = [];
                document.addEventListener(
                  "securitypolicyviolation",
                  (event) => {
                    window.workspacePolicyViolations.push({
                      directive: event.effectiveDirective,
                      blockedURI: event.blockedURI,
                    });
                  },
                );
              });
            const hydrationErrors = [];
            page.on("console", (message) => {
              if (/hydration|did not match/i.test(message.text()))
                hydrationErrors.push(message.text());
            });
            page.on("pageerror", (error) =>
              hydrationErrors.push(error.message),
            );
            const hydratedBootstrap = javaScriptEnabled
              ? page.waitForResponse(
                  (response) =>
                    new URL(response.url()).pathname ===
                    "/api/app/workspace/v1/bootstrap",
                )
              : null;
            const sessionId = userId === "one" ? null : "saved-session";
            const path =
              sessionId === null
                ? "/workspace/agent-1/"
                : `/workspace/agent-1/sessions/${sessionId}`;
            await page.goto(`http://127.0.0.1:${address.port}${path}`);
            if (hydratedBootstrap) await hydratedBootstrap;
            await page.getByText(`Agent ${userId}`).first().waitFor();
            assert.equal(
              await page
                .getByText(`Agent ${userId === "one" ? "two" : "one"}`)
                .count(),
              0,
            );
            assert.deepEqual(hydrationErrors, []);
            if (javaScriptEnabled)
              assert.deepEqual(
                await page.evaluate(() => window.workspacePolicyViolations),
                [],
                "Production client must hydrate without CSP violations",
              );
            assert.equal(await page.locator("#workspace-bootstrap").count(), 1);
            assert.deepEqual(
              JSON.parse(
                await page.locator("#workspace-bootstrap").textContent(),
              ).route,
              { agentId: "agent-1", sessionId },
            );
            assert.equal(new URL(page.url()).pathname, path);
            assert.equal(new URL(page.url()).search, "");
            await page.reload();
            await page.getByText(`Agent ${userId}`).first().waitFor();
            assert.deepEqual(
              JSON.parse(
                await page.locator("#workspace-bootstrap").textContent(),
              ).route,
              { agentId: "agent-1", sessionId },
            );
            assert.deepEqual(hydrationErrors, []);
            if (javaScriptEnabled)
              assert.deepEqual(
                await page.evaluate(() => window.workspacePolicyViolations),
                [],
                "Production client reload must not probe eval under its CSP",
              );
            if (!javaScriptEnabled) {
              assert.equal(
                await page.locator("#root[data-ssr]").count(),
                0,
                "The authorized navigation must come from SSR, not the fallback shell",
              );
              assert.equal(
                await page
                  .locator(".workspace-switcher")
                  .filter({ hasText: `Agent ${userId}` })
                  .count(),
                1,
              );
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
  },
);

test(
  "hierarchical documents restore selection through reload and Back/Forward without creating a Session",
  { timeout: 60_000 },
  async () => {
    let writes = 0;
    const runtime = createWorkspaceRuntime({
      discover: async () => [
        {
          agent_id: "agent-1",
          name: "Navigation Agent",
          lifecycle_state: "created",
          activation_state: "enabled",
          runtime_state: "available",
        },
      ],
      connect: async (_scope, callbacks) => ({
        async list() {
          return {
            sessions: [
              {
                sessionId: "saved-session",
                title: "Saved conversation",
                cwd: "/workspace",
              },
            ],
          };
        },
        async createSession() {
          writes++;
          return { sessionId: "unexpected" };
        },
        async readAgentExecutionState() {
          return { availability: "ready", activeSessionId: null };
        },
        async load(sessionId) {
          callbacks.update({
            sessionId,
            update: {
              sessionUpdate: "session_info_update",
              title: "Saved conversation",
            },
          });
          return { cut: { sealedWatermark: 0, appendVersion: 1 } };
        },
        async readExecution(sessionId) {
          return {
            sessionId,
            appendVersion: 1,
            outputWatermark: 0,
            activeRunId: null,
            recentReceipts: [],
            configurationRevision: null,
          };
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {
          writes++;
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        close() {},
      }),
    });
    const server = createWorkspaceHttpServer(
      runtime,
      await loadWorkspaceDocument(),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const context = await testBrowserContext(browser, {
        extraHTTPHeaders: {
          "x-antnest-organization-id": "org",
          "x-antnest-principal-id": "user",
          "x-antnest-agent-id": "agent-1",
          "x-antnest-administrator": "false",
          "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
          "x-antnest-organization-name": "RW5naW5lZXJpbmc",
        },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const origin = `http://127.0.0.1:${address.port}`;
      const draft = "/workspace/agent-1/";
      const saved = `${draft}sessions/saved-session`;
      await page.goto(`${origin}/workspace/`);
      await page.getByRole("link", { name: /Navigation Agent/ }).click();
      await page.waitForURL(origin + draft);
      const composer = page.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await composer.fill("Unsent draft");
      await page
        .locator(".conversation-option")
        .filter({ hasText: "Saved conversation" })
        .click();
      await page.waitForURL(origin + saved);
      await page.locator('.conversation-option[aria-current="page"]').waitFor();
      await page.goBack();
      await page.waitForURL(origin + draft);
      assert.equal(await composer.inputValue(), "Unsent draft");
      await page.goForward();
      await page.waitForURL(origin + saved);
      await page.locator('.conversation-option[aria-current="page"]').waitFor();
      await page.reload();
      await page.locator('.conversation-option[aria-current="page"]').waitFor();
      assert.equal(new URL(page.url()).pathname, saved);
      assert.equal(new URL(page.url()).search, "");
      assert.deepEqual(
        JSON.parse(await page.locator("#workspace-bootstrap").textContent())
          .route,
        { agentId: "agent-1", sessionId: "saved-session" },
      );
      assert.equal(writes, 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      await runtime.drain(1_000);
    }
  },
);

test(
  "failed server render mounts the client shell and recovers from a fresh bootstrap",
  { timeout: 60_000 },
  async () => {
    const document = await loadWorkspaceDocument();
    let bootstraps = 0;
    const server = createWorkspaceHttpServer(
      {
        async handle(request) {
          if (
            new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap"
          )
            return null;
          if (++bootstraps === 1)
            return Response.json({ invalid: "bootstrap" });
          return Response.json({
            principal: {
              organizationSlug: "engineering",
              organizationName: "Engineering",
              userId: "recovered",
              organizationId: "org",
              administrator: false,
            },
            agents: [
              {
                agentId: "agent-1",
                name: "Recovered Agent",
                lifecycle: "created",
                activation: "enabled",
                runtime: "available",
              },
            ],
            renderedAt: "2026-09-23T00:00:00Z",
            bridgeEpoch: "epoch",
          });
        },
      },
      document,
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const browser = await chromium.launch({ headless: true });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const context = await testBrowserContext(browser, {
        extraHTTPHeaders: {
          "x-antnest-organization-id": "org",
          "x-antnest-principal-id": "recovered",
          "x-antnest-administrator": "false",
          "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
          "x-antnest-organization-name": "RW5naW5lZXJpbmc",
        },
      });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (/hydration|did not match/i.test(message.text()))
            errors.push(message.text());
        });
        await page.goto(`http://127.0.0.1:${address.port}/workspace/agent-1/`);
        await page.getByText("Recovered Agent").first().waitFor();
        assert.equal(bootstraps >= 2, true);
        assert.equal(
          await page.locator('#root[data-ssr="fallback"]').count(),
          1,
        );
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
  },
);
