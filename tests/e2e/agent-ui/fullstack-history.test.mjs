import assert from "node:assert/strict";
import { readTurnContent } from "../../support/agent-ui/bridge-protocol.mjs";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { configuration, dockerClient, composeArgs, cleanup } from "../lifecycle-closeout/docker.mjs";
import { member, setup, until } from "../workspace-closeout/c4-setup.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);
const memoryBytes = (value) => {
  const match = value.match(/^([\d.]+)(B|KiB|MiB|GiB)/);
  assert.ok(match, `Unexpected Docker memory unit: ${value}`);
  return Math.round(Number(match[1]) * 1024 ** ["B", "KiB", "MiB", "GiB"].indexOf(match[2]));
};

test("real Gateway, Identity and ACP preserve complete browser history across continued Runs", { timeout: 900_000 }, async () => {
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Complete history E2E interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let config;
  let browser;
  let slowRequest;
  const images = [];
  const viewStatuses = [];
  try {
    config = await configuration(abort.signal);
    const suffix = config.project.slice(-8);
    const uiImage = `antnest/agent-ui:history-e2e-${suffix}`;
    const acpImage = `antnest/agent-acp-service:history-e2e-${suffix}`;
    const gatewayImage = `antnest/edge-gateway:history-e2e-${suffix}`;
    images.push(uiImage, acpImage, gatewayImage);
    Object.assign(config.env, {
      ANTNEST_C4_AGENT_UI_IMAGE: uiImage,
      ANTNEST_UI_E2E_ACP_IMAGE: acpImage,
      ANTNEST_UI_E2E_GATEWAY_IMAGE: gatewayImage,
      ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "false",
      ANTNEST_C4_CONTROL_DYNAMIC_RANGE: config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
      ANTNEST_C4_RUNTIME_DYNAMIC_RANGE: config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(".0/24", ".128/25"),
    });
    const docker = dockerClient(config.env, abort.signal, 900_000);
    for (const [file, image] of [
      ["services/agent-acp-service/Dockerfile", acpImage],
      ["services/agent-ui/Dockerfile", uiImage],
      ["services/edge-gateway/Dockerfile", gatewayImage],
    ]) await docker(["build", "-f", file, "-t", image, "."], true);
    await docker(composeArgs(config.project, [
      "-f", "tests/e2e/workspace-closeout/c4.compose.yaml",
      "-f", "tests/e2e/agent-ui/fullstack.compose.yaml",
      "up", "-d", "--wait", "--wait-timeout", "180", "--no-build",
    ]), true);
    const fixture = await setup(config, abort.signal);
    const memberClient = new GatewayClient(config.gateway);
    await memberClient.request("/api/session/login", { body: member });
    const sessionId = (await memberClient.request(
      `/api/app/workspace/v1/agents/${fixture.agentID}/sessions`, {
        status: 201, body: {},
      })).body.sessionId;
    assert.ok(sessionId);
    const viewPath = `/api/app/workspace/v1/agents/${fixture.agentID}/view?sessionId=${sessionId}`;
    const uiContainer = await docker(composeArgs(config.project, [
      "-f", "tests/e2e/workspace-closeout/c4.compose.yaml",
      "-f", "tests/e2e/agent-ui/fullstack.compose.yaml",
      "ps", "-q", "agent-ui",
    ]), true);
    assert.ok(uiContainer);
    const containerMemory = async () => memoryBytes((await docker([
      "stats", "--no-stream", "--format", "{{.MemUsage}}", uiContainer,
    ])).split("/")[0].trim());
    browser = await chromium.launch({ headless: true, handleSIGINT: false,
      handleSIGTERM: false, handleSIGHUP: false });
    const context = await browser.newContext();
    await context.addCookies([...memberClient.cookies].map(([name, value]) => ({
      name, value, url: config.gateway,
    })));
    const page = await context.newPage();
    const errors = [];
    const sockets = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto(`${config.gateway}/workspace/?agent=${fixture.agentID}&session=${sessionId}`);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await until(() => composer.isEnabled(), "initial Session View", abort.signal);
    const slowResponse = await new Promise((resolve, reject) => {
      slowRequest = get(
        `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}/events?sessionId=${sessionId}`,
        { headers: { Cookie: memberClient.cookie } }, resolve);
      slowRequest.once("error", reject);
    });
    assert.equal(slowResponse.statusCode, 200);
    slowResponse.on("error", () => {});
    slowResponse.pause();
    const memory = { beforeBytes: await containerMemory(), retainedBytes: 0,
      afterDisconnectBytes: 0, afterIdleBytes: 0 };
    let completedView;
    const submitted = [];
    for (let index = 0; index < 4; index++) {
      const phase = index === 1 ? "c4-browser-large-output"
        : `c4-browser-volume-${String(index).padStart(2, "0")}`;
      await composer.fill(phase);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      submitted.push(phase);
      const state = await until(async () => {
        const response = await fetch(`${config.gateway}${viewPath}`, {
          headers: { Cookie: memberClient.cookie },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        viewStatuses.push(response.status);
        if (response.status === 503) return null;
        assert.equal(response.status, 200, `Selected View returned ${response.status}`);
        const view = await response.json();
        const operation = view.operations?.find((row) => row.sessionId === sessionId &&
          row.phase === "completed");
        if (operation && view.selectedView?.turns?.some((turn) =>
          turn.outcome === "completed" &&
          turn.prompt?.some((block) => block.text === phase)))
          return { view, operation };
        return null;
      }, `Run ${phase} delivery`, abort.signal, 45_000);
      completedView = state.view;
      assert.equal(completedView.selectedView.historyState, "ready");
      assert.equal(typeof completedView.selectedView.historyToken, "string");
      await until(() => composer.isEnabled(), "composer after complete Run", abort.signal);
    }
    assert.equal(submitted.length, 4);
    const sessionView = completedView.selectedView;
    assert.equal(sessionView.turns.length, 4);
    assert.ok(Number.isSafeInteger(sessionView.outputWatermark));
    assert.ok(sessionView.outputWatermark > 0);
    const agentBase = `${config.gateway}/api/app/workspace/v1/agents/${fixture.agentID}`;
    for (const phase of submitted) {
      const turn = sessionView.turns.find((item) => item.prompt.some((block) => block.text === phase));
      assert.ok(turn, `Missing completed turn ${phase}`);
      const full = await readTurnContent(agentBase, sessionId, turn,
        { Cookie: memberClient.cookie }, abort.signal);
      const expected = `${phase}:${"v".repeat((phase === "c4-browser-large-output" ? 96 : 32) * 1024)}`;
      assert.equal(full.finalResponse.map((block) => block.text).join(""), expected,
        "Complete content remains available through signed paging");
    }
    assert.ok(completedView.selectedView.outputWatermark >=
      Math.max(...completedView.operations.filter((row) => row.sessionId === sessionId &&
        row.phase === "completed").map((row) => row.outputWatermark ?? 0)));
    memory.retainedBytes = await containerMemory();
    assert.ok(memory.retainedBytes - memory.beforeBytes < 128 * 1024 * 1024,
      `Fixed-volume complete history exceeded Bridge memory allowance: ${JSON.stringify(memory)}`);
    const assertBrowserHistory = async () => {
      await until(() => composer.isEnabled(), "complete history composer", abort.signal);
      await until(async () => (await page.locator(".conversation-turn").count()) === 4,
        "complete history rendered after lazy Conversation load", abort.signal);
      assert.equal(await page.locator(".conversation-turn").count(), 4);
      const largeTurn = page.locator(".conversation-turn").filter({
        has: page.locator(".message-user .message-content").filter({ hasText: "c4-browser-large-output" }),
      });
      // This content exceeds inline projection limits; expansion must recover every byte.
      const loadFullContent = largeTurn.getByRole("button", { name: "Load full content" });
      assert.equal(await loadFullContent.evaluate((button) =>
        button.closest(".message")?.classList.contains("message-answer")), true,
      "Answer continuation must belong to the Agent message, not the user prompt");
      await loadFullContent.focus();
      await page.keyboard.press("Enter");
      const expected = `c4-browser-large-output:${"v".repeat(96 * 1024)}`;
      await until(async () => (await largeTurn.innerText()).includes(expected),
        "complete large answer in browser", abort.signal);
      try {
        await until(() => largeTurn.locator(".message-answer").evaluate(
          (message) => document.activeElement === message),
        "keyboard focus on completed full answer", abort.signal, 5_000);
      } catch (cause) {
        const focused = await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          className: document.activeElement?.className,
          label: document.activeElement?.getAttribute("aria-label"),
        }));
        throw new Error(`Full answer focus remained at ${JSON.stringify(focused)}`, { cause });
      }
    };
    await assertBrowserHistory();
    await page.reload();
    await assertBrowserHistory();
    const modelState = await (await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    })).json();
    for (const phase of submitted)
      assert.equal(modelState.requests.filter((row) => row.phase === phase).length, 1);
    slowRequest.destroy();
    memory.afterDisconnectBytes = await containerMemory();
    await delay(10_000, undefined, { signal: abort.signal });
    memory.afterIdleBytes = await containerMemory();
    assert.ok(memory.afterIdleBytes <= memory.retainedBytes + 16 * 1024 * 1024,
      `Bridge retained unexpected memory after slow observer closed: ${JSON.stringify(memory)}`);
    const evidence = `${root}/artifacts/verification/agent-ui-complete-history`;
    await mkdir(evidence, { recursive: true });
    await writeFile(`${evidence}/metrics.json`, JSON.stringify({
      capturedAt: new Date().toISOString(), submittedRuns: submitted.length,
      outputWatermark: completedView.selectedView.outputWatermark, memory,
    }, null, 2) + "\n");
    assert.deepEqual(modelState.errors, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(sockets.filter((url) => url.includes("/acp")), []);
    await context.close();
  } catch (error) {
    if (config) {
      const directory = `${root}/artifacts/verification/agent-ui-history-${config.project}`;
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/failure.json`, JSON.stringify({
        message: error instanceof Error ? error.message : String(error), viewStatuses,
      }, null, 2) + "\n");
      const docker = dockerClient(config.env, undefined, 30_000);
      for (const service of ["agent-ui", "agent-acp-service", "edge-gateway"]) {
        try {
          const id = await docker(composeArgs(config.project, [
            "-f", "tests/e2e/workspace-closeout/c4.compose.yaml",
            "-f", "tests/e2e/agent-ui/fullstack.compose.yaml",
            "ps", "-q", service,
          ]), true);
          if (!id) continue;
          const logs = await execFileAsync("docker", ["logs", "--tail", "300", id], {
            env: config.env, maxBuffer: 2_000_000,
          });
          await writeFile(`${directory}/${service}.log`, logs.stdout + logs.stderr);
        } catch { /* Preserve the original failure. */ }
      }
    }
    throw error;
  } finally {
    abort.abort();
    slowRequest?.destroy();
    await browser?.close().catch(() => {});
    if (config) {
      await cleanup(config);
      const docker = dockerClient(config.env, undefined, 60_000);
      for (const image of images) await docker(["image", "rm", image]).catch(() => {});
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
});
