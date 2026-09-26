import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import {
  assertReadableText,
  assertTouchTargets,
} from "../../integration/agent-ui/visual-assertions.mjs";
import { assertWcagPage } from "../../support/agent-ui/accessibility.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { audioData } from "../acp-multimodal/fixtures.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { member, setup, until } from "../workspace-closeout/c4-setup.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);
const sizeBytes = (value) => {
  const match = value.match(/^([\d.]+)(B|KiB|MiB|GiB|TiB)/);
  assert.ok(match, `Unexpected Docker memory unit: ${value}`);
  return Math.round(
    Number(match[1]) *
      1024 ** ["B", "KiB", "MiB", "GiB", "TiB"].indexOf(match[2]),
  );
};
const mib = 1024 * 1024;
const percentile90 = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.9) - 1];
};

function throttleSse(response) {
  let bytes = 0;
  response.pause();
  const timer = setInterval(() => {
    const chunk = response.read(1024);
    if (chunk) bytes += chunk.length;
  }, 50);
  return { bytes: () => bytes, stop: () => clearInterval(timer) };
}

function assertFixedWorkloadPerformance(metrics) {
  for (const kind of ["heldRunRestartMs", "pendingPermissionRestartMs"])
    assert.ok(
      metrics.deployment[kind] < 30_000,
      `${kind} must finish within the Compose stop grace: ${metrics.deployment[kind]}`,
    );
  for (const kind of ["first-after-start", "first-after-restart"]) {
    const cold = metrics.document.find((sample) => sample.kind === kind);
    assert.ok(
      cold && cold.headerMs < 1_000,
      `${kind} HTML header must arrive within 1 s: ${JSON.stringify(cold)}`,
    );
  }
  for (const kind of ["warm-before-restart", "warm-after-restart"]) {
    const samples = metrics.document.filter((sample) => sample.kind === kind);
    assert.equal(samples.length, 12, `${kind} needs twelve samples`);
    const p90 = percentile90(samples.map((sample) => sample.headerMs));
    assert.ok(
      p90 < 100,
      `${kind} HTML header p90 must be below 100 ms: ${p90}`,
    );
  }
  const paint = metrics.browser.navigation.firstContentfulPaintMs;
  assert.ok(
    Number.isFinite(paint) && paint < 2_000,
    `First contentful paint must be below 2 s: ${paint}`,
  );
  assert.ok(
    metrics.browser.interactiveMs < 5_000,
    `Composer must be interactive within 5 s: ${metrics.browser.interactiveMs}`,
  );
  const browserHeap = metrics.browser.heap;
  assert.equal(
    browserHeap.samplesBytes.length,
    10,
    "The live browser must be sampled across both sets of Session turns",
  );
  assert.ok(
    Math.max(...browserHeap.samplesBytes) < 64 * mib,
    `Fixed-volume browser JS heap samples must stay below 64 MiB: ${JSON.stringify(browserHeap)}`,
  );
  assert.ok(
    browserHeap.afterGcBytes < browserHeap.baselineAfterGcBytes + 16 * mib,
    `Browser JS heap retained after 40 new turns must grow by less than 16 MiB: ${JSON.stringify(browserHeap)}`,
  );
  const samples = metrics.memory.volumeBatches.flatMap(
    (batch) => batch.memoryBytes,
  );
  samples.push(metrics.memory.afterHistoricalPagesBytes);
  assert.ok(
    Math.max(...samples) < 384 * mib,
    `Fixed-volume Bridge memory must stay below 384 MiB: ${JSON.stringify(samples)}`,
  );
  for (const batch of metrics.memory.volumeBatches)
    assert.ok(
      batch.afterIdleBytes < 256 * mib,
      `Bridge memory after a slow observer disconnect must stay below 256 MiB: ${batch.afterIdleBytes}`,
    );
  for (const batch of metrics.memory.volumeBatches) {
    if (!batch.heapBefore || !batch.heapAfterIdle) continue;
    assert.ok(
      batch.heapAfterIdle.usedBytes < batch.heapBefore.usedBytes + 32 * mib,
      `Bridge used heap retained after a slow observer disconnect grew by 32 MiB: ${JSON.stringify(batch)}`,
    );
  }
}

