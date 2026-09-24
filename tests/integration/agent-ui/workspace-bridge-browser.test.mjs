import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "../../../services/agent-ui/web/node_modules/vite/dist/node/index.js";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { assertWcagPage } from "../../support/agent-ui/accessibility.mjs";

test(
  "Bridge browser keeps one HTTP Prompt intent through SSE completion and reload",
  { timeout: 90_000 },
  async () => {
    const clients = new Set();
    const prompts = [];
    const sockets = [];
    const diagnostics = [];
    const seenPaths = [];
    const processReads = [];
    const decisions = [];
    const configurations = [];
    let revision = 0;
    let configurationRevision = 0;
    let safeMode = true;
    let permissionPending = true;
    let answer = "Saved answer";
    let sessionTitle = "Saved question";
    let sessionUpdatedAt = "2026-09-23T00:00:00Z";
    let limited = false;
    let blocked = false;
    let runtimeFailed = false;
    let expired = false;
    let streamUnavailable = false;
    let operation = null;
    let server;
    let browser;
    const agentView = (cursor) => ({
      agentId: "agent-1",
      bridgeEpoch: "epoch-1",
      availability: runtimeFailed
        ? "offline"
        : operation?.phase === "running"
          ? "busy"
          : "ready",
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      activeSessionId: operation?.phase === "running" ? "session-1" : null,
      selectedSessionId: "session-1",
      streamCursor: cursor,
      operations: operation ? [operation] : [],
      permissions: permissionPending
        ? [
            {
              permissionId: "permission-1",
              sessionId: "session-1",
              generation: 3,
              toolCall: {
                toolCallId: "tool-1",
                title: "Read notes",
                kind: "read",
                rawInput: { path: "notes.md" },
              },
              options: [
                {
                  optionId: "allow-once",
                  name: "Allow once",
                  kind: "allow_once",
                },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          ]
        : [],
      selectedView: {
        agentId: "agent-1",
        sessionId: "session-1",
        title: sessionTitle,
        updatedAt: sessionUpdatedAt,
        bridgeEpoch: "epoch-1",
        incarnation: "incarnation-1",
        viewRevision: revision + 1,
        appendVersion: operation ? 2 : 1,
        outputWatermark: revision + 1,
        historyToken: limited || blocked ? null : `history-${revision}`,
        streamCursor: `session-${revision}`,
        historyState: limited ? "view_limited" : blocked ? "blocked" : "ready",
        olderTurnsCursor: limited || blocked ? null : "before-1",
        operations: operation ? [operation] : [],
        permissions: [],
        configOptions: [
          {
            id: "safe_mode",
            name: "Safe mode",
            type: "boolean",
            currentValue: safeMode,
          },
        ],
        configurationToken: blocked ? null : `config-${configurationRevision}`,
        usage: { used: 5, size: 100 },
        ...(limited
          ? { limitedPreview: { text: "recent output only", truncated: true } }
          : {}),
        turns: limited
          ? []
          : [
              {
                turnId: "turn-1",
                outcome: runtimeFailed ? "failed" : "completed",
                prompt: [{ type: "text", text: "Saved question" }],
                finalResponse: runtimeFailed
                  ? []
                  : [{ type: "text", text: answer }],
                contentCursor: blocked ? "saved-cut" : null,
                processVersion: 1,
                processCount: 2,
              },
            ],
      },
    });
    const writeJSON = (response, value, status = 200) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify(value));
    };
    const publish = () => {
      revision++;
      const cursor = `cursor-${revision}`;
      const event = {
        type: "reset",
        agentId: "agent-1",
        bridgeEpoch: "epoch-1",
        projectionId: "projection-1",
        fromStreamRevision: revision - 1,
        toStreamRevision: revision,
        cursor,
        view: agentView(cursor),
      };
      for (const response of clients)
        response.write(`event: reset\ndata: ${JSON.stringify(event)}\n\n`);
    };
    try {
      server = await createServer({
        root: fileURLToPath(
          new URL("../../../services/agent-ui/web/", import.meta.url),
        ),
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
          {
            name: "bridge-browser-fixture",
            configureServer(vite) {
              vite.middlewares.use((request, response, next) => {
                const url = new URL(request.url, "http://fixture");
                const path = url.pathname;
                seenPaths.push(path);
                if (expired && path === "/") {
                  response.setHeader(
                    "content-type",
                    "text/html; charset=utf-8",
                  );
                  response.end(
                    "<!doctype html><title>Sign in</title><button>Sign in</button>",
                  );
                  return;
                }
                if (expired && path.startsWith("/api/app/workspace/v1/")) {
                  writeJSON(
                    response,
                    {
                      code: "unauthenticated",
                      message: "Session expired",
                      recovery: "login",
                      retryable: false,
                    },
                    401,
                  );
                  return;
                }
                if (path === "/api/app/workspace/v1/bootstrap") {
                  writeJSON(response, {
                    principal: {
                      userId: "user-1",
                      organizationId: "org-1",
                      administrator: false,
                    },
                    agents: [
                      {
                        agentId: "agent-1",
                        name: "Agent",
                        lifecycle: "created",
                        activation: "enabled",
                        runtime: "available",
                      },
                    ],
                    renderedAt: "2026-09-23T00:00:00Z",
                    bridgeEpoch: "epoch-1",
                  });
                  return;
                }
                if (
                  path === "/api/app/workspace/v1/agents/agent-1/sessions" &&
                  request.method === "GET"
                ) {
                  writeJSON(response, {
                    items: [
                      {
                        sessionId: "session-1",
                        title: sessionTitle,
                        updatedAt: sessionUpdatedAt,
                        activeOperationId: null,
                      },
                    ],
                    nextCursor: null,
                  });
                  return;
                }
                if (path === "/api/app/workspace/v1/agents/agent-1/view") {
                  writeJSON(response, agentView(`cursor-${revision}`));
                  return;
                }
                if (path === "/api/app/workspace/v1/agents/agent-1/events") {
                  if (streamUnavailable) {
                    writeJSON(
                      response,
                      {
                        code: "upstream_unavailable",
                        message: "Stream unavailable",
                        recovery: "retry_read",
                        retryable: true,
                      },
                      503,
                    );
                    return;
                  }
                  response.writeHead(200, {
                    "content-type": "text/event-stream",
                    "cache-control": "no-store",
                    connection: "keep-alive",
                  });
                  response.write(": connected\n\n");
                  clients.add(response);
                  response.on("close", () => clients.delete(response));
                  return;
                }
                if (
                  path ===
                    "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts" &&
                  request.method === "POST"
                ) {
                  const chunks = [];
                  request.on("data", (chunk) => chunks.push(chunk));
                  request.on("end", () => {
                    const body = JSON.parse(
                      Buffer.concat(chunks).toString("utf8"),
                    );
                    prompts.push({ body, headers: request.headers });
                    const promptNumber = prompts.length;
                    operation = {
                      operationId: body.intentId,
                      sessionId: "session-1",
                      phase: "running",
                      acceptance: "acp",
                      runId: "run-1",
                      outputWatermark: revision,
                    };
                    writeJSON(
                      response,
                      {
                        operationId: body.intentId,
                        acceptance: "bridge",
                        phase: "dispatching",
                      },
                      202,
                    );
                    setTimeout(() => {
                      answer =
                        promptNumber === 1
                          ? "Completed over SSE"
                          : "Continued after tab close";
                      if (promptNumber === 1) {
                        sessionTitle = "ACP renamed session";
                        sessionUpdatedAt = "2026-09-24T02:00:00Z";
                      }
                      operation = {
                        ...operation,
                        phase: "completed",
                        outputWatermark: revision + 1,
                      };
                      publish();
                    }, 150);
                  });
                  return;
                }
                if (
                  path ===
                    "/api/app/workspace/v1/agents/agent-1/sessions/session-1/configuration" &&
                  request.method === "POST"
                ) {
                  const chunks = [];
                  request.on("data", (chunk) => chunks.push(chunk));
                  request.on("end", () => {
                    configurations.push({
                      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                      headers: request.headers,
                    });
                    safeMode = false;
                    configurationRevision++;
                    writeJSON(response, {
                      configOptions: agentView(`cursor-${revision}`)
                        .selectedView.configOptions,
                    });
                  });
                  return;
                }
                if (
                  path ===
                    "/api/app/workspace/v1/agents/agent-1/permissions/permission-1/decision" &&
                  request.method === "POST"
                ) {
                  const chunks = [];
                  request.on("data", (chunk) => chunks.push(chunk));
                  request.on("end", () => {
                    decisions.push({
                      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                      headers: request.headers,
                    });
                    permissionPending = false;
                    writeJSON(response, {
                      permissionId: "permission-1",
                      status: "accepted",
                    });
                    setTimeout(publish, 20);
                  });
                  return;
                }
                if (
                  path ===
                    "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns" &&
                  request.method === "GET"
                ) {
                  assert.equal(url.searchParams.get("cursor"), "before-1");
                  writeJSON(response, {
                    items: [
                      {
                        turnId: "turn-0",
                        outcome: "completed",
                        prompt: [{ type: "text", text: "Earlier question" }],
                        finalResponse: [
                          { type: "text", text: "Earlier answer" },
                        ],
                        contentCursor: null,
                        processVersion: 0,
                        processCount: 0,
                      },
                    ],
                    nextCursor: null,
                    newerCursor: "latest-page",
                  });
                  return;
                }
                if (
                  path ===
                  "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/turn-1/process"
                ) {
                  const cursor = url.searchParams.get("cursor");
                  processReads.push(cursor ?? "page");
                  writeJSON(
                    response,
                    cursor === null
                      ? {
                          turnId: "turn-1",
                          processVersion: 1,
                          items: [
                            {
                              id: "tool-1",
                              kind: "tool",
                              summary: "Inspect source",
                              status: "completed",
                              content: [
                                { type: "text", text: "Output preview" },
                              ],
                              contentCursor: "content-next",
                            },
                          ],
                          nextCursor: "page-2",
                        }
                      : {
                          turnId: "turn-1",
                          processVersion: 1,
                          items: [
                            {
                              id: "thought-1",
                              kind: "thought",
                              summary: "Review result",
                              status: "completed",
                              content: [{ type: "text", text: "Second step" }],
                              contentCursor: null,
                            },
                          ],
                          nextCursor: null,
                        },
                  );
                  return;
                }
                if (
                  path ===
                  "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/turn-1/process/tool-1/content"
                ) {
                  processReads.push("content");
                  writeJSON(response, {
                    turnId: "turn-1",
                    itemId: "tool-1",
                    items: [{ type: "text", text: " full" }],
                    nextCursor: null,
                    complete: true,
                  });
                  return;
                }
                next();
              });
            },
          },
        ],
      });
      await server.listen();
      const address = server.httpServer.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      await context.addCookies([
        { name: "antnest_csrf", value: "browser-csrf", url: origin },
      ]);
      const chooserPage = await context.newPage();
      await chooserPage.goto(`${origin}/workspace/`);
      await chooserPage.getByRole("heading", { name: "Your agents" }).waitFor();
      await assertWcagPage(chooserPage);
      await chooserPage
        .getByRole("link", { name: /Agent/u })
        .first()
        .press("Enter");
      await chooserPage.waitForURL(
        (url) => url.searchParams.get("agent") === "agent-1",
      );
      await chooserPage.close();
      const page = await context.newPage();
      await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        let dropConfigurationResult = true;
        let dropPermissionResult = true;
        window.fetch = async (input, init) => {
          const response = await originalFetch(input, init);
          const url = typeof input === "string" ? input : input.url;
          if (
            dropConfigurationResult &&
            url.endsWith("/configuration") &&
            init?.method === "POST"
          ) {
            dropConfigurationResult = false;
            throw new Error("Configuration response lost after apply");
          }
          if (
            dropPermissionResult &&
            url.endsWith("/decision") &&
            init?.method === "POST"
          ) {
            dropPermissionResult = false;
            throw new Error("Permission response lost after apply");
          }
          return response;
        };
      });
      page.on("websocket", (socket) => sockets.push(socket.url()));
      page.on("request", (request) => {
        if (request.url().includes("/api/"))
          diagnostics.push(`request: ${request.url()}`);
      });
      page.on("pageerror", (error) =>
        diagnostics.push(`pageerror: ${error.message}`),
      );
      page.on("requestfailed", (request) =>
        diagnostics.push(
          `failed: ${request.url()} ${request.failure()?.errorText}`,
        ),
      );
      page.on("response", (response) => {
        if (response.status() >= 400)
          diagnostics.push(`http ${response.status()}: ${response.url()}`);
      });
      await page.goto(`${origin}/workspace/?agent=agent-1&session=session-1`);
      try {
        await page.getByText("Saved answer").waitFor({ timeout: 10_000 });
      } catch (cause) {
        throw new Error(
          `${cause.message}\nPage: ${await page.locator("body").innerText()}\nPaths: ${seenPaths.join(", ")}\n${diagnostics.join("\n")}`,
        );
      }
      assert.equal(
        await page
          .getByRole("region", { name: "Conversation messages" })
          .count(),
        1,
      );
      const composerStatus = page.getByRole("group", { name: "Message composer" })
        .getByRole("status");
      assert.equal(await composerStatus.innerText(), "");
      await assertWcagPage(page);
      await page.getByRole("button", { name: "Copy response" }).click();
      await page.getByRole("status").filter({ hasText: "Copied" }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Saved answer");
      assert.deepEqual(
        processReads,
        [],
        "Collapsed process should not fetch history",
      );
      streamUnavailable = true;
      for (const response of [...clients]) response.end();
      for (let attempt = 0; attempt < 200 && clients.size !== 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        clients.size,
        0,
        "The old SSE observer must release its connection",
      );
      await page
        .locator(".topbar-agent .presence")
        .getByText("Status unavailable")
        .waitFor();
      assert.equal(await composerStatus.innerText(), "Connection unavailable");
      assert.equal(
        await page.locator(".topbar-agent .presence").getAttribute("role"),
        "status",
        "Disconnected Agent status must be announced to assistive technology",
      );
      assert.equal(await page.getByText("Saved answer").count(), 1);
      assert.equal(
        await page.getByRole("button", { name: "Send message" }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Allow once" }).isDisabled(),
        true,
      );
      await assertWcagPage(page);
      streamUnavailable = false;
      for (let attempt = 0; attempt < 200 && clients.size !== 1; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        clients.size,
        1,
        "A dropped SSE stream must reconnect to its scoped View",
      );
      await page
        .locator(".topbar-agent .presence")
        .getByText("Available")
        .waitFor();
      assert.equal(await composerStatus.innerText(), "");
      assert.equal(
        await page.getByRole("button", { name: "Allow once" }).isEnabled(),
        true,
      );
      assert.equal(
        prompts.length,
        0,
        "Observer recovery must not submit a Prompt",
      );
      const usageTrigger = page.getByRole("button", {
        name: /Context usage: 5%, 5 \/ 100 tokens/u,
      });
      await usageTrigger.waitFor();
      await usageTrigger.click();
      await page.getByRole("group", { name: "Session usage" }).waitFor();
      const safeModeSwitch = page.getByRole("switch", { name: "Safe mode" });
      await safeModeSwitch.focus();
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("group", { name: "Session usage" }).count(), 0);
      assert.equal(await safeModeSwitch.evaluate((element) =>
        element === document.activeElement), true,
      "Closing Usage from another control must leave that control focused");
      const viewsBeforeLostConfiguration = seenPaths.filter(
        (path) => path === "/api/app/workspace/v1/agents/agent-1/view",
      ).length;
      await page.getByRole("switch", { name: "Safe mode" }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[role="switch"][aria-label="Safe mode"]')
            ?.getAttribute("aria-checked") === "false",
      );
      assert.ok(
        seenPaths.filter(
          (path) => path === "/api/app/workspace/v1/agents/agent-1/view",
        ).length > viewsBeforeLostConfiguration,
        "A lost configuration response must reread the authoritative Agent View",
      );
      assert.equal(
        await page
          .getByText("Session configuration could not be changed.")
          .count(),
        0,
      );
      assert.deepEqual(
        configurations.map((item) => item.body),
        [
          {
            configId: "safe_mode",
            value: false,
            expectedConfigurationToken: "config-0",
          },
        ],
      );
      assert.equal(
        configurations[0].headers["x-antnest-csrf-token"],
        "browser-csrf",
      );
      const viewsBeforeLostPermission = seenPaths.filter(
        (path) => path === "/api/app/workspace/v1/agents/agent-1/view",
      ).length;
      const permissionInbox = page.locator(".permission-requests");
      assert.equal(await permissionInbox.getAttribute("aria-live"), null,
        "Raw tool input must not sit inside a live announcement");
      const permissionAnnouncement = await page.getByRole("status")
        .filter({ hasText: /tool approval/u }).textContent();
      assert.match(permissionAnnouncement ?? "",
        /^1 tool approval requires a decision\. Most recent: Read notes in /u);
      assert.ok(!permissionAnnouncement?.includes("notes.md"),
        "The live announcement must omit raw tool input");
      const approvalContext = /Conversation: Saved question.*Read notes/u;
      const approval = page.getByRole("region", {
        name: "Tool approval", description: approvalContext,
      });
      assert.equal(await approval.count(), 1);
      await approval.getByRole("button", {
        name: "Allow once", description: approvalContext,
      }).focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", { name: "Allow once" })
        .waitFor({ state: "detached" });
      assert.equal(
        await page
          .getByRole("region", { name: "Conversation messages" })
          .evaluate((region) => region === document.activeElement),
        true,
        "Keyboard permission decision must restore focus to the conversation after the card closes",
      );
      assert.ok(
        seenPaths.filter(
          (path) => path === "/api/app/workspace/v1/agents/agent-1/view",
        ).length > viewsBeforeLostPermission,
        "A lost permission response must reread the authoritative Agent View",
      );
      assert.deepEqual(
        decisions.map((item) => item.body),
        [{ generation: 3, optionId: "allow-once" }],
      );
      assert.equal(
        decisions[0].headers["x-antnest-csrf-token"],
        "browser-csrf",
      );
      await page.getByRole("button", { name: "Show process" }).click();
      await page.getByText("Output preview").waitFor();
      await page.getByRole("button", { name: "Load full content" }).click();
      await page.getByText("Output preview full").waitFor();
      assert.deepEqual(processReads, ["page", "content"]);
      await page.getByRole("button", { name: "Load more process" }).click();
      await page.getByText("Second step").waitFor({ state: "attached" });
      await assertWcagPage(page);
      assert.deepEqual(processReads, ["page", "content", "page-2"]);
      await page.getByRole("button", { name: "Load earlier messages" }).click();
      await page.getByText("Earlier answer").waitFor();
      const historyFocus = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        className: document.activeElement?.className,
        label: document.activeElement?.getAttribute("aria-label"),
        olderButtons: [...document.querySelectorAll(".load-older-turns")].map(
          (button) => button.textContent?.trim(),
        ),
      }));
      assert.equal(
        historyFocus.className,
        "thread-scroll",
        JSON.stringify(historyFocus),
      );
      const secondPage = await context.newPage();
      secondPage.on("websocket", (socket) => sockets.push(socket.url()));
      await secondPage.goto(
        `${origin}/workspace/?agent=agent-1&session=session-1`,
      );
      await secondPage.getByText("Saved answer").waitFor();
      await page.getByRole("textbox", { name: "Message" }).fill("Continue");
      await page.getByRole("button", { name: "Send message" }).click();
      await page.getByText("Completed over SSE").waitFor();
      await secondPage.getByText("Completed over SSE").waitFor();
      for (const observer of [page, secondPage])
        await observer.waitForFunction(() => {
          const row = document.querySelector(".conversation-option.active");
          return row?.querySelector("strong")?.textContent === "ACP renamed session" &&
            row.querySelector("time")?.getAttribute("datetime") ===
              "2026-09-24T02:00:00Z";
        });
      await page.getByText("Output preview full").waitFor();
      await page.getByText("Earlier answer").waitFor();
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].headers["x-antnest-csrf-token"], "browser-csrf");
      assert.deepEqual(prompts[0].body.prompt, [
        { type: "text", text: "Continue" },
      ]);
      assert.deepEqual(
        sockets.filter((url) => url.includes("/v1/acp")),
        [],
      );
      await page.getByRole("textbox", { name: "Message" }).fill("Keep working");
      await page.getByRole("button", { name: "Send message" }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('textarea[aria-label="Message"]')?.value ===
          "",
      );
      await page.close();
      await secondPage.getByText("Continued after tab close").waitFor();
      assert.equal(
        prompts.length,
        2,
        "Closing one tab must not cancel or replay the Prompt",
      );
      await secondPage.reload();
      await secondPage.getByText("Continued after tab close").waitFor();
      await secondPage.waitForFunction(() => {
        const row = document.querySelector(".conversation-option.active");
        return row?.querySelector("strong")?.textContent === "ACP renamed session" &&
          row.querySelector("time")?.getAttribute("datetime") ===
            "2026-09-24T02:00:00Z";
      });
      assert.equal(prompts.length, 2, "Reload must not resubmit the Prompt");
      runtimeFailed = true;
      operation = {
        ...operation,
        phase: "failed",
        stopReason: "runtime_unavailable",
      };
      publish();
      await secondPage.getByText("Offline", { exact: true }).first().waitFor();
      assert.equal(
        await secondPage
          .locator(".topbar-agent .presence")
          .getAttribute("role"),
        "status",
      );
      await secondPage.getByRole("alert", { name: "Run failed" }).waitFor();
      assert.equal(
        await secondPage
          .getByRole("button", { name: "Send message" })
          .isDisabled(),
        true,
      );
      await assertWcagPage(secondPage);
      await secondPage.reload();
      await secondPage.getByRole("alert", { name: "Run failed" }).waitFor();
      assert.equal(
        prompts.length,
        2,
        "Authoritative Runtime failure must not replay the Prompt",
      );
      runtimeFailed = false;
      publish();
      await secondPage.getByText("Continued after tab close").waitFor();
      limited = true;
      publish();
      await secondPage
        .getByRole("status", { name: "History limited" })
        .waitFor();
      assert.doesNotMatch(
        await secondPage.getByRole("status", { name: "History limited" }).innerText(),
        /recent output only/u,
      );
      await secondPage.getByRole("region", { name: "Recent output preview" })
        .getByText("recent output only").waitFor();
      await assertWcagPage(secondPage);
      assert.equal(
        await secondPage.getByText("Continued after tab close").count(),
        0,
      );
      assert.equal(await secondPage.locator(".conversation-turn").count(), 0);
      assert.equal(
        await secondPage
          .getByRole("button", { name: "Send message" })
          .isDisabled(),
        true,
      );
      await secondPage.reload();
      await secondPage
        .getByRole("status", { name: "History limited" })
        .waitFor();
      assert.equal(await secondPage.getByRole("region", {
        name: "Recent output preview",
      }).getByText("recent output only").count(), 1);
      assert.equal(
        prompts.length,
        2,
        "Limited View reload must not resubmit the Prompt",
      );
      for (let attempt = 0; attempt < 200 && clients.size !== 1; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(clients.size, 1, "Reloaded page must reattach its SSE observer");
      limited = false;
      publish();
      await secondPage
        .getByRole("textbox", { name: "Message" })
        .fill("Ready again");
      await secondPage.getByRole("textbox", { name: "Message" }).focus();
      blocked = true;
      publish();
      await secondPage.getByText("Showing saved messages read-only.").waitFor();
      assert.equal(
        await secondPage.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Retry conversation",
        "Losing a focused composer to a blocked View must focus its recovery action",
      );
      await secondPage.getByText("Continued after tab close").waitFor();
      assert.equal(
        await secondPage
          .getByRole("button", { name: "Send message" })
          .isDisabled(),
        true,
      );
      await assertWcagPage(secondPage);
      assert.equal(
        await secondPage
          .getByRole("button", { name: "Load earlier messages" })
          .count(),
        0,
      );
      assert.equal(
        await secondPage
          .getByRole("button", { name: "Load full content" })
          .count(),
        0,
      );
      assert.equal(
        await secondPage.getByRole("button", { name: "Show process" }).count(),
        0,
      );
      assert.equal(
        prompts.length,
        2,
        "Blocked View must not resubmit a Prompt",
      );
      blocked = false;
      await secondPage
        .getByRole("button", { name: "Retry conversation" })
        .click();
      await secondPage
        .getByRole("button", { name: "Send message" })
        .waitFor({ state: "visible" });
      assert.equal(
        await secondPage
          .getByRole("button", { name: "Send message" })
          .isEnabled(),
        true,
      );
      assert.equal(
        await secondPage.getByText("Showing saved messages read-only.").count(),
        0,
      );
      await assertWcagPage(secondPage);
      assert.equal(
        await secondPage.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Message",
        "Successful retry should return focus to the restored composer",
      );
      await secondPage
        .getByRole("region", { name: "Conversation messages" })
        .focus();
      blocked = true;
      publish();
      await secondPage.getByText("Showing saved messages read-only.").waitFor();
      await assertWcagPage(secondPage);
      assert.equal(
        await secondPage.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Conversation messages",
        "Blocked View must not take focus from another region",
      );
      expired = true;
      for (const response of [...clients]) response.end();
      await secondPage.waitForURL(
        (url) =>
          url.pathname === "/" &&
          url.searchParams.get("return_to") ===
            "/workspace/?agent=agent-1&session=session-1",
        { timeout: 15_000 },
      );
      assert.equal(
        await secondPage.getByText("Continued after tab close").count(),
        0,
      );
      const readsAfterExpiry = seenPaths.filter((path) =>
        path.includes("/api/app/workspace/v1/"),
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      assert.equal(
        seenPaths.filter((path) => path.includes("/api/app/workspace/v1/"))
          .length,
        readsAfterExpiry,
        "Expired browser observer must stop reconnecting",
      );
      await context.close();
    } finally {
      for (const response of clients) response.end();
      await browser?.close();
      await server?.close();
    }
  },
);

