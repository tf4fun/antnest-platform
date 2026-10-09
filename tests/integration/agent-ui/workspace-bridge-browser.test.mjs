import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import assert from "node:assert/strict";
import { diffAgentViews } from "../../../services/agent-ui/web/server/dist/protocol/agent-view-delta.js";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "../../../services/agent-ui/web/node_modules/vite/dist/node/index.js";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { assertWcagPage } from "../../support/agent-ui/accessibility.mjs";

test(
  "Bridge browser keeps one HTTP Prompt intent through SSE completion and reload",
  { timeout: 90_000 },
  async () => {
    const clients = new Set();
    const loadingEvidence = fileURLToPath(
      new URL("../../../artifacts/verification/agent-ui/", import.meta.url),
    );
    mkdirSync(loadingEvidence, { recursive: true });
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
    let blocked = false;
    let runtimeFailed = false;
    let expired = false;
    let streamUnavailable = false;
    let interruptFirstPromptStream = false;
    let firstPromptCompletedWithoutObserver = false;
    let liveTurnPhase = "absent";
    let liveProcessVersion = 1;
    let liveSecondText = "Live second step";
    let dropNextProcessPage = false;
    let dropNextProcessContent = false;
    let holdSelectedView = false;
    const heldSelectedViews = [];
    // The opening skeleton renders before the browser requests the selected
    // view, so a release must wait until that request is actually held.
    const releaseSelectedViews = async (answer) => {
      const deadline = Date.now() + 10_000;
      while (heldSelectedViews.length === 0) {
        assert.ok(
          Date.now() < deadline,
          "No selected-view request reached the fixture while held",
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      holdSelectedView = false;
      for (const held of heldSelectedViews.splice(0)) answer(held);
    };
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
        historyToken: blocked ? null : `history-${revision}`,
        streamCursor: `session-${revision}`,
        historyState: blocked ? "blocked" : "ready",
        olderTurnsCursor: blocked ? null : "before-1",
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
        turns: [
          {
            turnId: "turn-1",
            outcome: runtimeFailed ? "failed" : "completed",
            prompt: [{ type: "text", text: "Saved question" }],
            finalResponse: runtimeFailed
              ? []
              : [{ type: "text", text: answer }],
            contentCursor: blocked ? "saved-cut" : null,
            contentSection: blocked ? "finalResponse" : null,
            processVersion: 1,
            processCount: 2,
          },
          ...(liveTurnPhase !== "absent"
            ? [
                {
                  turnId: "turn-live",
                  outcome: liveTurnPhase,
                  prompt: [{ type: "text", text: "Live question" }],
                  finalResponse:
                    liveTurnPhase === "completed"
                      ? [{ type: "text", text: "Live finished" }]
                      : [],
                  contentCursor: null,
                  contentSection: null,
                  processVersion: liveProcessVersion,
                  processCount: 2,
                  ...(liveTurnPhase === "running" && liveProcessVersion > 1
                    ? {
                        liveProcessDelta: {
                          fromVersion: liveProcessVersion - 1,
                          items: [
                            {
                              index: 1,
                              item: {
                                id: "live-second",
                                kind: "thought",
                                summary: "Live progress",
                                status: "running",
                                content: [
                                  { type: "text", text: liveSecondText },
                                ],
                                contentCursor: null,
                              },
                            },
                          ],
                        },
                      }
                    : {}),
                },
              ]
            : []),
        ],
      },
    });
    const writeJSON = (response, value, status = 200) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify(value));
    };
    let publishedView = agentView("cursor-0");
    const publications = [];
    const publish = () => {
      revision++;
      const cursor = `cursor-${revision}`;
      const next = agentView(cursor);
      const delta = diffAgentViews(publishedView, next);
      const body =
        delta && Buffer.byteLength(JSON.stringify(delta)) < 65536
          ? { ...delta, fromCursor: publishedView.streamCursor }
          : { type: "reset", view: next };
      const event = {
        ...body,
        agentId: "agent-1",
        bridgeEpoch: "epoch-1",
        projectionId: "projection-1",
        fromStreamRevision: revision - 1,
        toStreamRevision: revision,
        cursor,
      };
      publishedView = next;
      publications.push(event);
      for (const response of clients)
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
    };
    try {
      server = await createServer({
        root: fileURLToPath(
          new URL("../../../services/agent-ui/web/", import.meta.url),
        ),
        server: { host: "127.0.0.1", port: 0, strictPort: false },
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
                      organizationSlug: "engineering",
                      organizationName: "Engineering",
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
                  if (holdSelectedView) {
                    heldSelectedViews.push(response);
                    return;
                  }
                  if (
                    diffAgentViews(
                      publishedView,
                      agentView(publishedView.streamCursor),
                    )?.patch.length
                  )
                    publish();
                  writeJSON(response, publishedView);
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
                    publish();
                    if (promptNumber === 1 && interruptFirstPromptStream) {
                      streamUnavailable = true;
                      for (const observer of [...clients]) observer.end();
                    }
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
                      if (promptNumber === 1 && interruptFirstPromptStream)
                        firstPromptCompletedWithoutObserver =
                          streamUnavailable && clients.size === 0;
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
                    publish();
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
                    publish();
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
                        contentSection: null,
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
                  if (cursor !== null && dropNextProcessPage) {
                    dropNextProcessPage = false;
                    response.writeHead(200, {
                      "content-type": "application/json",
                    });
                    response.write('{"turnId":"turn-1","items":[');
                    setImmediate(() => response.destroy());
                    return;
                  }
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
                              toolSections: { detailStartIndex: 0 },
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
                              id: "interim-1",
                              kind: "notice",
                              summary: "Intermediate response",
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
                  "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/turn-live/process"
                ) {
                  const cursor = url.searchParams.get("cursor");
                  processReads.push(
                    cursor === null ? "live-page" : "live-page-2",
                  );
                  writeJSON(response, {
                    turnId: "turn-live",
                    processVersion: liveProcessVersion,
                    items: [
                      {
                        id: cursor === null ? "live-first" : "live-second",
                        kind: "thought",
                        summary: "Live progress",
                        status: "running",
                        content: [
                          {
                            type: "text",
                            text:
                              cursor === null
                                ? "Live first step"
                                : liveSecondText,
                          },
                        ],
                        contentCursor: null,
                      },
                    ],
                    nextCursor: cursor === null ? "live-next" : null,
                  });
                  return;
                }
                if (
                  path ===
                  "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/turn-1/process/tool-1/content"
                ) {
                  processReads.push("content");
                  if (dropNextProcessContent) {
                    dropNextProcessContent = false;
                    response.writeHead(200, {
                      "content-type": "application/json",
                    });
                    response.write('{"turnId":"turn-1","items":[');
                    setImmediate(() => response.destroy());
                    return;
                  }
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
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin,
      });
      await context.addCookies([
        { name: "antnest_csrf", value: "browser-csrf", url: origin },
      ]);
      const chooserPage = await context.newPage();
      await chooserPage.goto(`${origin}/workspace/`);
      await chooserPage
        .getByRole("heading", { name: "Your workspaces" })
        .waitFor();
      await assertWcagPage(chooserPage);
      await chooserPage
        .getByRole("link", { name: /Agent/u })
        .first()
        .press("Enter");
      await chooserPage.waitForURL(
        (url) => workspaceLocation(url).agentId === "agent-1",
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
            // The stream applies the change before the client learns that
            // the response was lost; the test releases the loss explicitly.
            const deadline = Date.now() + 10_000;
            while (!window.__releaseLostConfiguration && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error("Configuration response lost after apply");
          }
          if (
            dropPermissionResult &&
            url.endsWith("/decision") &&
            init?.method === "POST"
          ) {
            dropPermissionResult = false;
            // The stream removes the card before the client learns that the
            // response was lost; the test releases the loss explicitly.
            const deadline = Date.now() + 10_000;
            while (!window.__releaseLostPermission && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 10));
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
      holdSelectedView = true;
      await page.goto(`${origin}/workspace/agent-1/sessions/session-1`);
      await page.locator(".session-opening").waitFor();
      const visualTokens = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return Object.fromEntries(
          ["--paper", "--sidebar", "--line", "--muted", "--signal-strong"].map(
            (name) => [name, root.getPropertyValue(name).trim()],
          ),
        );
      });
      assert.deepEqual(
        visualTokens,
        {
          "--paper": "#fbfbfa",
          "--sidebar": "#efefec",
          "--line": "#deded9",
          "--muted": "#62625d",
          "--signal-strong": "#a6d000",
        },
        "Agent UI should use the canonical Antnest palette on the rendered page",
      );
      assert.equal(
        await page.locator(".session-opening").getAttribute("aria-busy"),
        "true",
      );
      assert.equal(
        await page
          .locator(".session-opening-turns[aria-hidden='true']")
          .count(),
        1,
      );
      const openingProcess = await page
        .locator(".session-opening-process")
        .first()
        .boundingBox();
      assert.ok(openingProcess);
      await assertWcagPage(page);
      await page.screenshot({
        path: `${loadingEvidence}opening-desktop.png`,
        animations: "disabled",
      });
      await releaseSelectedViews((held) => writeJSON(held, publishedView));
      try {
        await page.getByText("Saved answer").waitFor({ timeout: 10_000 });
      } catch (cause) {
        throw new Error(
          `${cause.message}\nPage: ${await page.locator("body").innerText()}\nPaths: ${seenPaths.join(", ")}\n${diagnostics.join("\n")}`,
        );
      }
      const loadedProcess = await page
        .locator(".turn-process-trigger")
        .first()
        .boundingBox();
      assert.ok(loadedProcess);
      assert.ok(Math.abs(openingProcess.x - loadedProcess.x) <= 2);
      assert.ok(Math.abs(openingProcess.width - loadedProcess.width) <= 2);
      const mobilePage = await context.newPage();
      await mobilePage.setViewportSize({ width: 390, height: 844 });
      await mobilePage.emulateMedia({ reducedMotion: "reduce" });
      holdSelectedView = true;
      await mobilePage.goto(`${origin}/workspace/agent-1/sessions/session-1`);
      await mobilePage.locator(".session-opening").waitFor();
      const mobileOpeningProcess = await mobilePage
        .locator(".session-opening-process")
        .first()
        .boundingBox();
      assert.ok(mobileOpeningProcess);
      assert.equal(
        await mobilePage
          .locator(".session-opening-line")
          .first()
          .evaluate((element) => getComputedStyle(element).animationName),
        "none",
      );
      await mobilePage.screenshot({
        path: `${loadingEvidence}opening-mobile.png`,
        animations: "disabled",
      });
      assert.ok(
        await mobilePage.evaluate(
          () => document.documentElement.scrollWidth <= 390,
        ),
      );
      await releaseSelectedViews((held) =>
        writeJSON(
          held,
          {
            code: "upstream_timeout",
            message: "History timed out",
            requestId: "opening-timeout",
            retryable: true,
            recovery: "retry_read",
          },
          504,
        ),
      );
      await mobilePage
        .getByRole("alert")
        .filter({ hasText: "History timed out" })
        .waitFor();
      await mobilePage.screenshot({
        path: `${loadingEvidence}opening-error-mobile.png`,
        animations: "disabled",
      });
      assert.equal(
        await mobilePage.locator(".session-opening").getAttribute("aria-busy"),
        "false",
      );
      assert.equal(
        await mobilePage.locator(".session-opening-turns").count(),
        0,
      );
      await assertWcagPage(mobilePage);
      const retryOpening = mobilePage.getByRole("button", {
        name: "Retry loading",
      });
      if (await retryOpening.isVisible()) await retryOpening.click();
      await mobilePage.getByText("Saved answer").waitFor();
      const mobileLoadedProcess = await mobilePage
        .locator(".turn-process-trigger")
        .first()
        .boundingBox();
      assert.ok(mobileLoadedProcess);
      assert.ok(Math.abs(mobileOpeningProcess.x - mobileLoadedProcess.x) <= 2);
      assert.ok(
        Math.abs(mobileOpeningProcess.width - mobileLoadedProcess.width) <= 2,
      );
      await mobilePage.screenshot({
        path: `${loadingEvidence}conversation-mobile.png`,
        animations: "disabled",
      });
      await mobilePage.close();
      const backPage = await context.newPage();
      holdSelectedView = true;
      await backPage.goto(`${origin}/workspace/agent-1/sessions/session-1`);
      await backPage.locator(".session-opening").waitFor();
      await releaseSelectedViews((held) =>
        writeJSON(
          held,
          {
            code: "upstream_timeout",
            message: "History timed out",
            requestId: "opening-timeout-back",
            retryable: true,
            recovery: "retry_read",
          },
          504,
        ),
      );
      await backPage.getByRole("button", { name: "Back to agent" }).click();
      await backPage.waitForURL(
        (url) =>
          workspaceLocation(url).agentId === "agent-1" &&
          workspaceLocation(url).sessionId === null,
      );
      await backPage.close();
      assert.equal(
        await page
          .getByRole("region", { name: "Conversation messages" })
          .count(),
        1,
      );
      const composerStatus = page
        .getByRole("group", { name: "Message composer" })
        .getByRole("status");
      assert.equal(await composerStatus.innerText(), "");
      await assertWcagPage(page);
      await page.getByRole("button", { name: "Copy response" }).click();
      await page.getByRole("status").filter({ hasText: "Copied" }).waitFor();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        "Saved answer",
      );
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
        .locator(".topbar-status .presence")
        .getByText("Status unavailable")
        .waitFor();
      assert.equal(await composerStatus.innerText(), "Connection unavailable");
      assert.equal(
        await page.locator(".topbar-status .presence").getAttribute("role"),
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
      const viewsBeforeStreamRecovery = seenPaths.filter(
        (path) => path === "/api/app/workspace/v1/agents/agent-1/view",
      ).length;
      sessionTitle = "Changed while observer was offline";
      publish();
      assert.equal(
        clients.size,
        0,
        "The missed update must have no connected observer",
      );
      streamUnavailable = false;
      for (let attempt = 0; attempt < 200 && clients.size !== 1; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        clients.size,
        1,
        "A dropped SSE stream must reconnect to its scoped View",
      );
      await page
        .locator(".topbar-status .presence")
        .getByText("Available")
        .waitFor();
      await page
        .locator(".conversation-option.active strong")
        .filter({ hasText: sessionTitle })
        .waitFor();
      assert.ok(
        seenPaths.filter(
          (path) => path === "/api/app/workspace/v1/agents/agent-1/view",
        ).length > viewsBeforeStreamRecovery,
        "Reconnect must recover the missed state from an authoritative View",
      );
      sessionTitle = "Saved question";
      publish();
      await page
        .locator(".conversation-option.active strong")
        .filter({ hasText: sessionTitle })
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
      assert.equal(
        await page.getByRole("group", { name: "Session usage" }).count(),
        0,
      );
      assert.equal(
        await safeModeSwitch.evaluate(
          (element) => element === document.activeElement,
        ),
        true,
        "Closing Usage from another control must leave that control focused",
      );
      const agentViewReads = () =>
        seenPaths.filter(
          (path) => path === "/api/app/workspace/v1/agents/agent-1/view",
        ).length;
      const waitForAgentViewReread = async (before) => {
        for (
          let attempt = 0;
          attempt < 200 && agentViewReads() === before;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
      };
      const viewsBeforeLostConfiguration = agentViewReads();
      await page.getByRole("switch", { name: "Safe mode" }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[role="switch"][aria-label="Safe mode"]')
            ?.getAttribute("aria-checked") === "false",
      );
      assert.equal(
        agentViewReads(),
        viewsBeforeLostConfiguration,
        "The stream update, not a reread, must apply the change while the configuration response is outstanding",
      );
      await page.evaluate(() => {
        window.__releaseLostConfiguration = true;
      });
      await waitForAgentViewReread(viewsBeforeLostConfiguration);
      assert.ok(
        agentViewReads() > viewsBeforeLostConfiguration,
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
      const viewsBeforeLostPermission = agentViewReads();
      const permissionInbox = page.locator(".permission-requests");
      assert.equal(
        await permissionInbox.getAttribute("aria-live"),
        null,
        "Raw tool input must not sit inside a live announcement",
      );
      const permissionAnnouncement = await page
        .getByRole("status")
        .filter({ hasText: /tool approval/u })
        .textContent();
      assert.match(
        permissionAnnouncement ?? "",
        /^1 tool approval requires a decision\. Most recent: Read notes in /u,
      );
      assert.ok(
        !permissionAnnouncement?.includes("notes.md"),
        "The live announcement must omit raw tool input",
      );
      const approvalContext = /Conversation: Saved question.*Read notes/u;
      const approval = page.getByRole("region", {
        name: "Tool approval",
        description: approvalContext,
      });
      assert.equal(await approval.count(), 1);
      await approval
        .getByRole("button", {
          name: "Allow once",
          description: approvalContext,
        })
        .focus();
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
      assert.equal(
        agentViewReads(),
        viewsBeforeLostPermission,
        "The stream update, not a reread, must close the card while the decision response is outstanding",
      );
      await page.evaluate(() => {
        window.__releaseLostPermission = true;
      });
      await waitForAgentViewReread(viewsBeforeLostPermission);
      assert.ok(
        agentViewReads() > viewsBeforeLostPermission,
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
      await page.locator(".tool-activity summary").click();
      await page.getByText("Output preview").waitFor();
      dropNextProcessContent = true;
      await page.getByRole("button", { name: "Load full content" }).click();
      await page.getByText("Full content could not be loaded.").waitFor();
      await page.getByText("Output preview").waitFor();
      await page.getByRole("button", { name: "Retry full content" }).focus();
      await page.keyboard.press("Enter");
      await page.getByText("Output preview full").waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".message")),
        true,
        "Finishing full content must focus the message that replaced its keyboard action",
      );
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.activeElement).outlineStyle,
        ),
        "solid",
        "The focused full message needs a visible keyboard indicator",
      );
      assert.deepEqual(processReads, ["page", "content", "content"]);
      await page.getByText("Loaded 1 of 2 updates").waitFor();
      const desktopViewport = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      const olderControl = page.getByRole("button", {
        name: "Load earlier messages",
      });
      const olderBounds = await olderControl.boundingBox();
      assert.ok(
        olderBounds && olderBounds.height >= 32,
        "History pagination needs a usable mobile touch target",
      );
      assert.ok(
        await olderControl.evaluate(
          (element) =>
            Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) >=
            4,
        ),
        "History pagination should use the same compact control shape as the workspace",
      );
      await page.screenshot({
        path: `${loadingEvidence}process-ready-mobile.png`,
        animations: "disabled",
      });
      dropNextProcessPage = true;
      await page.getByRole("button", { name: "Load more process" }).click();
      await page.getByText("Process could not be loaded.").waitFor();
      await page.getByText("Output preview full").waitFor();
      await page.getByText("Loaded 1 of 2 updates").waitFor();
      await assertWcagPage(page);
      await page.screenshot({
        path: `${loadingEvidence}process-error-mobile.png`,
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Retry process" }).focus();
      await page.keyboard.press("Enter");
      await page.getByText("Second step").waitFor({ state: "attached" });
      assert.equal(
        await page.evaluate(() => document.activeElement?.className),
        "turn-process-trigger",
        "Finishing the last process page must return keyboard focus to its disclosure",
      );
      if (desktopViewport) await page.setViewportSize(desktopViewport);
      const firstExchange = await page
        .locator(".conversation-turn")
        .first()
        .innerText();
      assert.ok(
        firstExchange.indexOf("Second step") < firstExchange.indexOf(answer),
        "An interim Agent response must remain inside process before the final answer",
      );
      assert.equal(
        await page.locator(".turn-process-content .message-system").count(),
        0,
      );
      await page.getByText("Loaded 2 of 2 updates").waitFor();
      await assertWcagPage(page);
      assert.deepEqual(processReads, [
        "page",
        "content",
        "content",
        "page-2",
        "page-2",
      ]);
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
      await secondPage.goto(`${origin}/workspace/agent-1/sessions/session-1`);
      await secondPage.getByText("Saved answer").waitFor();
      await page.getByRole("combobox", { name: "Message" }).fill("Continue");
      interruptFirstPromptStream = true;
      await page.getByRole("button", { name: "Send message" }).click();
      for (
        let attempt = 0;
        attempt < 200 && !firstPromptCompletedWithoutObserver;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        firstPromptCompletedWithoutObserver,
        true,
        "The accepted Prompt must finish while no browser SSE observer is connected",
      );
      assert.equal(
        prompts.length,
        1,
        "Losing the observer must not replay the Prompt",
      );
      streamUnavailable = false;
      await page.getByText("Completed over SSE").waitFor();
      await secondPage.getByText("Completed over SSE").waitFor();
      for (const observer of [page, secondPage])
        await observer.waitForFunction(() => {
          const row = document.querySelector(".conversation-option.active");
          return (
            row?.querySelector("strong")?.textContent ===
              "ACP renamed session" &&
            row.querySelector("time")?.getAttribute("datetime") ===
              "2026-09-24T02:00:00Z"
          );
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
      await page
        .getByRole("combobox", { name: "Message" })
        .fill("Keep working");
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
        return (
          row?.querySelector("strong")?.textContent === "ACP renamed session" &&
          row.querySelector("time")?.getAttribute("datetime") ===
            "2026-09-24T02:00:00Z"
        );
      });
      assert.equal(prompts.length, 2, "Reload must not resubmit the Prompt");
      runtimeFailed = true;
      operation = {
        ...operation,
        phase: "failed",
        stopReason: "runtime_unavailable",
        errorClass: "vendor_future_failure",
      };
      publish();
      await secondPage.getByText("Offline", { exact: true }).first().waitFor();
      assert.equal(
        await secondPage
          .locator(".topbar-status .presence")
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
      const viewReadsBefore = seenPaths.filter((path) =>
        path.endsWith("/view"),
      ).length;
      sessionTitle = "Renamed through incremental delivery";
      publish();
      await secondPage
        .locator(".conversation-option.active strong")
        .filter({ hasText: sessionTitle })
        .waitFor();
      assert.equal(publications.at(-1).type, "delta");
      assert.equal(
        JSON.stringify(publications.at(-1)).includes(answer),
        false,
        "A title update must not repeat the retained answer",
      );
      assert.equal(
        seenPaths.filter((path) => path.endsWith("/view")).length,
        viewReadsBefore,
        "A continuous delta must update the browser without a View GET",
      );
      await secondPage.getByText("Continued after tab close").waitFor();
      await secondPage.reload();
      await secondPage.getByText("Continued after tab close").waitFor();
      assert.equal(prompts.length, 2, "Reload must not resubmit the Prompt");
      liveTurnPhase = "running";
      publish();
      await secondPage.getByRole("button", { name: "Hide process" }).waitFor();
      await secondPage
        .getByText("Live first step")
        .waitFor({ state: "attached" });
      await secondPage
        .getByText("Live second step")
        .waitFor({ state: "attached" });
      const liveProcess = secondPage
        .locator('.turn-process[data-complete="false"]')
        .last();
      const liveSpacing = await liveProcess.evaluate((process) => {
        const trigger = process.querySelector(".turn-process-trigger");
        const content = process.querySelector(".turn-process-content");
        if (!trigger || !content) return null;
        return (
          content.getBoundingClientRect().top -
          trigger.getBoundingClientRect().bottom
        );
      });
      assert.ok(
        liveSpacing !== null && liveSpacing >= 11,
        `running Process header needs visible Tool spacing, got ${liveSpacing}`,
      );
      await secondPage.screenshot({
        path: `${loadingEvidence}process-live-spacing.png`,
        animations: "disabled",
      });
      assert.deepEqual(processReads.slice(-2), ["live-page", "live-page-2"]);
      const liveReads = processReads.length;
      liveProcessVersion = 2;
      liveSecondText = "Live second step updated";
      publish();
      await secondPage.getByText(liveSecondText).waitFor({ state: "attached" });
      assert.equal(
        processReads.length,
        liveReads,
        "A continuous live process delta must not refetch process pages",
      );
      liveTurnPhase = "completed";
      publish();
      await secondPage.getByText("Live finished").waitFor();
      for (let attempt = 0; attempt < 200 && clients.size !== 1; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        clients.size,
        1,
        "Reloaded page must reattach its SSE observer",
      );
      await secondPage
        .getByRole("combobox", { name: "Message" })
        .fill("Ready again");
      await secondPage.getByRole("combobox", { name: "Message" }).focus();
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
            "/workspace/agent-1/sessions/session-1",
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
  { timeout: 90_000 },
  async () => {
    const streams = new Set();
    const peerStreams = new Set();
    const selectedViews = [];
    const promptBodies = [];
    const heldProcessContent = [];
    let processContentClosed = false;
    let processContentRequests = 0;
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
      operations:
        id === "two"
          ? [
              ...(firstIntentId
                ? [
                    {
                      operationId: firstIntentId,
                      sessionId: "two",
                      phase: "completed",
                      acceptance: "acp",
                      runId: "first-run",
                      outputWatermark: 2,
                    },
                  ]
                : []),
              ...(rejectedAudio
                ? [
                    {
                      operationId: rejectedIntentId,
                      sessionId: "two",
                      phase: "failed",
                      acceptance: "acp",
                      runId: "rejected-run",
                      outputWatermark: 3,
                      errorClass: "model_unsupported_content",
                    },
                  ]
                : []),
            ]
          : [],
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
        operations:
          id === "two"
            ? [
                ...(firstIntentId
                  ? [
                      {
                        operationId: firstIntentId,
                        sessionId: "two",
                        phase: "completed",
                        acceptance: "acp",
                        runId: "first-run",
                        outputWatermark: 2,
                      },
                    ]
                  : []),
                ...(rejectedAudio
                  ? [
                      {
                        operationId: rejectedIntentId,
                        sessionId: "two",
                        phase: "failed",
                        acceptance: "acp",
                        runId: "rejected-run",
                        outputWatermark: 3,
                        errorClass: "model_unsupported_content",
                      },
                    ]
                  : []),
              ]
            : [],
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
            contentSection: null,
            processVersion: id === "one" ? 1 : 0,
            processCount: id === "one" ? 1 : 0,
          },
          ...(id === "two" && rejectedAudio
            ? [
                {
                  turnId: "rejected-run",
                  outcome: "failed",
                  prompt: [{ type: "text", text: "Unsupported audio check" }],
                  finalResponse: [],
                  contentCursor: null,
                  contentSection: null,
                  processVersion: 0,
                  processCount: 0,
                },
              ]
            : []),
        ],
      },
    });
    const peerView = (sessionId) => {
      const selected = view("peer");
      return {
        ...selected,
        agentId: "agent-2",
        selectedSessionId: sessionId,
        selectedView:
          sessionId === null
            ? null
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
        server: { host: "127.0.0.1", port: 0, strictPort: false },
        plugins: [
          {
            name: "bridge-session-switch-fixture",
            configureServer(vite) {
              vite.middlewares.use((request, response, next) => {
                const url = new URL(request.url, "http://fixture");
                if (url.pathname === "/api/app/workspace/v1/bootstrap") {
                  writeJSON(response, {
                    principal: {
                      organizationSlug: "engineering",
                      organizationName: "Engineering",
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
                if (
                  url.pathname ===
                  "/api/app/workspace/v1/agents/agent-2/sessions"
                ) {
                  writeJSON(response, {
                    items: [session("peer")],
                    nextCursor: null,
                  });
                  return;
                }
                if (
                  url.pathname === "/api/app/workspace/v1/agents/agent-2/view"
                ) {
                  const sessionId = url.searchParams.get("sessionId");
                  assert.ok(sessionId === null || sessionId === "peer");
                  writeJSON(response, peerView(sessionId));
                  return;
                }
                if (
                  url.pathname === "/api/app/workspace/v1/agents/agent-2/events"
                ) {
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
                      if (promptBodies.length === 1)
                        firstIntentId = body.intentId;
                      else {
                        rejectedAudio = true;
                        rejectedIntentId = body.intentId;
                      }
                      streamRevision++;
                      const event = {
                        type: "reset",
                        agentId: "agent-1",
                        bridgeEpoch: "epoch-1",
                        projectionId: "projection-two",
                        fromStreamRevision: streamRevision - 1,
                        toStreamRevision: streamRevision,
                        cursor: `cursor-two-${streamRevision}`,
                        view: view("two"),
                      };
                      for (const stream of streams)
                        stream.write(
                          `event: reset\ndata: ${JSON.stringify(event)}\n\n`,
                        );
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
                  writeJSON(
                    response,
                    id === null
                      ? {
                          ...view("one"),
                          selectedSessionId: null,
                          selectedView: null,
                        }
                      : view(id),
                  );
                  return;
                }
                if (
                  url.pathname ===
                  "/api/app/workspace/v1/agents/agent-1/sessions/one/turns/turn-one/process"
                ) {
                  writeJSON(response, {
                    turnId: "turn-one",
                    processVersion: 1,
                    items: [
                      {
                        id: "tool-one",
                        kind: "tool",
                        summary: "Large tool",
                        status: "completed",
                        toolSections: { detailStartIndex: 0 },
                        content: [{ type: "text", text: "Preview" }],
                        contentCursor: "tool-more",
                      },
                    ],
                    nextCursor: null,
                  });
                  return;
                }
                if (
                  url.pathname ===
                  "/api/app/workspace/v1/agents/agent-1/sessions/one/turns/turn-one/process/tool-one/content"
                ) {
                  processContentRequests++;
                  if (processContentRequests === 1) {
                    heldProcessContent.push(response);
                    response.on("close", () => {
                      processContentClosed = true;
                    });
                  } else {
                    writeJSON(response, {
                      turnId: "turn-one",
                      itemId: "tool-one",
                      items: [
                        {
                          type: "text",
                          text: `Late tool body ${processContentRequests}: ${"x".repeat(1024 * 1024)} END-OF-LARGE-TOOL`,
                        },
                      ],
                      nextCursor: null,
                      complete: true,
                    });
                  }
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
      await page.goto(`${origin}/workspace/agent-1/sessions/one`);
      await page.getByText("Answer one").waitFor();
      const sidebar = page.getByRole("complementary", {
        name: "Workspace navigation",
      });
      const workspaceSwitcher = sidebar.locator(".workspace-switcher");
      const newConversation = sidebar.getByRole("button", {
        name: "New conversation",
      });
      const contextBounds = await workspaceSwitcher.boundingBox();
      const actionBounds = await newConversation.boundingBox();
      assert.ok(
        contextBounds.y + contextBounds.height <= actionBounds.y,
        "Workspace context must sit above its conversation actions",
      );
      const historyBefore = await sidebar
        .locator(".conversation-list")
        .boundingBox();
      await workspaceSwitcher.click();
      await sidebar.getByRole("group", { name: "Workspaces" }).waitFor();
      assert.deepEqual(
        await sidebar.locator(".conversation-list").boundingBox(),
        historyBefore,
        "Opening the workspace picker must not displace conversation history",
      );
      await assertWcagPage(page);
      await page.keyboard.press("Escape");
      assert.equal(
        await workspaceSwitcher.evaluate(
          (element) => document.activeElement === element,
        ),
        true,
      );
      assert.equal(workspaceLocation(page.url()).sessionId, "one");
      await page
        .getByRole("combobox", { name: "Message" })
        .fill("Draft for one");
      await page.getByRole("button", { name: "Show process" }).click();
      await page.locator(".tool-activity summary").click();
      await page.getByRole("button", { name: "Load full content" }).click();
      for (
        let attempt = 0;
        attempt < 100 && heldProcessContent.length === 0;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        heldProcessContent.length,
        1,
        "The full tool body must have an in-flight browser request",
      );
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation two/u })
        .click();
      await page.getByText("Answer two").waitFor();
      for (let attempt = 0; attempt < 100 && !processContentClosed; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        processContentClosed,
        true,
        "Leaving the Session must abort its in-flight tool content response",
      );
      assert.equal(await page.getByText("Late tool body").count(), 0);
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).inputValue(),
        "",
      );
      await page
        .getByRole("combobox", { name: "Message" })
        .fill("Draft for two");
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation one/u })
        .click();
      await page.getByText("Answer one").waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).inputValue(),
        "Draft for one",
      );
      await page.goBack();
      await page.getByText("Answer two").waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).inputValue(),
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
      await sidebar
        .getByRole("searchbox", { name: "Search conversations" })
        .fill("Conversation two");
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".workspace-switcher")
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Peer Agent/u })
        .click();
      assert.equal(
        await sidebar
          .getByRole("searchbox", { name: "Search conversations" })
          .inputValue(),
        "",
      );
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation peer/u })
        .click();
      await page.getByText("Answer peer").waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).inputValue(),
        "",
      );
      await page
        .getByRole("combobox", { name: "Message" })
        .fill("Draft for peer");
      for (
        let attempt = 0;
        attempt < 100 && (streams.size !== 0 || peerStreams.size !== 1);
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        streams.size,
        0,
        "Switching Agent must close its old SSE observer",
      );
      assert.equal(peerStreams.size, 1);
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".workspace-switcher")
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".workspace-option")
        .first()
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation two/u })
        .click();
      await page.getByText("Answer two").waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).inputValue(),
        "Draft for two",
      );
      for (
        let attempt = 0;
        attempt < 100 && (streams.size !== 1 || peerStreams.size !== 0);
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        peerStreams.size,
        0,
        "Returning Agent must close the peer SSE observer",
      );
      assert.equal(streams.size, 1);
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".workspace-switcher")
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Peer Agent/u })
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation peer/u })
        .click();
      await page.getByText("Answer peer").waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).inputValue(),
        "Draft for peer",
      );
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".workspace-switcher")
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".workspace-option")
        .first()
        .click();
      await page
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /Conversation two/u })
        .click();
      await page.getByText("Answer two").waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).inputValue(),
        "Draft for two",
      );
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
      await page
        .getByRole("button", { name: "Remove discard-one.txt" })
        .press("Enter");
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Remove discard-two.txt",
      );
      await page
        .getByRole("button", { name: "Remove discard-two.txt" })
        .press("Enter");
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Message",
      );
      await page.getByLabel("File attachments", { exact: true }).setInputFiles([
        { name: "pixel.png", mimeType: "image/png", buffer: png },
        { name: "voice.wav", mimeType: "audio/wav", buffer: wav },
        { name: "report.pdf", mimeType: "application/pdf", buffer: pdf },
        { name: "note.txt", mimeType: "text/plain", buffer: note },
      ]);
      await page
        .getByRole("combobox", { name: "Message" })
        .evaluate((editor) => {
          editor.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              keyCode: 229,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      assert.equal(
        promptBodies.length,
        0,
        "IME confirmation must not submit the draft",
      );
      await page.getByRole("combobox", { name: "Message" }).press("Enter");
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
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Message",
      );
      await page.getByLabel("File attachments", { exact: true }).setInputFiles({
        name: "unsupported.wav",
        mimeType: "audio/wav",
        buffer: wav,
      });
      await page
        .getByRole("combobox", { name: "Message" })
        .fill("Unsupported audio check");
      await page.getByRole("combobox", { name: "Message" }).press("Enter");
      await page
        .getByRole("alert")
        .filter({
          hasText: "The selected model does not support this attachment type.",
        })
        .waitFor();
      assert.equal(promptBodies.length, 2);
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).isEnabled(),
        true,
      );
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Message",
        "Keyboard submission must return focus after the Run settles",
      );
      await assertWcagPage(page);
      await page.getByRole("combobox", { name: "Message" }).fill("Try again");
      assert.equal(
        await page.getByRole("button", { name: "Send message" }).isEnabled(),
        true,
      );
      await page.reload();
      await page
        .getByRole("alert")
        .filter({
          hasText: "The selected model does not support this attachment type.",
        })
        .waitFor();
      assert.equal(
        await page.getByRole("combobox", { name: "Message" }).isEnabled(),
        true,
      );
      assert.equal(
        promptBodies.length,
        2,
        "Reload must not replay a rejected Prompt",
      );
      await page.close();
      const memoryPage = await context.newPage();
      await memoryPage.goto(`${origin}/workspace/agent-1/sessions/two`);
      await memoryPage.getByText("Answer two").waitFor();
      const heapSession = await context.newCDPSession(memoryPage);
      const heapBytes = async () => {
        await heapSession.send("HeapProfiler.collectGarbage");
        const { usedSize: bytes } = await heapSession.send(
          "Runtime.getHeapUsage",
        );
        assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
        return bytes;
      };
      const baselineHeapBytes = await heapBytes();
      const loadedBytes = [];
      const afterNavigationBytes = [];
      try {
        for (let cycle = 0; cycle < 6; cycle++) {
          await memoryPage
            .getByRole("complementary", { name: "Workspace navigation" })
            .getByRole("button", { name: /Conversation one/u })
            .click();
          await memoryPage.getByText("Answer one").waitFor();
          await memoryPage
            .getByRole("button", { name: "Show process" })
            .click();
          await memoryPage.locator(".tool-activity summary").click();
          await memoryPage
            .getByRole("button", { name: "Load full content" })
            .click();
          await memoryPage.waitForFunction(() =>
            document.body.textContent?.includes("END-OF-LARGE-TOOL"),
          );
          loadedBytes.push(await heapBytes());
          await memoryPage
            .getByRole("complementary", { name: "Workspace navigation" })
            .getByRole("button", { name: /Conversation two/u })
            .click();
          await memoryPage.getByText("Answer two").waitFor();
          assert.equal(
            await memoryPage.getByText("END-OF-LARGE-TOOL").count(),
            0,
          );
          afterNavigationBytes.push(await heapBytes());
        }
        assert.ok(
          loadedBytes.every(
            (bytes, index) => bytes > afterNavigationBytes[index] + 512 * 1024,
          ),
          `CDP heap samples did not detect loaded tool bodies: ${JSON.stringify({ loadedBytes, afterNavigationBytes })}`,
        );
        assert.ok(
          afterNavigationBytes.at(-1) <
            afterNavigationBytes[0] + 2 * 1024 * 1024,
          `Navigation retained large tool bodies: ${JSON.stringify(afterNavigationBytes)}`,
        );
        const evidence = fileURLToPath(
          new URL(
            "../../../artifacts/verification/agent-ui/browser-navigation-heap.json",
            import.meta.url,
          ),
        );
        mkdirSync(
          fileURLToPath(
            new URL(
              "../../../artifacts/verification/agent-ui/",
              import.meta.url,
            ),
          ),
          { recursive: true },
        );
        writeFileSync(
          evidence,
          JSON.stringify(
            {
              baselineHeapBytes,
              loadedBytes,
              afterNavigationBytes,
              bodyBytes: 1024 * 1024,
              cycles: 6,
            },
            null,
            2,
          ) + "\n",
        );
      } finally {
        await heapSession.detach();
        await memoryPage.close();
      }
      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
      });
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(`${origin}/workspace/agent-1/sessions/one`);
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
      await navigationDialog.locator(".workspace-switcher").click();
      await navigationDialog
        .getByRole("group", { name: "Workspaces" })
        .waitFor();
      await assertWcagPage(mobilePage);
      await mobilePage.keyboard.press("Escape");
      assert.equal(
        await navigationDialog.isVisible(),
        true,
        "First Escape dismisses only the workspace picker, keeping mobile navigation open",
      );
      assert.equal(
        await navigationDialog
          .locator(".workspace-switcher")
          .getAttribute("aria-expanded"),
        "false",
      );
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
        .locator(".workspace-switcher")
        .click();
      await mobilePage
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("button", { name: /Peer Agent/u })
        .focus();
      await mobilePage.keyboard.press("Enter");
      await mobilePage
        .getByRole("heading", { name: "Peer Agent", exact: true })
        .waitFor();
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
        .locator(".workspace-switcher")
        .click();
      await mobilePage
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("button", { name: "All workspaces" })
        .focus();
      await mobilePage.keyboard.press("Enter");
      await mobilePage
        .getByRole("searchbox", { name: "Find a workspace" })
        .waitFor();
      assert.equal(
        await mobilePage
          .getByRole("searchbox", { name: "Find a workspace" })
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