test(
  "real stack preserves Runs across Bridge and Gateway restart, logout, Stop, permission, timeout, expiry and revocation",
  { timeout: 1_200_000 },
  async () => {
    process.chdir(root);
    const abort = new AbortController();
    const interrupt = () =>
      abort.abort(new Error("Agent UI full-stack E2E interrupted"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let config;
    let browser;
    let slowRequest;
    let slowReader;
    let secondSlowRequest;
    let secondSlowReader;
    const images = [];
    try {
      config = await configuration(abort.signal);
      const heapDiagnostics =
        process.env.ANTNEST_UI_E2E_HEAP_DIAGNOSTICS === "1";
      const suffix = config.project.slice(-8);
      const uiImage = `antnest/agent-ui:ui-e2e-${suffix}`;
      const acpImage = `antnest/agent-acp-service:ui-e2e-${suffix}`;
      const gatewayImage = `antnest/edge-gateway:ui-e2e-${suffix}`;
      images.push(uiImage, acpImage, gatewayImage);
      Object.assign(config.env, {
        ANTNEST_C4_AGENT_UI_IMAGE: uiImage,
        ANTNEST_UI_E2E_ACP_IMAGE: acpImage,
        ANTNEST_UI_E2E_GATEWAY_IMAGE: gatewayImage,
        ANTNEST_UI_E2E_NODE_OPTIONS: heapDiagnostics
          ? "--report-on-signal --report-directory=/tmp"
          : "",
        ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
        ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
          config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
        ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
          config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(
            ".0/24",
            ".128/25",
          ),
      });
      const docker = dockerClient(config.env, abort.signal, 1_200_000);
      for (const [file, image] of [
        ["services/agent-acp-service/Dockerfile", acpImage],
        ["services/agent-ui/Dockerfile", uiImage],
        ["services/edge-gateway/Dockerfile", gatewayImage],
      ])
        await docker(["build", "-f", file, "-t", image, "."], true);
      await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "180",
          "--no-build",
        ]),
        true,
      );
      const fixture = await setup(config, abort.signal);
      const memberClient = new GatewayClient(config.gateway);
      await memberClient.request("/api/session/login", { body: member });
      const uiContainer = await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "ps",
          "-q",
          "agent-ui",
        ]),
        true,
      );
      assert.ok(uiContainer);
      const containerMemory = async () =>
        sizeBytes(
          (
            await docker([
              "stats",
              "--no-stream",
              "--format",
              "{{.MemUsage}}",
              uiContainer,
            ])
          )
            .split("/")[0]
            .trim(),
        );
      const heapMemory = async () => {
        await docker(["kill", "--signal=SIGUSR2", uiContainer]);
        const readReport = `const fs=require('node:fs');const files=fs.readdirSync('/tmp')
        .filter(name=>/^report\\..*\\.json$/.test(name)).sort();
        if(!files.length)process.exit(2);
        const path='/tmp/'+files.at(-1);const report=JSON.parse(fs.readFileSync(path));
        fs.unlinkSync(path);process.stdout.write(JSON.stringify({
          usedBytes:report.javascriptHeap.usedMemory,
          committedBytes:report.javascriptHeap.totalCommittedMemory,
          externalBytes:report.javascriptHeap.externalMemory,
          rssBytes:report.resourceUsage.rss}));`;
        return until(
          async () => {
            try {
              return JSON.parse(
                await docker(["exec", uiContainer, "node", "-e", readReport]),
              );
            } catch {
              return null;
            }
          },
          "Bridge heap diagnostic report",
          abort.signal,
          10_000,
        );
      };
      const metrics = {
        capturedAt: new Date().toISOString(),
        document: [],
        browser: {},
        memory: {},
        deployment: {},
      };
      metrics.memory.initialBeforeRestartsBytes = await containerMemory();
      const measureDocument = async (kind) => {
        const start = performance.now();
        const response = await fetch(
          `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/`,
          {
            headers: { Cookie: memberClient.cookie },
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(15_000),
            ]),
          },
        );
        const headerMs = performance.now() - start;
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.match(body, /workspace-bootstrap/);
        assert.match(body, /C4 Browser Agent/);
        metrics.document.push({
          kind,
          headerMs,
          completeMs: performance.now() - start,
          bytes: Buffer.byteLength(body),
        });
      };
      await measureDocument("first-after-start");
      for (let index = 0; index < 12; index++)
        await measureDocument("warm-before-restart");
      const created = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          {
            status: 201,
            body: {},
          },
        )
      ).body;
      const sessionId = created.sessionId;
      assert.ok(sessionId);
      browser = await chromium.launch({
        headless: true,
        args: ["--enable-precise-memory-info"],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      const context = await browser.newContext();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: config.gateway,
      });
      await context.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        const failures = {
          cancel: false,
          configuration: false,
          permission: false,
          cancelDropped: 0,
          configurationDropped: 0,
          permissionDropped: 0,
        };
        window.__antnestE2EFailures = failures;
        window.fetch = async (input, init) => {
          const response = await originalFetch(input, init);
          const url = typeof input === "string" ? input : input.url;
          if (
            init?.method === "POST" &&
            failures.cancel &&
            url.endsWith("/cancel")
          ) {
            failures.cancel = false;
            failures.cancelDropped++;
            throw new Error("Stop response lost after apply");
          }
          if (
            init?.method === "POST" &&
            failures.configuration &&
            url.endsWith("/configuration")
          ) {
            failures.configuration = false;
            failures.configurationDropped++;
            throw new Error("Configuration response lost after apply");
          }
          if (
            init?.method === "POST" &&
            failures.permission &&
            url.endsWith("/decision")
          ) {
            failures.permission = false;
            failures.permissionDropped++;
            throw new Error("Permission response lost after apply");
          }
          return response;
        };
      });
      const browserHeapBytes = async (page) => {
        const bytes = await page.evaluate(
          () => performance.memory?.usedJSHeapSize,
        );
        assert.ok(
          Number.isSafeInteger(bytes) && bytes > 0,
          `Chromium JS heap measurement is unavailable: ${bytes}`,
        );
        return bytes;
      };
      await context.addCookies(
        [...memberClient.cookies].map(([name, value]) => ({
          name,
          value,
          url: config.gateway,
        })),
      );
      const errors = [];
      const sockets = [];
      const open = async (selectedSessionId = sessionId) => {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("websocket", (socket) => sockets.push(socket.url()));
        await page.goto(
          `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/sessions/${encodeURIComponent(selectedSessionId)}`,
        );
        return page;
      };
      const navigationStart = performance.now();
      const page = await open();
      const composer = page.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await composer.waitFor({ state: "visible", timeout: 120_000 });
      await until(
        () => composer.isEnabled(),
        "Bridge composer ready",
        abort.signal,
      );
      await assertWcagPage(page);
      metrics.browser.interactiveMs = performance.now() - navigationStart;
      metrics.browser.navigation = await page.evaluate(() => {
        const entry = performance.getEntriesByType("navigation")[0];
        const paint = performance
          .getEntriesByType("paint")
          .find((item) => item.name === "first-contentful-paint");
        return {
          responseStartMs: entry?.responseStart ?? null,
          domContentLoadedMs: entry?.domContentLoadedEventEnd ?? null,
          firstContentfulPaintMs: paint?.startTime ?? null,
        };
      });
      const originalAppendVersion = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
        )
      ).body.selectedView?.appendVersion;
      assert.ok(Number.isSafeInteger(originalAppendVersion));
      await composer.fill("c4-browser-hold-close");
      await composer.press("Enter");
      const modelState = async () =>
        await (
          await fetch(`${config.model}/status`, {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          })
        ).json();
      await until(
        async () =>
          (await modelState()).pending.includes("c4-browser-hold-close"),
        "model holds accepted Run",
        abort.signal,
      );
      const heldRun = await until(
        async () => {
          const view = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
            )
          ).body;
          return view.operations?.find(
            (row) =>
              row.sessionId === sessionId &&
              row.phase === "running" &&
              row.runId,
          );
        },
        "held Run has durable receipt before Bridge restart",
        abort.signal,
      );
      const heldMetadata = await until(
        async () => {
          const view = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
            )
          ).body.selectedView;
          return typeof view?.title === "string" &&
            view.title &&
            typeof view.updatedAt === "string" &&
            view.updatedAt
            ? { title: view.title, updatedAt: view.updatedAt }
            : null;
        },
        "ACP Session metadata reaches the Node View",
        abort.signal,
      );
      await page.waitForFunction(({ title, updatedAt }) => {
        const row = document.querySelector(".conversation-option.active");
        return (
          row?.querySelector("strong")?.textContent === title &&
          row.querySelector("time")?.getAttribute("datetime") === updatedAt
        );
      }, heldMetadata);
      const secondSession = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          {
            status: 201,
            body: {},
          },
        )
      ).body.sessionId;
      assert.ok(secondSession);
      const otherSessionViewPath = `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${secondSession}`;
      const assertHeldRunAcrossSessions = async () => {
        const view = (await memberClient.request(otherSessionViewPath)).body;
        assert.equal(view.selectedSessionId, secondSession);
        assert.equal(view.activeSessionId, sessionId);
        assert.ok(
          view.operations?.some(
            (operation) =>
              operation.sessionId === sessionId &&
              operation.operationId === heldRun.operationId &&
              operation.runId === heldRun.runId &&
              operation.phase === "running",
          ),
        );
      };
      await assertHeldRunAcrossSessions();
      const beforeRestart = (
        await memberClient.request("/api/app/workspace/v1/bootstrap")
      ).body.bridgeEpoch;
      assert.ok(beforeRestart);
      await page.close();
      const heldRunRestartStartedAt = performance.now();
      await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "restart",
          "agent-ui",
        ]),
        true,
      );
      metrics.deployment.heldRunRestartMs = Math.round(
        performance.now() - heldRunRestartStartedAt,
      );
      const { stderr: bridgeLogs } = await execFileAsync(
        "docker",
        ["logs", "--tail", "100", uiContainer],
        { env: config.env, signal: abort.signal, maxBuffer: 1024 * 1024 },
      );
      assert.ok(
        bridgeLogs.includes("Bridge drain did not close cleanly"),
        "Held Run must drive Bridge through the forced-drain exit path",
      );
      await until(
        async () => {
          try {
            const current = (
              await memberClient.request("/api/app/workspace/v1/bootstrap")
            ).body.bridgeEpoch;
            return current && current !== beforeRestart;
          } catch {
            return false;
          }
        },
        "new Bridge epoch after normal restart",
        abort.signal,
      );
      await measureDocument("first-after-restart");
      for (let index = 0; index < 12; index++)
        await measureDocument("warm-after-restart");
      const recoveredRun = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${sessionId}/operations/${heldRun.operationId}`,
        )
      ).body;
      assert.equal(recoveredRun.phase, "running");
      assert.equal(recoveredRun.runId, heldRun.runId);
      const reboundView = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
        )
      ).body.selectedView;
      assert.ok(reboundView?.historyToken);
      await memberClient.request(
        `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${sessionId}/prompts`,
        {
          status: 202,
          headers: {
            "Idempotency-Key": heldRun.operationId,
            "If-Match": reboundView.historyToken,
          },
          body: {
            intentId: heldRun.operationId,
            expectedAppendVersion: originalAppendVersion,
            prompt: [{ type: "text", text: "c4-browser-hold-close" }],
          },
        },
      );
      await until(
        async () => {
          const operation = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${sessionId}/operations/${heldRun.operationId}`,
            )
          ).body;
          return (
            operation.phase === "running" && operation.runId === heldRun.runId
          );
        },
        "same intent retry after Bridge restart resolves to original Run",
        abort.signal,
      );
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-close",
        ).length,
        1,
      );
      await assertHeldRunAcrossSessions();
      const gatewayPage = await open();
      await gatewayPage
        .getByRole("button", { name: "Stop operation" })
        .waitFor();
      const composerStatus = gatewayPage
        .getByRole("group", { name: "Message composer" })
        .getByRole("status");
      assert.equal(
        await composerStatus.innerText(),
        "Agent is working. Commands remain available.",
      );
      let gatewaySseRequests = 0;
      gatewayPage.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/events"))
          gatewaySseRequests++;
      });
      const gatewayRestartStartedAt = performance.now();
      await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "restart",
          "edge-gateway",
        ]),
        true,
      );
      metrics.deployment.gatewayHeldRunRestartMs = Math.round(
        performance.now() - gatewayRestartStartedAt,
      );
      await until(
        async () => {
          try {
            return (
              await memberClient.request("/api/app/workspace/v1/bootstrap")
            ).body.bridgeEpoch;
          } catch {
            return null;
          }
        },
        "Gateway recovers while Run is held",
        abort.signal,
      );
      await until(
        () => gatewaySseRequests > 0,
        "browser SSE reconnects after Gateway restart",
        abort.signal,
        30_000,
      );
      assert.ok((await modelState()).pending.includes("c4-browser-hold-close"));
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-close",
        ).length,
        1,
      );
      const release = await fetch(
        `${config.model}/release/c4-browser-hold-close`,
        {
          method: "POST",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        },
      );
      assert.equal(release.status, 200);
      const reopened = gatewayPage;
      await reopened
        .getByText("c4-browser-hold-close completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      await until(
        async () => (await composerStatus.innerText()) === "",
        "composer hint clears after completed Run",
        abort.signal,
        30_000,
      );
      const copyResponse = reopened
        .getByRole("button", { name: "Copy response" })
        .last();
      await copyResponse.click();
      const copyStatus = reopened
        .getByRole("status")
        .filter({ hasText: "Copied" });
      await copyStatus.waitFor();
      assert.equal(
        await copyResponse.evaluate((button) =>
          button.querySelector('[role="status"]'),
        ),
        null,
      );
      assert.equal(
        await reopened.evaluate(() => navigator.clipboard.readText()),
        "c4-browser-hold-close completed",
      );
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-close",
        ).length,
        1,
      );
      const secondPage = await open(secondSession);
      const secondComposer = secondPage.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(
        () => secondComposer.isEnabled(),
        "second Session composer ready",
        abort.signal,
      );
      const slowResponse = await new Promise((resolve, reject) => {
        slowRequest = get(
          `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}/events?sessionId=${secondSession}`,
          { headers: { Cookie: memberClient.cookie } },
          resolve,
        );
        slowRequest.on("error", reject);
      });
      assert.equal(slowResponse.statusCode, 200);
      slowResponse.on("error", () => {});
      slowReader = throttleSse(slowResponse);
      metrics.memory.beforeSlowRunBytes = await containerMemory();
      await secondComposer.fill("c4-browser-hold-offline");
      await secondPage
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await until(
        async () =>
          (await modelState()).pending.includes("c4-browser-hold-offline"),
        "second Session holds a new Run",
        abort.signal,
      );
      metrics.memory.duringSlowRunBytes = await containerMemory();
      const simultaneousView = await until(
        async () => {
          const view = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
            )
          ).body;
          const original = view.operations?.find(
            (operation) =>
              operation.sessionId === sessionId &&
              operation.operationId === heldRun.operationId,
          );
          const current = view.operations?.find(
            (operation) =>
              operation.sessionId === secondSession &&
              operation.phase === "running" &&
              operation.runId,
          );
          return original?.phase === "completed" && current ? view : null;
        },
        "Agent View reconciles completed and running intents across Sessions",
        abort.signal,
      );
      assert.equal(simultaneousView.selectedSessionId, sessionId);
      assert.equal(simultaneousView.activeSessionId, secondSession);
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-offline",
        ).length,
        1,
      );
      const secondRelease = await fetch(
        `${config.model}/release/c4-browser-hold-offline`,
        {
          method: "POST",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        },
      );
      assert.equal(secondRelease.status, 200);
      await secondPage
        .getByText("c4-browser-hold-offline completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      metrics.memory.afterSlowRunBytes = await containerMemory();
      const browserHeapSession = await context.newCDPSession(secondPage);
      await browserHeapSession.send("HeapProfiler.collectGarbage");
      metrics.browser.heap = {
        baselineAfterGcBytes: await browserHeapBytes(secondPage),
        samplesBytes: [],
        afterGcBytes: null,
      };
      const submitAndWait = async (targetSessionId, phase) => {
        const current = await until(
          async () => {
            const view = (
              await memberClient.request(
                `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${targetSessionId}`,
              )
            ).body;
            return view.availability === "ready" ? view.selectedView : null;
          },
          `${phase} ready`,
          abort.signal,
        );
        const intentId = randomUUID();
        const path = `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${targetSessionId}/prompts`;
        const body = {
          intentId,
          expectedAppendVersion: current.appendVersion,
          prompt: [{ type: "text", text: phase }],
        };
        const headers = {
          "Idempotency-Key": intentId,
          "If-Match": current.historyToken,
        };
        if (phase === "c4-browser-volume-00") {
          const submit = async () => {
            const response = await fetch(`${config.gateway}${path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Cookie: memberClient.cookie,
                Origin: config.gateway,
                "X-Antnest-CSRF-Token":
                  memberClient.cookies.get("antnest_csrf") ?? "",
                ...headers,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(15_000),
              ]),
            });
            return { status: response.status, body: await response.json() };
          };
          const replies = await Promise.all([submit(), submit()]);
          assert.ok(
            replies.some((reply) => reply.status === 202),
            `One concurrent submission must be accepted: ${JSON.stringify(replies)}`,
          );
          for (const reply of replies) {
            if (reply.status === 202)
              assert.equal(reply.body.operationId, intentId);
            else if (reply.status === 503) {
              assert.equal(reply.body.code, "upstream_unavailable");
              assert.equal(reply.body.recovery, "retry_read");
            } else {
              assert.equal(reply.status, 409);
              assert.equal(reply.body.code, "stale_history");
            }
          }
        } else {
          await memberClient.request(path, { status: 202, headers, body });
        }
        await until(
          async () => {
            const operation = (
              await memberClient.request(
                `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${targetSessionId}/operations/${intentId}`,
              )
            ).body;
            return operation.phase === "completed" ? operation : null;
          },
          `${phase} completed`,
          abort.signal,
        );
      };
      const volumeBatch = async (
        volumeSessionId,
        from,
        count = 20,
        targetSession = () => volumeSessionId,
      ) => {
        const memoryBytes = [await containerMemory()];
        const heapBefore = heapDiagnostics ? await heapMemory() : null;
        for (let index = from; index < from + count; index++) {
          const phase = `c4-browser-volume-${String(index).padStart(2, "0")}`;
          await submitAndWait(targetSession(index), phase);
          if ((index - from + 1) % 4 === 0) {
            memoryBytes.push(await containerMemory());
            if (volumeSessionId === secondSession) {
              await secondPage.getByText(phase, { exact: true }).waitFor();
              metrics.browser.heap.samplesBytes.push(
                await browserHeapBytes(secondPage),
              );
            }
          }
        }
        return {
          from,
          count,
          memoryBytes,
          heapBefore,
          heapAfter: heapDiagnostics ? await heapMemory() : null,
        };
      };
      metrics.memory.volumeBatches = [
        {
          sessionId: secondSession,
          ...(await volumeBatch(secondSession, 0)),
        },
      ];
      metrics.memory.volumeBatches[0].slowReaderBytes = slowReader.bytes();
      assert.ok(
        metrics.memory.volumeBatches[0].slowReaderBytes > 0,
        "The throttled Gateway SSE observer must receive real Run output",
      );
      slowReader.stop();
      slowReader = undefined;
      slowRequest.destroy();
      metrics.memory.volumeBatches[0].afterDisconnectBytes =
        await containerMemory();
      await delay(10_000, undefined, { signal: abort.signal });
      metrics.memory.volumeBatches[0].afterIdleBytes = await containerMemory();
      metrics.memory.volumeBatches[0].heapAfterIdle = heapDiagnostics
        ? await heapMemory()
        : null;
      const thirdSession = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          {
            status: 201,
            body: {},
          },
        )
      ).body.sessionId;
      assert.ok(thirdSession);
      const thirdSlowResponse = await new Promise((resolve, reject) => {
        slowRequest = get(
          `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}/events?sessionId=${thirdSession}`,
          { headers: { Cookie: memberClient.cookie } },
          resolve,
        );
        slowRequest.on("error", reject);
      });
      assert.equal(thirdSlowResponse.statusCode, 200);
      thirdSlowResponse.on("error", () => {});
      slowReader = throttleSse(thirdSlowResponse);
      const secondThirdSlowResponse = await new Promise((resolve, reject) => {
        secondSlowRequest = get(
          `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}/events?sessionId=${secondSession}`,
          { headers: { Cookie: memberClient.cookie } },
          resolve,
        );
        secondSlowRequest.on("error", reject);
      });
      assert.equal(secondThirdSlowResponse.statusCode, 200);
      secondThirdSlowResponse.on("error", () => {});
      secondSlowReader = throttleSse(secondThirdSlowResponse);
      metrics.memory.volumeBatches.push({
        sessionIds: [secondSession, thirdSession],
        ...(await volumeBatch(thirdSession, 20, 60, (index) =>
          index % 5 === 0 ? secondSession : thirdSession,
        )),
      });
      const volumeRequests = (await modelState()).requests.filter((row) =>
        row.phase.startsWith("c4-browser-volume-"),
      );
      assert.equal(volumeRequests.length, 80);
      for (let index = 0; index < 80; index++) {
        const phase = `c4-browser-volume-${String(index).padStart(2, "0")}`;
        assert.equal(
          volumeRequests.filter((row) => row.phase === phase).length,
          1,
          `${phase} must execute exactly once`,
        );
      }
      metrics.memory.volumeBatches[1].slowReaderBytes = slowReader.bytes();
      metrics.memory.volumeBatches[1].secondSlowReaderBytes =
        secondSlowReader.bytes();
      assert.ok(
        metrics.memory.volumeBatches[1].slowReaderBytes > 0,
        "The second throttled Gateway SSE observer must receive real Run output",
      );
      assert.ok(
        metrics.memory.volumeBatches[1].secondSlowReaderBytes > 0,
        "Another concurrent throttled Gateway SSE observer must receive real Run output",
      );
      slowReader.stop();
      slowReader = undefined;
      slowRequest.destroy();
      secondSlowReader.stop();
      secondSlowReader = undefined;
      secondSlowRequest.destroy();
      metrics.memory.volumeBatches[1].afterDisconnectBytes =
        await containerMemory();
      await delay(10_000, undefined, { signal: abort.signal });
      metrics.memory.volumeBatches[1].afterIdleBytes = await containerMemory();
      metrics.memory.volumeBatches[1].heapAfterIdle = heapDiagnostics
        ? await heapMemory()
        : null;
      for (let index = 0; index < 20; index++) {
        const phase = `c4-browser-window-${String(index).padStart(2, "0")}`;
        await submitAndWait(secondSession, phase);
        if ((index + 1) % 4 === 0) {
          await secondPage.getByText(phase, { exact: true }).waitFor();
          metrics.browser.heap.samplesBytes.push(
            await browserHeapBytes(secondPage),
          );
        }
      }
      await browserHeapSession.send("HeapProfiler.collectGarbage");
      metrics.browser.heap.afterGcBytes = await browserHeapBytes(secondPage);
      await browserHeapSession.detach();
      await secondPage.close();
      metrics.memory.afterShortHistoryBytes = await containerMemory();
      metrics.memory.heapAfterShortHistory = heapDiagnostics
        ? await heapMemory()
        : null;
      const recentLongHistory = (
        await memberClient.request(otherSessionViewPath)
      ).body.selectedView;
      assert.ok(recentLongHistory?.olderTurnsCursor);
      const olderLongHistory = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${secondSession}/turns?${new URLSearchParams(
            {
              cursor: recentLongHistory.olderTurnsCursor,
            },
          )}`,
        )
      ).body;
      const olderPrompts = olderLongHistory.items.map(
        (turn) => turn.prompt?.map((block) => block.text ?? "").join("") ?? "",
      );
      assert.ok(
        olderPrompts.includes("c4-browser-volume-12"),
        `First older page prompts: ${JSON.stringify(olderPrompts)}`,
      );
      const longHistoryPage = await open(secondSession);
      await longHistoryPage
        .getByText("c4-browser-window-19 completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      const firstOlderResponse = longHistoryPage.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname.endsWith(
            `/sessions/${secondSession}/turns`,
          ),
      );
      await longHistoryPage
        .getByRole("button", { name: "Load earlier messages" })
        .click();
      const firstBrowserPage = await firstOlderResponse;
      assert.equal(firstBrowserPage.status(), 200);
      const firstBrowserPageBody = await firstBrowserPage.json();
      const historyEvidence = `${root}/artifacts/verification/agent-ui-fullstack-20260923`;
      await mkdir(historyEvidence, { recursive: true });
      await writeFile(
        `${historyEvidence}/long-history-page-input.json`,
        JSON.stringify({
          recentView: recentLongHistory,
          olderPage: firstBrowserPageBody,
        }) + "\n",
      );
      const returnedPrompts = firstBrowserPageBody.items.map(
        (turn) => turn.prompt?.map((block) => block.text ?? "").join("") ?? "",
      );
      await delay(1000, undefined, { signal: abort.signal });
      const visibleOlderPrompts = await longHistoryPage
        .locator(".conversation-turn .message-user .message-content")
        .allTextContents();
      const paginationAlerts = await longHistoryPage
        .getByRole("alert")
        .allTextContents();
      const paginationButtons = await longHistoryPage
        .locator(".load-older-turns")
        .allTextContents();
      assert.ok(
        visibleOlderPrompts.some((item) =>
          item.includes("c4-browser-volume-12"),
        ),
        `Older page: ${JSON.stringify({
          returnedPrompts,
          visiblePrompts: visibleOlderPrompts.map((item) => item.slice(0, 40)),
          paginationAlerts,
          paginationButtons,
        })}`,
      );
      await longHistoryPage
        .getByRole("button", { name: "Load earlier messages" })
        .click();
      await longHistoryPage
        .locator(".conversation-turn .message-user .message-content")
        .getByText("c4-browser-volume-00", { exact: true })
        .waitFor({ timeout: 120_000 });
      await longHistoryPage
        .locator(".conversation-turn .message-user .message-content")
        .getByText("c4-browser-hold-offline", { exact: true })
        .waitFor({ timeout: 120_000 });
      assert.ok(
        (await longHistoryPage.locator(".conversation-turn").count()) <= 40,
      );
      await longHistoryPage.waitForFunction(() =>
        document.activeElement?.classList.contains("thread-scroll"),
      );
      const newerResponse = longHistoryPage.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname.endsWith(
            `/sessions/${secondSession}/turns`,
          ),
      );
      await longHistoryPage
        .getByRole("button", { name: "Load newer messages" })
        .click();
      assert.equal((await newerResponse).status(), 200);
      await longHistoryPage
        .getByText("c4-browser-volume-12", { exact: true })
        .waitFor({ timeout: 120_000 });
      assert.ok(
        (await longHistoryPage.locator(".conversation-turn").count()) <= 40,
      );
      await longHistoryPage.waitForFunction(() =>
        document.activeElement?.classList.contains("thread-scroll"),
      );
      await longHistoryPage
        .getByRole("button", { name: "Latest messages" })
        .click();
      await longHistoryPage
        .getByText("c4-browser-window-19 completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      assert.ok(
        (await longHistoryPage.locator(".conversation-turn").count()) <= 40,
      );
      await longHistoryPage.waitForFunction(() =>
        document.activeElement?.classList.contains("thread-scroll"),
      );
      metrics.memory.afterHistoricalPagesBytes = await containerMemory();
      metrics.memory.heapAfterHistoricalPages = heapDiagnostics
        ? await heapMemory()
        : null;
      await longHistoryPage.close();
      const unsupportedSessionId = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          { status: 201, body: {} },
        )
      ).body.sessionId;
      const unsupportedPage = await open(unsupportedSessionId);
      const unsupportedComposer = unsupportedPage.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(
        () => unsupportedComposer.isEnabled(),
        "unsupported-content composer ready",
        abort.signal,
      );
      await unsupportedPage
        .getByLabel("File attachments", { exact: true })
        .setInputFiles({
          name: "discard.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("discard"),
        });
      await unsupportedPage
        .getByRole("button", { name: "Remove discard.txt" })
        .press("Enter");
      assert.equal(
        await unsupportedPage.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Message",
      );
      await unsupportedPage
        .getByLabel("File attachments", { exact: true })
        .setInputFiles({
          name: "unsupported.wav",
          mimeType: "audio/wav",
          buffer: Buffer.from(audioData, "base64"),
        });
      await unsupportedComposer.fill("c4-browser-unsupported-audio");
      await unsupportedComposer.press("Enter");
      const rejectedOperation = await until(
        async () => {
          const view = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${unsupportedSessionId}`,
            )
          ).body;
          return view.operations?.find(
            (operation) =>
              operation.sessionId === unsupportedSessionId &&
              operation.phase === "failed" &&
              operation.runId,
          );
        },
        "unsupported audio has a durable failed receipt",
        abort.signal,
      );
      assert.equal(rejectedOperation.errorClass, "model_unsupported_content");
      const unsupportedAlert = unsupportedPage.getByRole("alert").filter({
        hasText: "The selected model does not support this attachment type.",
      });
      await unsupportedAlert.waitFor({ timeout: 120_000 });
      assert.equal(await unsupportedComposer.isEnabled(), true);
      assert.equal(
        await unsupportedPage.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Message",
      );
      assert.equal(
        (await modelState()).requests.some(
          (request) => request.phase === "c4-browser-unsupported-audio",
        ),
        false,
      );
      await unsupportedPage.reload();
      await unsupportedAlert.waitFor({ timeout: 120_000 });
      assert.equal(await unsupportedComposer.isEnabled(), true);
      await unsupportedPage.close();
      const reopenedComposer = reopened.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(
        () => reopenedComposer.isEnabled(),
        "composer ready after Bridge restart",
        abort.signal,
      );
      await reopenedComposer.fill("c4-browser-hold-cancel");
      await reopened
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await until(
        async () =>
          (await modelState()).pending.includes("c4-browser-hold-cancel"),
        "model holds cancellable Run",
        abort.signal,
      );
      const viewPath = `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`;
      const oldOperation = await until(
        async () => {
          const view = (await memberClient.request(viewPath)).body;
          return view.operations?.find(
            (row) =>
              row.sessionId === sessionId &&
              row.phase === "running" &&
              row.runId,
          );
        },
        "old Run accepted by ACP",
        abort.signal,
      );
      let stopPosts = 0;
      let stopReads = 0;
      reopened.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path.endsWith(`/operations/${oldOperation.operationId}/cancel`) &&
          request.method() === "POST"
        )
          stopPosts++;
        if (
          path.endsWith(`/operations/${oldOperation.operationId}`) &&
          request.method() === "GET"
        )
          stopReads++;
      });
      await reopened.evaluate(() => {
        window.__antnestE2EFailures.cancel = true;
      });
      await reopened
        .getByRole("button", { name: "Stop operation", exact: true })
        .click();
      await until(
        async () =>
          (await modelState()).requests.some(
            (row) => row.phase === "c4-browser-hold-cancel" && row.disconnected,
          ),
        "model request disconnected by Stop",
        abort.signal,
      );
      await until(
        () => stopReads > 0,
        "lost Stop response queries the original operation",
        abort.signal,
      );
      assert.equal(
        await reopened.evaluate(
          () => window.__antnestE2EFailures.cancelDropped,
        ),
        1,
      );
      assert.equal(
        stopPosts,
        1,
        "Lost Stop response must not resend the cancellation",
      );
      await until(
        () => reopenedComposer.isEnabled(),
        "composer ready after Stop",
        abort.signal,
      );
      await reopenedComposer.fill("c4-browser-after-cancel");
      await reopened
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await reopened
        .getByText("c4-browser-after-cancel completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      await until(
        () => reopenedComposer.isEnabled(),
        "composer ready for new held Run",
        abort.signal,
      );
      await reopenedComposer.fill("c4-browser-hold-after-cancel");
      await reopened
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await until(
        async () =>
          (await modelState()).pending.includes("c4-browser-hold-after-cancel"),
        "model holds successor Run",
        abort.signal,
      );
      const successorOperation = await until(
        async () => {
          const view = (await memberClient.request(viewPath)).body;
          return view.operations?.find(
            (row) =>
              row.sessionId === sessionId &&
              row.phase === "running" &&
              row.runId &&
              row.runId !== oldOperation.runId,
          );
        },
        "successor Run has a durable receipt before Bridge crash",
        abort.signal,
      );
      await memberClient.request(
        `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${sessionId}/operations/${oldOperation.operationId}/cancel`,
        { status: 409, body: { expectedRunId: oldOperation.runId } },
      );
      assert.ok(
        (await modelState()).pending.includes("c4-browser-hold-after-cancel"),
      );
      const beforeCrash = (
        await memberClient.request("/api/app/workspace/v1/bootstrap")
      ).body.bridgeEpoch;
      await docker(["kill", "--signal=SIGKILL", uiContainer], true);
      assert.equal(
        (
          await docker(["inspect", "-f", "{{.State.Running}}", uiContainer])
        ).trim(),
        "false",
      );
      const successorRelease = await fetch(
        `${config.model}/release/c4-browser-hold-after-cancel`,
        {
          method: "POST",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        },
      );
      assert.equal(successorRelease.status, 200);
      await until(
        async () =>
          !(await modelState()).pending.includes(
            "c4-browser-hold-after-cancel",
          ),
        "successor model request completes while Bridge is offline",
        abort.signal,
      );
      await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "180",
          "--no-build",
          "agent-ui",
        ]),
        true,
      );
      await until(
        async () => {
          try {
            const current = (
              await memberClient.request("/api/app/workspace/v1/bootstrap")
            ).body.bridgeEpoch;
            return current && current !== beforeCrash;
          } catch {
            return false;
          }
        },
        "new Bridge epoch after abrupt process exit",
        abort.signal,
      );
      const recoveredSuccessor = await until(
        async () => {
          const operation = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${sessionId}/operations/${successorOperation.operationId}`,
            )
          ).body;
          return operation.phase === "completed" ? operation : null;
        },
        "Bridge reads a Run completed while it was offline",
        abort.signal,
      );
      assert.equal(recoveredSuccessor.runId, successorOperation.runId);
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-after-cancel",
        ).length,
        1,
      );
      await reopened
        .getByText("c4-browser-hold-after-cancel completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      await until(
        () => reopenedComposer.isEnabled(),
        "composer ready for tool setup",
        abort.signal,
      );
      await reopenedComposer.fill("c4-browser-write");
      await reopened
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await reopened
        .getByText("Workspace note saved.", { exact: true })
        .waitFor({ timeout: 120_000 });
      await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "--profile",
          "ui-peer",
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "60",
          "--no-deps",
          "--no-build",
          "agent-ui-peer",
        ]),
        true,
      );
      const peerAddress = (
        await docker(
          composeArgs(config.project, [
            "-f",
            "tests/e2e/workspace-closeout/c4.compose.yaml",
            "-f",
            "tests/e2e/agent-ui/fullstack.compose.yaml",
            "port",
            "agent-ui-peer",
            "8080",
          ]),
        )
      ).trim();
      assert.match(peerAddress, /^127\.0\.0\.1:\d+$/u);
      const peerOrigin = `http://${peerAddress}`;
      const principal = (await memberClient.request("/api/session")).body
        .principal;
      const peerHeaders = {
        "x-antnest-organization-id": principal.organization_id,
        "x-antnest-principal-id": principal.user_id,
        "x-antnest-agent-id": fixture.agentID,
      };
      const raceSessionId = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`,
          { status: 201, body: {} },
        )
      ).body.sessionId;
      assert.ok(raceSessionId);
      const sessionPath = `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${raceSessionId}`;
      const peerView = async () => {
        const response = await fetch(`${peerOrigin}${sessionPath}/view`, {
          headers: peerHeaders,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const [primaryBefore, peerBefore] = await Promise.all([
        memberClient.request(`${sessionPath}/view`).then(({ body }) => body),
        peerView(),
      ]);
      assert.equal(primaryBefore.historyState, "ready");
      assert.equal(peerBefore.historyState, "ready");
      assert.ok(
        primaryBefore.configurationToken && peerBefore.configurationToken,
      );
      const postConfiguration = async (origin, headers, value, token) => {
        const response = await fetch(`${origin}${sessionPath}/configuration`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            configId: "mode",
            value,
            expectedConfigurationToken: token,
          }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        return { status: response.status, body: await response.json() };
      };
      const contenders = await Promise.all([
        postConfiguration(
          config.gateway,
          {
            Cookie: memberClient.cookie,
            Origin: config.gateway,
            "X-Antnest-CSRF-Token":
              memberClient.cookies.get("antnest_csrf") ?? "",
          },
          "auto",
          primaryBefore.configurationToken,
        ),
        postConfiguration(
          peerOrigin,
          peerHeaders,
          "chat",
          peerBefore.configurationToken,
        ),
      ]);
      const successfulIndex = contenders.findIndex(
        ({ status }) => status === 200,
      );
      assert.ok(
        successfulIndex === 0 || successfulIndex === 1,
        JSON.stringify(contenders),
      );
      assert.equal(contenders.filter(({ status }) => status === 200).length, 1);
      assert.equal(contenders[1 - successfulIndex].status, 409);
      assert.equal(
        contenders[1 - successfulIndex].body.code,
        "configuration_conflict",
      );
      const chosenMode = successfulIndex === 0 ? "auto" : "chat";
      let observedModes;
      try {
        await until(
          async () => {
            const [primary, peer] = await Promise.all([
              memberClient
                .request(`${sessionPath}/view`)
                .then(({ body }) => body),
              peerView(),
            ]);
            observedModes = [primary, peer].map(
              (view) =>
                view.configOptions?.find((option) => option.id === "mode")
                  ?.currentValue,
            );
            return observedModes.every((value) => value === chosenMode);
          },
          "both Node Bridge owners converge on the winning configuration",
          abort.signal,
          20_000,
        );
      } catch (error) {
        throw new Error(
          `Bridge configuration views did not converge: ${JSON.stringify({
            chosenMode,
            observedModes,
            statuses: contenders.map(({ status }) => status),
          })}`,
          { cause: error },
        );
      }
      const modePicker = reopened.getByRole("combobox", {
        name: "Mode",
        exact: true,
      });
      await until(
        () => modePicker.isEnabled(),
        "Mode picker ready after tool write",
        abort.signal,
      );
      assert.match(
        await modePicker.evaluate((element) => {
          const id = element.getAttribute("aria-describedby");
          return id ? (document.getElementById(id)?.textContent ?? "") : "";
        }),
        /Current value: \S/u,
        "The current Mode choice must be available to assistive technology",
      );
      await modePicker.press("ArrowDown");
      await reopened.getByRole("listbox", { name: "Mode" }).waitFor();
      await reopened.keyboard.press("Escape");
      assert.equal(
        await modePicker.evaluate(
          (element) => element === document.activeElement,
        ),
        true,
        "Escape must return focus to the Mode picker",
      );
      let configurationPosts = 0;
      reopened.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/configuration")
        )
          configurationPosts++;
      });
      await reopened.evaluate(() => {
        window.__antnestE2EFailures.configuration = true;
      });
      await modePicker.press("ArrowDown");
      await reopened.getByRole("option", { name: /^Approve\b/ }).press("Enter");
      await until(
        async () =>
          /Current value: Approve\b/u.test(
            await modePicker.evaluate((element) => {
              const id = element.getAttribute("aria-describedby");
              return id ? (document.getElementById(id)?.textContent ?? "") : "";
            }),
          ),
        "lost configuration response reconciles the authoritative Mode",
        abort.signal,
      );
      assert.equal(
        await modePicker.evaluate(
          (element) => element === document.activeElement,
        ),
        true,
        "A completed configuration must return keyboard focus to its Mode picker",
      );
      assert.equal(
        configurationPosts,
        1,
        "A lost configuration response must not resubmit the old choice",
      );
      assert.equal(
        await reopened.evaluate(
          () => window.__antnestE2EFailures.configurationDropped,
        ),
        1,
      );
      await until(
        () => reopenedComposer.isEnabled(),
        "composer ready for approval",
        abort.signal,
      );
      await reopenedComposer.fill("c4-browser-approve");
      await reopened
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await reopened
        .getByRole("region", { name: "Tool approval" })
        .waitFor({ timeout: 120_000 });
      const beforePermissionRestart = (
        await memberClient.request("/api/app/workspace/v1/bootstrap")
      ).body.bridgeEpoch;
      await reopened.close();
      const permissionRestartStartedAt = performance.now();
      await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "restart",
          "agent-ui",
        ]),
        true,
      );
      metrics.deployment.pendingPermissionRestartMs = Math.round(
        performance.now() - permissionRestartStartedAt,
      );
      await until(
        async () => {
          try {
            const current = (
              await memberClient.request("/api/app/workspace/v1/bootstrap")
            ).body.bridgeEpoch;
            return current && current !== beforePermissionRestart;
          } catch {
            return false;
          }
        },
        "new Bridge epoch with pending permission",
        abort.signal,
      );
      const approvalPage = await open();
      const approvalRegion = approvalPage.getByRole("region", {
        name: "Tool approval",
        description: /Conversation: .+/u,
      });
      await approvalRegion.waitFor({ timeout: 120_000 });
      const permissionInbox = approvalPage.locator(".permission-requests");
      assert.equal(await permissionInbox.getAttribute("aria-live"), null);
      const permissionAnnouncement = await approvalPage
        .getByRole("status")
        .filter({ hasText: /tool approval/u })
        .textContent();
      assert.match(
        permissionAnnouncement ?? "",
        /^1 tool approval requires a decision\. Most recent: .+ in .+\.$/u,
      );
      assert.ok(
        (permissionAnnouncement?.length ?? 0) < 200,
        "The pending tool announcement must remain concise",
      );
      await assertWcagPage(approvalPage);
      const allowOnce = approvalRegion.getByRole("button", {
        name: "Allow once",
        exact: true,
        description: /Conversation: .+/u,
      });
      let permissionPosts = 0;
      let permissionReads = 0;
      approvalPage.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === "POST" && path.endsWith("/decision"))
          permissionPosts++;
        if (
          request.method() === "GET" &&
          path.endsWith(`/agents/${fixture.agentID}/view`)
        )
          permissionReads++;
      });
      await approvalPage.evaluate(() => {
        window.__antnestE2EFailures.permission = true;
      });
      await allowOnce.focus();
      assert.equal(
        await allowOnce.evaluate(
          (element) => element === document.activeElement,
        ),
        true,
      );
      await approvalPage.keyboard.press("Enter");
      await approvalPage
        .getByText("c4-browser-approve: retained note alpha-beta verified.", {
          exact: true,
        })
        .waitFor({ timeout: 120_000 });
      await until(
        () => permissionReads > 0,
        "lost permission response rereads the Agent View",
        abort.signal,
      );
      assert.equal(permissionPosts, 1);
      assert.equal(
        await approvalPage.evaluate(
          () => window.__antnestE2EFailures.permissionDropped,
        ),
        1,
      );
      await approvalPage
        .getByRole("region", { name: "Tool approval" })
        .waitFor({ state: "hidden" });
      assert.equal(
        await approvalPage
          .getByRole("region", { name: "Conversation messages" })
          .evaluate((region) => region === document.activeElement),
        true,
        "Resolving the focused approval must return focus to conversation messages",
      );
      metrics.memory.afterPermissionRestartBytes = await containerMemory();
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-approve" && row.stage === "tool",
        ).length,
        1,
      );
      const operationQueries = [];
      approvalPage.on("request", (request) => {
        if (
          request.method() === "GET" &&
          /\/operations\/[^/]+$/.test(new URL(request.url()).pathname)
        )
          operationQueries.push(request.url());
      });
      let admittedBeforeTimeout = false;
      let interceptedPrompts = 0;
      await approvalPage.route(/\/prompts$/, async (route) => {
        interceptedPrompts++;
        const response = await route.fetch();
        assert.equal(response.status(), 202);
        admittedBeforeTimeout = true;
        await new Promise((resolve) => setTimeout(resolve, 32_000));
        await route.fulfill({ response }).catch(() => {});
      });
      const timeoutComposer = approvalPage.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(
        () => timeoutComposer.isEnabled(),
        "composer ready for delayed receipt",
        abort.signal,
      );
      await timeoutComposer.fill("c4-browser-timeout");
      await approvalPage
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await approvalPage
        .getByText("c4-browser-timeout completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      await until(
        () => operationQueries.length > 0,
        "timed-out Prompt queries original operation",
        abort.signal,
        60_000,
      );
      await until(
        () => timeoutComposer.isEnabled(),
        "composer ready after timeout reconciliation",
        abort.signal,
      );
      assert.equal(admittedBeforeTimeout, true);
      assert.equal(interceptedPrompts, 1);
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-timeout",
        ).length,
        1,
      );
      await approvalPage.unroute(/\/prompts$/);
      metrics.memory.afterRunsBytes = await containerMemory();
      await approvalPage.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await approvalPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await assertReadableText(approvalPage, [
        ".message-content",
        ".composer-hint",
      ]);
      await assertTouchTargets(
        approvalPage,
        '.send-button, button[aria-label="Open navigation"]',
      );
      await approvalPage.locator(".skip-link").focus();
      await approvalPage.keyboard.press("Enter");
      assert.equal(
        await approvalPage.evaluate(() => document.activeElement?.id),
        "conversation-main",
      );
      await approvalPage
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await approvalPage
        .getByRole("dialog", { name: "Workspace navigation" })
        .waitFor();
      await assertWcagPage(approvalPage);
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let step = 0; step < 12; step++) {
          await approvalPage.keyboard.press(key);
          assert.equal(
            await approvalPage
              .getByRole("dialog", { name: "Workspace navigation" })
              .evaluate((dialog) => dialog.contains(document.activeElement)),
            true,
            `Gateway workspace navigation must retain ${key} focus`,
          );
        }
      }
      await approvalPage.keyboard.press("Escape");
      await approvalPage
        .getByRole("dialog", { name: "Workspace navigation" })
        .waitFor({ state: "hidden" });
      const peerAgent = await fixture.json("/api/admin/agents", {
        status: 202,
        body: {
          owner_user_id: fixture.ownerID,
          name: "C4 Peer Agent",
          template_id: fixture.template.template_id,
          template_revision: fixture.template.revision,
        },
      });
      const peerAgentId = peerAgent.agent.agent_id;
      await fixture.operation(peerAgent.operation.request_id);
      await waitForAgentReady(
        () => fixture.json(`/api/admin/agents/${peerAgentId}`),
        abort.signal,
      );
      const peerSessionId = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${peerAgentId}/sessions`,
          { status: 201, body: {} },
        )
      ).body.sessionId;
      const mobileAgentPage = await open();
      await mobileAgentPage.setViewportSize({ width: 390, height: 844 });
      const mobileNavigationButton = mobileAgentPage.getByRole("button", {
        name: "Open navigation",
        exact: true,
      });
      await mobileNavigationButton.focus();
      await mobileAgentPage.keyboard.press("Enter");
      await mobileAgentPage
        .getByRole("dialog", { name: "Workspace navigation" })
        .locator(".workspace-switcher")
        .click();
      await mobileAgentPage
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("button", { name: /C4 Peer Agent/ })
        .focus();
      await mobileAgentPage.keyboard.press("Enter");
      await mobileAgentPage
        .getByRole("heading", { name: "C4 Peer Agent", exact: true })
        .waitFor();
      await until(
        () =>
          mobileAgentPage.evaluate(
            () => document.activeElement?.id === "conversation-main",
          ),
        "Mobile Agent selection focuses the new workspace after dialog close",
        abort.signal,
      );
      await mobileNavigationButton.focus();
      await mobileAgentPage.keyboard.press("Enter");
      await mobileAgentPage
        .getByRole("dialog", { name: "Workspace navigation" })
        .locator(".workspace-switcher")
        .click();
      await mobileAgentPage
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("button", { name: "All workspaces" })
        .focus();
      await mobileAgentPage.keyboard.press("Enter");
      const agentSearch = mobileAgentPage.getByRole("searchbox", {
        name: "Find a workspace",
      });
      await agentSearch.waitFor();
      await until(
        () =>
          agentSearch.evaluate((search) => search === document.activeElement),
        "Mobile Agent directory focuses search after dialog close",
        abort.signal,
      );
      await mobileAgentPage.close();
      const crossAgentPage = await open();
      const crossAgentComposer = crossAgentPage.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(
        () => crossAgentComposer.isEnabled(),
        "original Agent composer ready for cross-Agent navigation",
        abort.signal,
      );
      await crossAgentComposer.fill("Original Agent private draft");
      await crossAgentPage
        .getByRole("complementary", { name: "Workspace navigation" })
        .locator(".workspace-switcher")
        .click();
      await crossAgentPage
        .getByRole("complementary", { name: "Workspace navigation" })
        .getByRole("button", { name: /C4 Peer Agent/ })
        .click();
      await until(
        () => workspaceLocation(crossAgentPage.url()).agentId === peerAgentId,
        "peer Agent selected",
        abort.signal,
      );
      await crossAgentPage.locator(".conversation-option").first().click();
      await until(
        () =>
          workspaceLocation(crossAgentPage.url()).sessionId === peerSessionId,
        "peer Agent Session selected",
        abort.signal,
      );
      await until(
        () => crossAgentComposer.isEnabled(),
        "peer Agent composer ready",
        abort.signal,
      );
      assert.equal(await crossAgentComposer.inputValue(), "");
      await crossAgentComposer.fill("c4-browser-hold-peer");
      await crossAgentPage.goBack();
      await crossAgentPage.goBack();
      await until(
        () => workspaceLocation(crossAgentPage.url()).sessionId === sessionId,
        "browser history restored original Agent Session",
        abort.signal,
      );
      await until(
        async () =>
          (await crossAgentComposer.inputValue()) ===
          "Original Agent private draft",
        "original Agent draft restored",
        abort.signal,
      );
      await crossAgentPage.goForward();
      await crossAgentPage.goForward();
      await until(
        () =>
          workspaceLocation(crossAgentPage.url()).sessionId === peerSessionId,
        "browser history restored peer Agent Session",
        abort.signal,
      );
      await until(
        async () =>
          (await crossAgentComposer.inputValue()) === "c4-browser-hold-peer",
        "peer Agent draft restored",
        abort.signal,
      );
      await crossAgentPage
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await until(
        async () =>
          (await modelState()).pending.includes("c4-browser-hold-peer"),
        "peer Agent Run accepted and model held",
        abort.signal,
      );
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-peer",
        ).length,
        1,
      );
      const peerHeldOperation = await until(
        async () => {
          const view = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${peerAgentId}/view?sessionId=${peerSessionId}`,
            )
          ).body;
          return view.operations?.find(
            (row) =>
              row.sessionId === peerSessionId &&
              row.phase === "running" &&
              row.runId,
          );
        },
        "peer Agent Run has durable receipt",
        abort.signal,
      );
      const originalAgentView = (
        await memberClient.request(
          `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
        )
      ).body;
      assert.equal(
        JSON.stringify(originalAgentView).includes("c4-browser-hold-peer"),
        false,
      );
      await crossAgentPage.goBack();
      await crossAgentPage.goBack();
      await until(
        () => workspaceLocation(crossAgentPage.url()).sessionId === sessionId,
        "original Agent Session restored while peer Run is held",
        abort.signal,
      );
      await until(
        async () =>
          (await crossAgentComposer.inputValue()) ===
          "Original Agent private draft",
        "original Agent draft retained while peer Run is held",
        abort.signal,
      );
      await crossAgentPage.goForward();
      await crossAgentPage.goForward();
      await crossAgentPage
        .getByRole("region", { name: "Conversation messages" })
        .getByText("c4-browser-hold-peer", { exact: true })
        .waitFor({ timeout: 120_000 });
      const logoutClient = new GatewayClient(config.gateway);
      await logoutClient.request("/api/session/login", { body: member });
      const logoutContext = await browser.newContext();
      await logoutContext.addCookies(
        [...logoutClient.cookies].map(([name, value]) => ({
          name,
          value,
          url: config.gateway,
        })),
      );
      const logoutPage = await logoutContext.newPage();
      await logoutPage.goto(
        `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      const logoutComposer = logoutPage.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(
        () => logoutComposer.isEnabled(),
        "logout Session composer ready",
        abort.signal,
      );
      await logoutComposer.fill("c4-browser-hold-logout");
      await logoutPage
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await until(
        async () =>
          (await modelState()).pending.includes("c4-browser-hold-logout"),
        "logout Run accepted and model held",
        abort.signal,
      );
      const logoutOperation = await until(
        async () => {
          const view = (
            await logoutClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`,
            )
          ).body;
          return view.operations?.find(
            (row) =>
              row.sessionId === sessionId &&
              row.phase === "running" &&
              row.runId,
          );
        },
        "logout Run has durable receipt",
        abort.signal,
      );
      const peerClient = new GatewayClient(config.gateway);
      await peerClient.request("/api/session/login", { body: member });
      assert.notEqual(
        peerClient.cookies.get("antnest_session"),
        logoutClient.cookies.get("antnest_session"),
        "Peer observer must use an independent browser session",
      );
      const peerContext = await browser.newContext();
      await peerContext.addCookies(
        [...peerClient.cookies].map(([name, value]) => ({
          name,
          value,
          url: config.gateway,
        })),
      );
      const peerPage = await peerContext.newPage();
      await peerPage.goto(
        `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      await peerPage
        .getByText("c4-browser-hold-logout", { exact: true })
        .waitFor({ timeout: 120_000 });
      await logoutClient.request("/api/session", {
        method: "DELETE",
        status: 204,
      });
      await logoutPage
        .getByRole("button", { name: "Sign in", exact: true })
        .waitFor({ timeout: 120_000 });
      assert.equal(
        new URL(logoutPage.url()).searchParams.get("return_to"),
        `/workspace/${encodeURIComponent(fixture.agentID)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      assert.equal(await logoutPage.locator(".message-content").count(), 0);
      assert.equal(
        await peerPage
          .getByText("c4-browser-hold-logout", { exact: true })
          .count(),
        1,
        "Signing out one browser must not erase another authorized observer",
      );
      assert.ok(
        (await modelState()).pending.includes("c4-browser-hold-logout"),
        "Revoking the browser session must not cancel the accepted Run",
      );
      assert.ok(
        (await modelState()).pending.includes("c4-browser-hold-peer"),
        "Original Agent Run and browser logout must not interrupt the peer Agent",
      );
      assert.equal(
        (
          await fetch(`${config.model}/release/c4-browser-hold-peer`, {
            method: "POST",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          })
        ).status,
        200,
      );
      await until(
        async () => {
          const operation = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${peerAgentId}/sessions/${peerSessionId}/operations/${peerHeldOperation.operationId}`,
            )
          ).body;
          return operation.phase === "completed" ? operation : null;
        },
        "peer Agent Run completes while original Agent Run remains held",
        abort.signal,
      );
      await crossAgentPage
        .getByText("c4-browser-hold-peer completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      assert.ok(
        (await modelState()).pending.includes("c4-browser-hold-logout"),
        "Completing the peer Agent Run must not release the original Agent Run",
      );
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-peer",
        ).length,
        1,
      );
      await crossAgentPage.close();
      assert.equal(
        (
          await fetch(`${config.model}/release/c4-browser-hold-logout`, {
            method: "POST",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          })
        ).status,
        200,
      );
      await until(
        async () => {
          const operation = (
            await memberClient.request(
              `/api/app/workspace/v1/agents/${fixture.agentID}/sessions/${sessionId}/operations/${logoutOperation.operationId}`,
            )
          ).body;
          return operation.phase === "completed" ? operation : null;
        },
        "Run survives browser logout",
        abort.signal,
      );
      await peerPage
        .getByText("c4-browser-hold-logout completed", { exact: true })
        .waitFor({ timeout: 120_000 });
      assert.equal(
        (await modelState()).requests.filter(
          (row) => row.phase === "c4-browser-hold-logout",
        ).length,
        1,
      );
      await logoutContext.close();
      await peerContext.close();
      await docker(
        composeArgs(config.project, [
          "-f",
          "tests/e2e/workspace-closeout/c4.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/fullstack.compose.yaml",
          "-f",
          "tests/e2e/agent-ui/short-expiry.compose.yaml",
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "90",
          "--no-deps",
          "--no-build",
          "--force-recreate",
          "identity-service",
        ]),
        true,
      );
      const expiryClient = new GatewayClient(config.gateway);
      let expiresAt = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const issued = (
          await expiryClient.request("/api/session/login", { body: member })
        ).body;
        expiresAt = Date.parse(issued.expires_at);
        if (expiresAt - Date.now() > 3_000) break;
      }
      const remainingMs = expiresAt - Date.now();
      assert.ok(
        Number.isFinite(expiresAt) &&
          remainingMs > 3_000 &&
          remainingMs <= 20_000,
        `Identity must issue a short-lived session; remaining milliseconds: ${remainingMs}`,
      );
      const expiryContext = await browser.newContext();
      await expiryContext.addCookies(
        [...expiryClient.cookies].map(([name, value]) => ({
          name,
          value,
          url: config.gateway,
        })),
      );
      const expiryPage = await expiryContext.newPage();
      await expiryPage.goto(
        `${config.gateway}/workspace/${encodeURIComponent(fixture.agentID)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      await expiryPage
        .getByText("c4-browser-hold-logout completed", { exact: true })
        .waitFor();
      await delay(Math.max(0, expiresAt - Date.now()) + 250, undefined, {
        signal: abort.signal,
      });
      await expiryPage
        .getByRole("button", { name: "Sign in", exact: true })
        .waitFor({ timeout: 120_000 });
      assert.equal(
        new URL(expiryPage.url()).searchParams.get("return_to"),
        `/workspace/${encodeURIComponent(fixture.agentID)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      assert.equal(await expiryPage.locator(".message-content").count(), 0);
      await expiryClient.request("/api/session", { status: 401 });
      await expiryContext.close();
      await fixture.json(
        `/api/admin/directory/users/${fixture.ownerID}/active`,
        {
          body: { active: false },
        },
      );
      await approvalPage
        .getByRole("button", { name: "Sign in", exact: true })
        .waitFor({ timeout: 120_000 });
      assert.equal(new URL(approvalPage.url()).pathname, "/");
      assert.equal(
        new URL(approvalPage.url()).searchParams.get("return_to"),
        `/workspace/${encodeURIComponent(fixture.agentID)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      assert.equal(await approvalPage.locator(".message-content").count(), 0);
      await until(
        async () =>
          (await fixture.json(`/api/admin/agents/${fixture.agentID}`))
            .activation_state === "disabled",
        "revoked Agent disabled",
        abort.signal,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(
        sockets.filter((url) => url.includes("/acp")),
        [],
      );
      await context.close();
      const output = `${root}/artifacts/verification/agent-ui-fullstack-20260923`;
      await mkdir(output, { recursive: true });
      const metricFile = heapDiagnostics
        ? "metrics-heap-long-history.json"
        : "metrics.json";
      await writeFile(
        `${output}/${metricFile}`,
        JSON.stringify(metrics, null, 2) + "\n",
      );
      await writeFile(
        `${output}/metrics-${metrics.capturedAt.replaceAll(/[:.]/g, "-")}.json`,
        JSON.stringify(metrics, null, 2) + "\n",
      );
      assertFixedWorkloadPerformance(metrics);
    } finally {
      abort.abort();
      slowReader?.stop();
      slowRequest?.destroy();
      secondSlowReader?.stop();
      secondSlowRequest?.destroy();
      await browser?.close().catch(() => {});
      if (config) {
        await cleanup(config);
        const docker = dockerClient(config.env, undefined, 60_000);
        for (const image of images)
          await docker(["image", "rm", image]).catch(() => {});
      }
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  },
);