test(
  "Bridge browser switches scoped Sessions without mixing drafts or observers",
  { timeout: 60_000 },
  async () => {
    const streams = new Set();
    const peerStreams = new Set();
    const selectedViews = [];
    const promptBodies = [];
    let firstIntentId = "";
    let rejectedAudio = false;
    let rejectedIntentId = "";
    let streamRevision = 0;
    let server;
    let browser;
    const session = (id) => ({
      sessionId: id,
      title: `Conversation ${id}`,
      updatedAt: "2026-09-23T00:00:00Z",
      activeOperationId: null,
    });
    const view = (id) => ({
      agentId: "agent-1",
      bridgeEpoch: "epoch-1",
      availability: "ready",
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      activeSessionId: null,
      selectedSessionId: id,
      streamCursor: `cursor-${id}-${streamRevision}`,
      operations: id === "two" ? [
        ...(firstIntentId ? [{ operationId: firstIntentId, sessionId: "two",
          phase: "completed", acceptance: "acp", runId: "first-run",
          outputWatermark: 2 }] : []),
        ...(rejectedAudio ? [{
        operationId: rejectedIntentId, sessionId: "two", phase: "failed",
        acceptance: "acp", runId: "rejected-run", outputWatermark: 3,
        errorClass: "model_unsupported_content",
        }] : []),
      ] : [],
      permissions: [],
      selectedView: {
        agentId: "agent-1",
        sessionId: id,
        title: `Conversation ${id}`,
        updatedAt: "2026-09-23T00:00:00Z",
        bridgeEpoch: "epoch-1",
        incarnation: `incarnation-${id}`,
        viewRevision: 1,
        appendVersion: 1,
        outputWatermark: 1,
        historyToken: `history-${id}`,
        streamCursor: `session-${id}`,
        historyState: "ready",
        olderTurnsCursor: null,
        operations: id === "two" ? [
          ...(firstIntentId ? [{ operationId: firstIntentId, sessionId: "two",
            phase: "completed", acceptance: "acp", runId: "first-run",
            outputWatermark: 2 }] : []),
          ...(rejectedAudio ? [{
          operationId: rejectedIntentId, sessionId: "two", phase: "failed",
          acceptance: "acp", runId: "rejected-run", outputWatermark: 3,
          errorClass: "model_unsupported_content",
          }] : []),
        ] : [],
        permissions: [],
        configOptions: [],
        configurationToken: null,
        usage: null,
        turns: [
          {
            turnId: `turn-${id}`,
            outcome: "completed",
            prompt: [{ type: "text", text: `Question ${id}` }],
            finalResponse: [{ type: "text", text: `Answer ${id}` }],
            contentCursor: null,
            processVersion: 0,
            processCount: 0,
          },
          ...(id === "two" && rejectedAudio ? [{
            turnId: "rejected-run", outcome: "failed",
            prompt: [{ type: "text", text: "Unsupported audio check" }],
            finalResponse: [], contentCursor: null,
            processVersion: 0, processCount: 0,
          }] : []),
        ],
      },
    });
    const peerView = (sessionId) => {
      const selected = view("peer");
      return {
        ...selected,
        agentId: "agent-2",
        selectedSessionId: sessionId,
        selectedView: sessionId === null ? null
          : { ...selected.selectedView, agentId: "agent-2" },
      };
    };
    const writeJSON = (response, body) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    try {
      server = await createServer({
        root: fileURLToPath(
          new URL("../../../services/agent-ui/web/", import.meta.url),
        ),
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
          {
            name: "bridge-session-switch-fixture",
            configureServer(vite) {
              vite.middlewares.use((request, response, next) => {
                const url = new URL(request.url, "http://fixture");
                if (url.pathname === "/api/app/workspace/v1/bootstrap") {
                  writeJSON(response, {
                    principal: {
                      userId: "user-1",
                      organizationId: "org-1",
                      administrator: false,
                    },
                    agents: [
                      {
                        agentId: "agent-1",
                        name: "Agent",
                        lifecycle: "created",
                        activation: "enabled",
                        runtime: "available",
                      },
                      {
                        agentId: "agent-2",
                        name: "Peer Agent",
                        lifecycle: "created",
                        activation: "enabled",
                        runtime: "available",
                      },
                    ],
                    renderedAt: "2026-09-23T00:00:00Z",
                    bridgeEpoch: "epoch-1",
                  });
                  return;
                }
                if (
                  url.pathname ===
                  "/api/app/workspace/v1/agents/agent-1/sessions"
                ) {
                  writeJSON(response, {
                    items: [session("one"), session("two")],
                    nextCursor: null,
                  });
                  return;
                }
                if (url.pathname === "/api/app/workspace/v1/agents/agent-2/sessions") {
                  writeJSON(response, { items: [session("peer")], nextCursor: null });
                  return;
                }
                if (url.pathname === "/api/app/workspace/v1/agents/agent-2/view") {
                  const sessionId = url.searchParams.get("sessionId");
                  assert.ok(sessionId === null || sessionId === "peer");
                  writeJSON(response, peerView(sessionId));
                  return;
                }
                if (url.pathname === "/api/app/workspace/v1/agents/agent-2/events") {
                  response.writeHead(200, {
                    "content-type": "text/event-stream",
                    "cache-control": "no-store",
                    connection: "keep-alive",
                  });
                  response.write(": connected\n\n");
                  peerStreams.add(response);
                  response.on("close", () => peerStreams.delete(response));
                  return;
                }
                if (
                  url.pathname ===
                    "/api/app/workspace/v1/agents/agent-1/sessions/two/prompts" &&
                  request.method === "POST"
                ) {
                  const chunks = [];
                  request.on("data", (chunk) => chunks.push(chunk));
                  request.on("end", () => {
                    const body = JSON.parse(
                      Buffer.concat(chunks).toString("utf8"),
                    );
                    promptBodies.push(body);
                    response.statusCode = 202;
                    writeJSON(response, {
                      operationId: body.intentId,
                      acceptance: "bridge",
                      phase: "dispatching",
                    });
                    if (promptBodies.length <= 2) {
                      if (promptBodies.length === 1) firstIntentId = body.intentId;
                      else {
                        rejectedAudio = true;
                        rejectedIntentId = body.intentId;
                      }
                      streamRevision++;
                      const event = {
                        type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1",
                        projectionId: "projection-two",
                        fromStreamRevision: streamRevision - 1,
                        toStreamRevision: streamRevision,
                        cursor: `cursor-two-${streamRevision}`,
                        view: view("two"),
                      };
                      for (const stream of streams)
                        stream.write(`event: reset\ndata: ${JSON.stringify(event)}\n\n`);
                    }
                  });
                  return;
                }
                if (
                  url.pathname === "/api/app/workspace/v1/agents/agent-1/view"
                ) {
                  const id = url.searchParams.get("sessionId");
                  assert.ok(id === null || id === "one" || id === "two");
                  if (id !== null) selectedViews.push(id);
                  writeJSON(response, id === null
                    ? { ...view("one"), selectedSessionId: null, selectedView: null }
                    : view(id));
                  return;
                }
                if (
                  url.pathname === "/api/app/workspace/v1/agents/agent-1/events"
                ) {
                  response.writeHead(200, {
                    "content-type": "text/event-stream",
                    "cache-control": "no-store",
                    connection: "keep-alive",
                  });
                  response.write(": connected\n\n");
                  streams.add(response);
                  response.on("close", () => streams.delete(response));
                  return;
                }
                next();
              });
            },
          },
        ],
      });
      await server.listen();
      const address = server.httpServer.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.addCookies([
        { name: "antnest_csrf", value: "session-csrf", url: origin },
      ]);
      const page = await context.newPage();
      await page.goto(`${origin}/workspace/?agent=agent-1&session=one`);
      await page.getByText("Answer one").waitFor();
      await page
        .getByRole("textbox", { name: "Message" })
        .fill("Draft for one");
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation two/u })
        .click();
      await page.getByText("Answer two").waitFor();
      assert.equal(
        await page.getByRole("textbox", { name: "Message" }).inputValue(),
        "",
      );
      await page
        .getByRole("textbox", { name: "Message" })
        .fill("Draft for two");
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation one/u })
        .click();
      await page.getByText("Answer one").waitFor();
      assert.equal(
        await page.getByRole("textbox", { name: "Message" }).inputValue(),
        "Draft for one",
      );
      await page.goBack();
      await page.getByText("Answer two").waitFor();
      assert.equal(
        await page.getByRole("textbox", { name: "Message" }).inputValue(),
        "Draft for two",
      );
      assert.deepEqual(selectedViews, ["one", "two", "one", "two"]);
      for (let attempt = 0; attempt < 100 && streams.size !== 1; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        streams.size,
        1,
        "Only the selected Session keeps an observer",
      );
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Peer Agent/u })
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation peer/u })
        .click();
      await page.getByText("Answer peer").waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Message" }).inputValue(), "");
      await page.getByRole("textbox", { name: "Message" }).fill("Draft for peer");
      for (let attempt = 0; attempt < 100 && (streams.size !== 0 || peerStreams.size !== 1); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(streams.size, 0, "Switching Agent must close its old SSE observer");
      assert.equal(peerStreams.size, 1);
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".agent-option")
        .first()
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation two/u })
        .click();
      await page.getByText("Answer two").waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Message" }).inputValue(), "Draft for two");
      for (let attempt = 0; attempt < 100 && (streams.size !== 1 || peerStreams.size !== 0); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(peerStreams.size, 0, "Returning Agent must close the peer SSE observer");
      assert.equal(streams.size, 1);
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Peer Agent/u })
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation peer/u })
        .click();
      await page.getByText("Answer peer").waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Message" }).inputValue(), "Draft for peer");
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".agent-option")
        .first()
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation two/u })
        .click();
      await page.getByText("Answer two").waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Message" }).inputValue(), "Draft for two");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
        "base64",
      );
      const wav = Buffer.from("RIFFsynthetic-wave");
      const pdf = Buffer.from("%PDF-1.4\n%%EOF");
      const note = Buffer.from("attached context");
      await page.evaluate(() => {
        const original = URL.revokeObjectURL.bind(URL);
        window.__revokedPreviews = [];
        URL.revokeObjectURL = (url) => {
          window.__revokedPreviews.push(url);
          original(url);
        };
      });
      await page.getByLabel("File attachments", { exact: true }).setInputFiles([
        { name: "discard-one.txt", mimeType: "text/plain", buffer: note },
        { name: "discard-two.txt", mimeType: "text/plain", buffer: note },
      ]);
      await page.getByRole("button", { name: "Remove discard-one.txt" }).press("Enter");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Remove discard-two.txt");
      await page.getByRole("button", { name: "Remove discard-two.txt" }).press("Enter");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Message");
      await page.getByLabel("File attachments", { exact: true }).setInputFiles([
        { name: "pixel.png", mimeType: "image/png", buffer: png },
        { name: "voice.wav", mimeType: "audio/wav", buffer: wav },
        { name: "report.pdf", mimeType: "application/pdf", buffer: pdf },
        { name: "note.txt", mimeType: "text/plain", buffer: note },
      ]);
      await page.getByRole("textbox", { name: "Message" }).press("Enter");
      for (
        let attempt = 0;
        attempt < 100 && promptBodies.length === 0;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(promptBodies.length, 1);
      assert.deepEqual(promptBodies[0].prompt, [
        { type: "text", text: "Draft for two" },
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
        { type: "audio", mimeType: "audio/wav", data: wav.toString("base64") },
        {
          type: "resource",
          resource: {
            uri: "attachment:///report.pdf",
            mimeType: "application/pdf",
            blob: pdf.toString("base64"),
          },
        },
        {
          type: "resource",
          resource: {
            uri: "attachment:///note.txt",
            mimeType: "text/plain",
            text: note.toString(),
          },
        },
      ]);
      await page.waitForFunction(() => window.__revokedPreviews.length === 2);
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Message");
      await page.getByLabel("File attachments", { exact: true }).setInputFiles({
        name: "unsupported.wav", mimeType: "audio/wav", buffer: wav,
      });
      await page.getByRole("textbox", { name: "Message" }).fill("Unsupported audio check");
      await page.getByRole("textbox", { name: "Message" }).press("Enter");
      await page.getByRole("alert").filter({
        hasText: "The selected model does not support this attachment type.",
      }).waitFor();
      assert.equal(promptBodies.length, 2);
      assert.equal(await page.getByRole("textbox", { name: "Message" }).isEnabled(), true);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Message", "Keyboard submission must return focus after the Run settles");
      await assertWcagPage(page);
      await page.getByRole("textbox", { name: "Message" }).fill("Try again");
      assert.equal(await page.getByRole("button", { name: "Send message" }).isEnabled(), true);
      await page.reload();
      await page.getByRole("alert").filter({
        hasText: "The selected model does not support this attachment type.",
      }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Message" }).isEnabled(), true);
      assert.equal(promptBodies.length, 2, "Reload must not replay a rejected Prompt");
      await page.close();
      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
      });
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(`${origin}/workspace/?agent=agent-1&session=one`);
      await mobilePage.getByText("Answer one").waitFor();
      const navigationButton = mobilePage.getByRole("button", {
        name: "Open navigation",
      });
      await navigationButton.focus();
      await mobilePage.keyboard.press("Enter");
      const navigationDialog = mobilePage.getByRole("dialog", {
        name: "Workspace navigation",
      });
      await navigationDialog.waitFor();
      await assertWcagPage(mobilePage);
      assert.equal(
        await navigationDialog.evaluate((dialog) =>
          dialog.contains(document.activeElement),
        ),
        true,
        "Opening mobile navigation moves focus into the modal dialog",
      );
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let step = 0; step < 12; step++) {
          await mobilePage.keyboard.press(key);
          const focus = await navigationDialog.evaluate((dialog) => ({
            inside: dialog.contains(document.activeElement),
            open: dialog.open,
            tag: document.activeElement?.tagName,
            label: document.activeElement?.getAttribute("aria-label"),
            text: document.activeElement?.textContent?.trim().slice(0, 60),
          }));
          assert.equal(
            focus.inside,
            true,
            `${key} step ${step} must keep keyboard focus inside mobile navigation: ${JSON.stringify(focus)}`,
          );
        }
      }
      await mobilePage.keyboard.press("Escape");
      await navigationDialog.waitFor({ state: "hidden" });
      assert.equal(
        await navigationButton.evaluate(
          (button) => button === document.activeElement,
        ),
        true,
        "Escape returns focus to the navigation button",
      );
      await navigationButton.click();
      await mobilePage
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation two/u })
        .focus();
      await mobilePage.keyboard.press("Enter");
      await mobilePage.getByText("Answer two").waitFor();
      assert.equal(
        await mobilePage
          .getByRole("dialog", { name: "Workspace navigation" })
          .count(),
        0,
      );
      assert.equal(
        await mobilePage
          .getByRole("region", { name: "Conversation messages" })
          .evaluate((region) => region === document.activeElement),
        true,
        "Keyboard conversation selection must move focus to the opened messages",
      );
      assert.equal(
        await mobilePage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await navigationButton.focus();
      await mobilePage.keyboard.press("Enter");
      await mobilePage
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("button", { name: /Peer Agent/u })
        .focus();
      await mobilePage.keyboard.press("Enter");
      await mobilePage.getByRole("heading", { name: "Peer Agent", exact: true }).waitFor();
      assert.equal(
        await mobilePage.evaluate(
          () => document.activeElement?.id === "conversation-main",
        ),
        true,
        "Keyboard Agent selection must focus the new workspace",
      );
      await navigationButton.focus();
      await mobilePage.keyboard.press("Enter");
      await mobilePage
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("button", { name: "All agents" })
        .focus();
      await mobilePage.keyboard.press("Enter");
      await mobilePage.getByRole("searchbox", { name: "Find an agent" }).waitFor();
      assert.equal(
        await mobilePage.getByRole("searchbox", { name: "Find an agent" })
          .evaluate((search) => search === document.activeElement),
        true,
        "Leaving mobile navigation for the Agent directory must focus its search",
      );
      await mobileContext.close();
    } finally {
      for (const response of streams) response.end();
      await browser?.close();
      await server?.close();
    }
  },
);
