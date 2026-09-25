import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { agentStreamObserver, readTurnContent } from "../../support/agent-ui/bridge-protocol.mjs";
import { execFile } from "node:child_process";
import { createServer, get } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const fromUi = createRequire(new URL("../../../services/agent-ui/web/package.json", import.meta.url));
const acp = await import(fromUi.resolve("@agentclientprotocol/sdk"));
const { AcpServer } = await import(fromUi.resolve("@agentclientprotocol/sdk/experimental/server"));
const { createNodeHttpHandler } = await import(fromUi.resolve("@agentclientprotocol/sdk/experimental/node"));
const runningDocker = new Set();
const dockerSoak = process.env.ANTNEST_UI_DOCKER_SOAK === "1";

async function docker(args, timeout = 180_000) {
  const controller = new AbortController();
  runningDocker.add(controller);
  try {
    return await exec("docker", args, {
      cwd: root, timeout, maxBuffer: 2_000_000, signal: controller.signal,
    });
  } finally {
    runningDocker.delete(controller);
  }
}

async function inspectContainerMemory(container) {
  await docker(["exec", container, "kill", "-USR1", "1"]);
  const code = `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let target;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const pages = await (await fetch('http://127.0.0.1:9229/json/list')).json();
        target = pages[0]?.webSocketDebuggerUrl;
        if (target) break;
      } catch {}
      await sleep(100);
    }
    if (!target) throw new Error('Node inspector did not start');
    const socket = new WebSocket(target);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const receive = ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== id) return;
        socket.removeEventListener('message', receive);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const memory = async () => JSON.parse((await call('Runtime.evaluate', {
      expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true,
    })).result.value);
    const beforeGc = await memory();
    await call('HeapProfiler.collectGarbage');
    const afterGc = await memory();
    process.stdout.write(JSON.stringify({ beforeGc, afterGc }));
    socket.close();
  `;
  const { stdout } = await docker(["exec", container, "node", "--input-type=module", "-e", code], 20_000);
  return JSON.parse(stdout);
}

test("Bridge production container connects to official ACP HTTP and serves a selected view", { timeout: 600_000 }, async () => {
  const suffix = randomUUID().slice(0, 12);
  const image = `antnest-agent-ui-bridge-e2e:${suffix}`;
  const container = `antnest-agent-ui-bridge-e2e-${suffix}`;
  const idleContainer = `${container}-idle`;
  const interrupted = new AbortController();
  const interrupt = (code) => {
    process.exitCode = code;
    interrupted.abort(new Error("Bridge container test interrupted"));
    for (const controller of runningDocker) controller.abort();
  };
  const onInterrupt = () => interrupt(130);
  const onTerminate = () => interrupt(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const seen = [];
  const telemetryRequests = [];
  const gatewayTraceId = "0123456789abcdef0123456789abcdef";
  const gatewayParentSpanId = "1111111111111111";
  const controllerCalls = [];
  let session1Client;
  let session1Watermark = 0;
  let memoryClient;
  let memoryWatermark = 0;
  let longLoads = 0;
  let mediumLoads = 0;
  const requestPrincipal = new AsyncLocalStorage();
  const mediumClients = new Map();
  const mediumWatermarks = new Map();
  let mediumLive = false;
  const capacityMemoryBytes = [];
  let longNotifications = 0;
  const longFailures = [];
  const agent = acp.agent({ name: "bridge-container-fixture" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      assert.equal(params._meta?.["antnest.dev/bridge"]?.deliveryMark, 1);
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
        },
        _meta: { "antnest.dev/bridge": {
          intentReceipt: 1, targetCancel: 1, deliveryMark: 1,
        } },
      };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      assert(["session-1", "session-long", "session-medium", "session-memory"].includes(params.sessionId));
      if (params.sessionId === "session-1") {
        session1Client = client;
        await client.notify(acp.methods.client.session.update, {
          sessionId: "session-1",
          update: { sessionUpdate: "session_info_update", title: "Fixture session title",
            updatedAt: "2026-09-24T00:00:00Z" },
        });
      }
      if (params.sessionId === "session-long") {
        longLoads++;
        for (let index = 0; index < 20; index++) {
          try { await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", messageId: "long-answer",
              content: { type: "text", text: "x".repeat(16 * 1024) } },
            _meta: { "antnest.dev/delivery": { kind: "part", sequence: index + 1,
              partIndex: 0, partCount: 1, runId: "run-long", messageId: `event-${index}` } },
          }); longNotifications++; }
          catch (error) { longFailures.push({ index, message: error.message }); throw error; }
        }
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
          _meta: { "antnest.dev/delivery": { kind: "checkpoint", sequence: 21 } },
        });
      }
      if (params.sessionId === "session-memory") memoryClient = client;
      if (params.sessionId === "session-medium") {
        mediumLoads++;
        const principalId = requestPrincipal.getStore();
        assert.equal(typeof principalId, "string");
        mediumClients.set(principalId, client);
        for (let index = 0; index < 8; index++)
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", messageId: "medium-answer",
              content: { type: "text", text: "m".repeat(16 * 1024) } },
            _meta: { "antnest.dev/delivery": { kind: "part", sequence: index + 1,
              partIndex: 0, partCount: 1, runId: "run-medium", messageId: `medium-event-${index}` } },
          });
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
          _meta: { "antnest.dev/delivery": { kind: "checkpoint", sequence: 9 } },
        });
      }
      return { _meta: { "antnest.dev/delivery": {
        sealedWatermark: params.sessionId === "session-long" ? 21
          : params.sessionId === "session-medium" ? 9
            : params.sessionId === "session-memory" ? memoryWatermark : session1Watermark,
        appendVersion: 1,
      } } };
    })
    .onRequest(acp.methods.agent.session.list, ({ params }) => {
      assert.equal(params.cursor, "old-page");
      return { sessions: [{ sessionId: "session-1", cwd: "/workspace", title: "First" }], nextCursor: "next-page" };
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      assert.equal(params.cwd, "/workspace");
      assert.deepEqual(params.mcpServers, []);
      return { sessionId: "session-2" };
    });
  const acpHandler = createNodeHttpHandler(new AcpServer({ agent }));
  const fixture = createServer((request, response) => {
    if (request.url === "/v1/traces" || request.url === "/v1/metrics") {
      const chunks = [];
      request.on("data", (chunk) => { chunks.push(chunk); });
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        telemetryRequests.push({ path: request.url, bytes: body.length,
          body: body.toString("utf8") });
        response.writeHead(200).end();
      });
      return;
    }
    seen.push({ path: request.url, headers: request.headers });
    if (request.url === "/rpc/agent-controller/list-workspace-agents") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        controllerCalls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          agents: [{ agent_id: "agent-1", name: "Research", lifecycle_state: "created", activation_state: "enabled", runtime_state: "available" }],
          next_cursor: null,
        }));
      });
      return;
    }
    if (request.url === "/v1/acp") {
      requestPrincipal.run(request.headers["x-antnest-principal-id"], () => {
        acpHandler(request, response);
      });
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/rpc/agent-acp/get-agent-execution-state") {
      response.end(JSON.stringify({
        agent_id: "agent-1", access_allowed: true,
        availability: mediumLive ? "busy" : "ready",
        active_session_id: mediumLive ? "session-medium" : null,
        configuration_revision: "a".repeat(64), unavailable_reason: null,
      }));
      return;
    }
    if (request.url === "/rpc/agent-acp/workspace/sessions/session-1/execution" ||
      request.url === "/rpc/agent-acp/workspace/sessions/session-long/execution" ||
      request.url === "/rpc/agent-acp/workspace/sessions/session-medium/execution" ||
      request.url === "/rpc/agent-acp/workspace/sessions/session-memory/execution") {
      response.end(JSON.stringify({
        sessionId: request.url.split("/").at(-2),
        appendVersion: 1, outputWatermark: request.url.includes("session-long") ? 21
          : request.url.includes("session-medium")
            ? mediumWatermarks.get(request.headers["x-antnest-principal-id"]) ?? 9
            : request.url.includes("session-memory") ? memoryWatermark : session1Watermark,
        activeRunId: mediumLive && request.url.includes("session-medium")
          ? "run-medium" : null,
        recentReceipts: [], configurationRevision: null,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
  });
  await new Promise((resolve) => fixture.listen(0, "0.0.0.0", resolve));
  const fixtureAddress = fixture.address();
  assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
  const cleanup = async () => {
    await docker(["rm", "-f", idleContainer], 30_000).catch(() => {});
    await docker(["rm", "-f", container], 30_000).catch(() => {});
    await docker(["image", "rm", image], 30_000).catch(() => {});
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  };
  try {
    await docker(["build", "-f", "services/agent-ui/Dockerfile", "-t", image, "."]);
    const launchStartedAt = performance.now();
    await docker([
      "run", "-d", "--name", container,
      "--add-host", "host.docker.internal:host-gateway",
      "-p", "127.0.0.1::8080",
      "-e", `ANTNEST_AGENT_ACP_SERVICE_URL=http://host.docker.internal:${fixtureAddress.port}`,
      "-e", `ANTNEST_AGENT_CONTROLLER_URL=http://host.docker.internal:${fixtureAddress.port}`,
      "-e", `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:${fixtureAddress.port}`,
      "-e", "OTEL_SERVICE_NAME=agent-ui",
      "-e", "OTEL_SDK_DISABLED=false",
      "-e", "ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS=16",
      "-e", "ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS=1000",
      "-e", "ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES=1024",
      image,
    ]);
    const { stdout } = await docker(["port", container, "8080/tcp"]);
    const port = Number(stdout.trim().split(":").at(-1));
    assert.ok(Number.isSafeInteger(port) && port > 0);
    const base = `http://127.0.0.1:${port}`;
    const portResolvedMs = performance.now() - launchStartedAt;
    let coldDocumentHtml;
    let coldAttempts = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      coldAttempts++;
      let response;
      try {
        response = await fetch(`${base}/workspace/?agent=agent-1`, {
          headers: {
            "x-antnest-organization-id": "org-1",
            "x-antnest-principal-id": "user-1",
            "x-antnest-administrator": "false",
          },
          signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
        });
      } catch {
        interrupted.signal.throwIfAborted();
      }
      if (response) {
        assert.equal(response.status, 200, "Cold authenticated SSR request failed");
        coldDocumentHtml = await response.text();
        assert.match(coldDocumentHtml, /Research/);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(coldDocumentHtml, "Cold authenticated SSR document did not become available");
    const coldStart = {
      containerLaunchToPortResolvedMs: Math.round(portResolvedMs),
      containerLaunchToAuthenticatedHtmlCompleteMs: Math.round(performance.now() - launchStartedAt),
      requestAttempts: coldAttempts,
    };
    const coldEvidencePath = `${root}/artifacts/verification/agent-ui-cold-start-20260924`;
    await mkdir(coldEvidencePath, { recursive: true });
    await writeFile(`${coldEvidencePath}/run-${Date.now()}.json`,
      JSON.stringify({ capturedAt: new Date().toISOString(), ...coldStart }, null, 2) + "\n");
    assert.ok(coldStart.containerLaunchToAuthenticatedHtmlCompleteMs < 5_000,
      `Cold authenticated SSR took ${coldStart.containerLaunchToAuthenticatedHtmlCompleteMs} ms`);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(`${base}/status`, {
          signal: AbortSignal.any([AbortSignal.timeout(500), interrupted.signal]),
        })).ok;
      } catch {}
      interrupted.signal.throwIfAborted();
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Bridge container did not become ready");
    const memoryBytes = async () => {
      const { stdout } = await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", container]);
      const match = stdout.trim().match(/^([\d.]+)(B|KiB|MiB|GiB)/);
      assert.ok(match, `Unexpected container memory: ${stdout.trim()}`);
      return Math.round(Number(match[1]) * 1024 ** ["B", "KiB", "MiB", "GiB"].indexOf(match[2]));
    };
    await docker(["exec", container, "test", "!", "-e", "/app/dist/index.html"]);
    const bootstrapResponse = await fetch(`${base}/api/app/workspace/v1/bootstrap`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-administrator": "false",
        traceparent: `00-${gatewayTraceId}-${gatewayParentSpanId}-01`,
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrapResponse.status, 200, JSON.stringify(bootstrap));
    assert.deepEqual(bootstrap.principal, {
      userId: "user-1", organizationId: "org-1", administrator: false,
    });
    assert.equal(bootstrap.agents[0]?.agentId, "agent-1");
    assert.equal(controllerCalls[0]?.organization_id, "org-1");
    assert.equal(controllerCalls[0]?.principal_id, "user-1");
    assert.ok(seen.some(({ path, headers }) =>
      path === "/rpc/agent-controller/list-workspace-agents" &&
      new RegExp(`^00-${gatewayTraceId}-[a-f0-9]{16}-01$`).test(headers.traceparent ?? "")),
    "Controller discovery must continue the authenticated Bridge HTTP trace");
    assert.equal((await fetch(`${base}/workspace/?agent=agent-1`)).status, 401);
    const documentResponse = await fetch(`${base}/workspace/?agent=agent-1`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-administrator": "false",
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(documentResponse.status, 200);
    assert.equal(documentResponse.headers.get("cache-control"), "private, no-store");
    const html = await documentResponse.text();
    assert.match(html, /Research/);
    const clientScript = html.match(/src="(\/workspace\/assets\/entry-client-[^"]+\.js)"/)?.[1];
    assert.ok(clientScript, "SSR document omitted its client script");
    const scriptResponse = await fetch(`${base}${clientScript}`);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get("content-type") ?? "", /javascript/);
    const response = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
        traceparent: `00-${gatewayTraceId}-${gatewayParentSpanId}-01`,
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    const view = await response.json();
    assert.equal(response.status, 200, JSON.stringify(view));
    assert.equal(view.selectedView?.sessionId, "session-1");
    assert.equal(view.selectedView?.appendVersion, 1);
    assert.equal(view.selectedView?.title, "Fixture session title");
    assert.equal(view.selectedView?.updatedAt, "2026-09-24T00:00:00Z");
    const oversizedPrompt = { intentId: "intent-cap", expectedAppendVersion: 1,
      prompt: [{ type: "text", text: "x".repeat(850) }] };
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedPrompt)) < 1024);
    const rejectedPrompt = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts`, {
      method: "POST",
      headers: { "x-antnest-organization-id": "org-1", "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1", "content-type": "application/json",
        "idempotency-key": "intent-cap", "if-match": view.selectedView.historyToken },
      body: JSON.stringify(oversizedPrompt),
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(rejectedPrompt.status, 413);
    assert.equal((await rejectedPrompt.json()).code, "request_too_large");
    assert.deepEqual(view.promptCapabilities, {
      image: true, audio: false, embeddedContext: true,
    });
    const initialTurns = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(initialTurns.status, 200);
    assert.deepEqual(await initialTurns.json(), {
      items: [], nextCursor: null, newerCursor: null,
    });
    const memoryViewUrl = `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-memory`;
    const memoryStreamUrl = `${base}/api/app/workspace/v1/agents/agent-1/events?sessionId=session-memory`;
    const memoryHeaders = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    const firstMemoryResponse = await fetch(memoryViewUrl, { headers: memoryHeaders,
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]) });
    assert.equal(firstMemoryResponse.status, 200);
    await firstMemoryResponse.body.cancel();
    assert.ok(memoryClient, "Memory Session must use the official ACP client");
    const memoryBody = `start 界\\\"\n${"x".repeat(1024 * 1024)}\nend`;
    const memoryNotify = async (sequence, messageId, update) => {
      memoryWatermark = sequence;
      await memoryClient.notify(acp.methods.client.session.update, {
        sessionId: "session-memory", update,
        _meta: { "antnest.dev/delivery": { kind: "part", sequence,
          partIndex: 0, partCount: 1, runId: "run-memory", messageId } },
      });
    };
    await memoryNotify(1, "memory-large", { sessionUpdate: "tool_call",
      toolCallId: "memory-large", title: "Large", status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: memoryBody } }] });
    await memoryNotify(2, "memory-small", { sessionUpdate: "tool_call",
      toolCallId: "memory-small", title: "Small", status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "original" } }] });
    const memoryReaders = [];
    const memoryControllers = [];
    let memoryEvidence;
    try {
      for (let index = 0; index < 4; index++) {
        const controller = new AbortController();
        memoryControllers.push(controller);
        const stream = await fetch(memoryStreamUrl, { headers: memoryHeaders,
          signal: AbortSignal.any([controller.signal, interrupted.signal,
            AbortSignal.timeout(60_000)]) });
        assert.equal(stream.status, 200);
        const reader = stream.body.getReader();
        const observer = agentStreamObserver();
        const initial = await reader.read();
        assert.equal(initial.done, false);
        observer.push(initial.value);
        assert.equal(observer.view?.selectedView?.outputWatermark, 2);
        memoryReaders.push({ reader, observer });
      }
      const beforeSmallBytes = await memoryBytes();
      let viewBytes = 0;
      let sseBytes = 0;
      for (let step = 0; step < 8; step++) {
        const sequence = step + 3;
        await memoryNotify(sequence, `memory-small-${step}`,
          { sessionUpdate: "tool_call_update", toolCallId: "memory-small",
            title: `Small ${step}`, status: "in_progress",
            content: [{ type: "content",
              content: { type: "text", text: `small output ${step}` } }] });
        for (const { reader, observer } of memoryReaders) {
          for (let attempt = 0; attempt < 4 &&
            (observer.view?.selectedView?.outputWatermark ?? 0) < sequence; attempt++) {
            const next = await reader.read();
            assert.equal(next.done, false);
            sseBytes += next.value.length;
            assert.ok(next.value.length < 128 * 1024,
              "Unrelated large tool body leaked into production SSE");
            observer.push(next.value);
          }
          assert.equal(observer.view?.selectedView?.outputWatermark, sequence);
        }
        const current = await fetch(memoryViewUrl, { headers: memoryHeaders,
          signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]) });
        assert.equal(current.status, 200);
        const wire = await current.text();
        viewBytes += Buffer.byteLength(wire);
        assert.ok(Buffer.byteLength(wire) < 128 * 1024,
          "Unrelated large tool body leaked into production View");
        assert.equal(JSON.parse(wire).selectedView?.outputWatermark, sequence);
      }
      const afterSmallBytes = await memoryBytes();
      memoryEvidence = { bodyBytes: Buffer.byteLength(memoryBody),
        updates: 8, observers: memoryReaders.length, viewBytes, sseBytes,
        beforeSmallBytes, afterSmallBytes };
      assert.ok(afterSmallBytes - beforeSmallBytes < 64 * 1024 * 1024,
        `Small updates retained excessive production container memory: ${JSON.stringify(memoryEvidence)}`);
    } finally {
      memoryControllers.forEach((controller) => controller.abort());
      await Promise.all(memoryReaders.map(({ reader }) => reader.cancel().catch(() => {})));
    }
    const processResponse = await fetch(
      `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process`,
      { headers: memoryHeaders,
        signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]) });
    assert.equal(processResponse.status, 200);
    const process = await processResponse.json();
    const largeTool = process.items.find((item) => item.kind === "tool" && item.summary === "Large");
    assert.ok(largeTool?.contentCursor, "Large tool must retain paged content");
    let processCursor = largeTool.contentCursor;
    const contentBytes = [];
    while (processCursor) {
      const pageResponse = await fetch(
        `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process/${encodeURIComponent(largeTool.id)}/content?cursor=${encodeURIComponent(processCursor)}`,
        { headers: memoryHeaders,
          signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]) });
      assert.equal(pageResponse.status, 200);
      const page = await pageResponse.json();
      assert.ok(page.fragment, "Large tool content must use exact fragments");
      contentBytes.push(Buffer.from(page.fragment.serializedBlockBase64, "base64"));
      processCursor = page.nextCursor;
    }
    assert.equal(JSON.parse(Buffer.concat(contentBytes).toString("utf8")).text, memoryBody);
    const abandonedBaseline = await inspectContainerMemory(container);
    const abandonedBeforeBytes = await memoryBytes();
    const abandonedPages = 12;
    for (let cycle = 0; cycle < abandonedPages; cycle++) {
      const nextBody = `${cycle}:${memoryBody}`;
      await memoryNotify(11 + cycle, `memory-large-revision-${cycle}`,
        { sessionUpdate: "tool_call_update", toolCallId: "memory-large",
          title: "Large", status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: nextBody } }] });
      const directoryResponse = await fetch(
        `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process`,
        { headers: memoryHeaders,
          signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]) });
      assert.equal(directoryResponse.status, 200);
      const directory = await directoryResponse.json();
      const tool = directory.items.find((item) => item.id === largeTool.id);
      assert.ok(tool?.contentCursor);
      const firstPageResponse = await fetch(
        `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process/${encodeURIComponent(tool.id)}/content?cursor=${encodeURIComponent(tool.contentCursor)}`,
        { headers: memoryHeaders,
          signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]) });
      assert.equal(firstPageResponse.status, 200);
      const firstPage = await firstPageResponse.json();
      assert.ok(firstPage.nextCursor, "The reader must stop before the large content is complete");
    }
    await new Promise((resolve) => setTimeout(resolve, 34_000));
    const abandonedAfter = await inspectContainerMemory(container);
    const abandonedAfterBytes = await memoryBytes();
    const abandonedEvidence = { abandonedPages,
      bodyBytes: Buffer.byteLength(memoryBody),
      beforeGcHeapUsed: abandonedBaseline.afterGc.heapUsed,
      afterGcHeapUsed: abandonedAfter.afterGc.heapUsed,
      beforeGcContainerBytes: abandonedBeforeBytes,
      afterGcContainerBytes: abandonedAfterBytes };
    assert.ok(abandonedAfter.afterGc.heapUsed - abandonedBaseline.afterGc.heapUsed < 16 * 1024 * 1024,
      `Abandoned process pages retained heap: ${JSON.stringify(abandonedEvidence)}`);
    assert.ok(abandonedAfterBytes - abandonedBeforeBytes < 32 * 1024 * 1024,
      `Abandoned process pages retained container memory: ${JSON.stringify(abandonedEvidence)}`);
    await mkdir(`${root}/artifacts/verification/agent-ui`, { recursive: true });
    await writeFile(`${root}/artifacts/verification/agent-ui/abandoned-process-pages-container.json`,
      JSON.stringify(abandonedEvidence, null, 2) + "\n");
    const memoryEvidencePath = `${root}/artifacts/verification/agent-ui/memory-container-small-updates.json`;
    await mkdir(`${root}/artifacts/verification/agent-ui`, { recursive: true });
    await writeFile(memoryEvidencePath, JSON.stringify(memoryEvidence, null, 2) + "\n");
    assert.ok(session1Client, "The official ACP load must retain its live client");
    const streamUrl = `${base}/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1`;
    const streamHeaders = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    const slowRequest = get(streamUrl, { headers: streamHeaders });
    const slowResponse = await new Promise((resolve, reject) => {
      slowRequest.once("response", resolve);
      slowRequest.once("error", reject);
    });
    assert.equal(slowResponse.statusCode, 200);
    slowResponse.pause();
    // New turns slide the visible window, so this produces enough actual wire
    // traffic to exceed TCP buffering even with incremental publication.
    const streamUpdates = 512;
    const finalStreamWatermark = streamUpdates;
    let slowStreamBytes = 0;
    const slowObserver = agentStreamObserver();
    const slowTimer = setInterval(() => {
      const chunk = slowResponse.read(1024);
      if (chunk) {
        slowStreamBytes += chunk.length;
        slowObserver.push(chunk);
      }
    }, 200);
    let fastReader;
    let slowStreamEvidence;
    try {
      const fastResponse = await fetch(streamUrl, {
        headers: streamHeaders,
        signal: AbortSignal.timeout(120_000),
      });
      assert.equal(fastResponse.status, 200);
      fastReader = fastResponse.body.getReader();
      const fastObserver = agentStreamObserver();
      let latestFastWatermark = 0;
      const fastReads = (async () => {
        for (;;) {
          const next = await fastReader.read();
          if (next.done) return false;
          fastObserver.push(next.value);
          latestFastWatermark = fastObserver.view?.selectedView?.outputWatermark ?? 0;
          if (latestFastWatermark >= finalStreamWatermark) return true;
        }
      })();
      const beforeStreamBytes = await memoryBytes();
      for (let index = 1; index <= streamUpdates; index++) {
        const sequence = index;
        session1Watermark = sequence;
        await session1Client.notify(acp.methods.client.session.update, {
          sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", messageId: `stream-${sequence}`,
            content: { type: "text", text: `${sequence}:` + "s".repeat(8 * 1024) } },
          _meta: { "antnest.dev/delivery": { kind: "part", sequence,
            partIndex: 0, partCount: 1, runId: `run-stream-${sequence}`,
            messageId: `stream-${sequence}` } },
        });
        for (let attempt = 0; attempt < 200 && latestFastWatermark < sequence; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(latestFastWatermark >= sequence,
          `Normal observer did not see ACP update ${sequence}; latest ${latestFastWatermark}`);
      }
      assert.equal(await Promise.race([
        fastReads,
        new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
      ]), true, "A normal production SSE observer must see the final ACP watermark");
      clearInterval(slowTimer);
      slowResponse.on("data", (chunk) => {
        slowStreamBytes += chunk.length;
        slowObserver.push(chunk);
      });
      slowResponse.resume();
      for (let attempt = 0; attempt < 200 &&
        slowObserver.view?.selectedView?.outputWatermark !== finalStreamWatermark; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(slowObserver.view?.selectedView?.outputWatermark, finalStreamWatermark,
        "A slow production SSE observer must recover the latest ACP watermark");
      const revisions = slowObserver.revisions;
      assert.ok(revisions.some((revision, index) => index > 0 &&
        revision - revisions[index - 1] > 1),
      `A slow production observer should coalesce missed resets: ${revisions.length} frames, ${slowStreamBytes} bytes`);
      slowStreamEvidence = { updates: streamUpdates, slowStreamBytes,
        observedFrames: revisions.length, resetFrames: slowObserver.resets,
        beforeStreamBytes, afterStreamBytes: await memoryBytes() };
      assert.ok(slowStreamEvidence.afterStreamBytes < 384 * 1024 * 1024,
        `Production SSE overload exceeded its fixed-load peak: ${JSON.stringify(slowStreamEvidence)}`);
    } finally {
      clearInterval(slowTimer);
      slowRequest.destroy();
      await fastReader?.cancel().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    slowStreamEvidence.afterDisconnectBytes = await memoryBytes();
    slowStreamEvidence.inspector = await inspectContainerMemory(container);
    slowStreamEvidence.afterGcContainerBytes = await memoryBytes();
    assert.ok(slowStreamEvidence.afterGcContainerBytes - slowStreamEvidence.beforeStreamBytes <
      64 * 1024 * 1024,
    `Production SSE retained memory after disconnect and GC: ${JSON.stringify(slowStreamEvidence)}`);
    const metadataAfterStream = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`, {
      headers: streamHeaders,
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(metadataAfterStream.status, 200);
    const streamMetadata = (await metadataAfterStream.json()).selectedView;
    assert.equal(streamMetadata.title, "Fixture session title");
    assert.equal(streamMetadata.updatedAt, "2026-09-24T00:00:00Z");
    const observerChurn = { cycles: dockerSoak ? 180 : 24,
      beforeBytes: slowStreamEvidence.afterGcContainerBytes, samples: [] };
    for (let cycle = 0; cycle < observerChurn.cycles; cycle++) {
      const controller = new AbortController();
      try {
        const response = await fetch(streamUrl, { headers: streamHeaders,
          signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal,
            controller.signal]) });
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        const first = await reader.read();
        assert.equal(first.done, false);
        await reader.cancel();
      } finally {
        controller.abort();
      }
      if (dockerSoak) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if ((cycle + 1) % 30 === 0) {
          const passiveBytes = await memoryBytes();
          const inspector = await inspectContainerMemory(container);
          const afterGcBytes = await memoryBytes();
          observerChurn.samples.push({ cycle: cycle + 1, passiveBytes,
            afterGcBytes, heapUsedBytes: inspector.afterGc.heapUsed });
          assert.ok(passiveBytes < 384 * 1024 * 1024,
            `Production observer churn exceeded its peak budget: ${JSON.stringify(observerChurn)}`);
          assert.ok(afterGcBytes - observerChurn.beforeBytes < 32 * 1024 * 1024,
            `Production observer churn retained memory: ${JSON.stringify(observerChurn)}`);
        }
      }
    }
    if (!dockerSoak) await new Promise((resolve) => setTimeout(resolve, 500));
    observerChurn.inspector = await inspectContainerMemory(container);
    observerChurn.afterGcBytes = await memoryBytes();
    assert.ok(observerChurn.afterGcBytes - observerChurn.beforeBytes < 32 * 1024 * 1024,
      `Repeated production SSE observers retained memory: ${JSON.stringify(observerChurn)}`);
    const churnEvidencePath = `${root}/artifacts/verification/agent-ui/${dockerSoak
      ? "observer-churn-container-soak" : "observer-churn-container"}.json`;
    await mkdir(`${root}/artifacts/verification/agent-ui`, { recursive: true });
    await writeFile(churnEvidencePath, JSON.stringify(observerChurn, null, 2) + "\n");
    capacityMemoryBytes.push(await memoryBytes());
    for (let attempt = 0; attempt < 12; attempt++) {
      const longResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-long`, {
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-1",
          "x-antnest-agent-id": "agent-1",
        },
        signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
      });
      const longBody = await longResponse.json();
      assert.equal(longResponse.status, 200, `long replay attempt ${attempt + 1}: ${longBody.code}`);
      assert.equal(longBody.selectedView.historyState, "ready");
      assert.equal(typeof longBody.selectedView.historyToken, "string");
      assert.equal(longLoads, 1, "Repeated reads must reuse complete loaded history");
      if (attempt === 0) {
        const full = await readTurnContent(`${base}/api/app/workspace/v1/agents/agent-1`,
          "session-long", longBody.selectedView.turns[0], streamHeaders, interrupted.signal);
        assert.equal(full.finalResponse.map((block) => block.text).join(""), "x".repeat(20 * 16 * 1024));
      }
      capacityMemoryBytes.push(await memoryBytes());
    }
    assert.ok(Math.max(...capacityMemoryBytes) - capacityMemoryBytes[0] < 64 * 1024 * 1024,
      `Repeated replay memory samples: ${JSON.stringify(capacityMemoryBytes)}`);
    const retainedResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(retainedResponse.status, 200);
    const mediumResults = [];
    const mediumMemoryBytes = [await memoryBytes()];
    for (let userIndex = 2; userIndex <= 16; userIndex++) {
      const mediumResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": `user-${userIndex}`,
          "x-antnest-agent-id": "agent-1",
        },
        signal: AbortSignal.any([AbortSignal.timeout(15_000), interrupted.signal]),
      });
      const body = await mediumResponse.json();
      mediumResults.push({ principalId: `user-${userIndex}`, status: mediumResponse.status,
        code: body.code ?? null });
      mediumMemoryBytes.push(await memoryBytes());
      assert.equal(mediumResponse.status, 200, JSON.stringify(body));
      assert.equal(body.selectedView?.sessionId, "session-medium");
    }
    assert.equal(mediumResults.length, 15, "All independent owners retain their complete histories");
    const firstMediumOwner = mediumResults[0].principalId;
    const existingMediumResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": firstMediumOwner,
        "x-antnest-agent-id": "agent-1",
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(existingMediumResponse.status, 200,
      "Other owners must preserve an existing owner's readable Session");
    assert.ok(Math.max(...mediumMemoryBytes) - mediumMemoryBytes[0] < 64 * 1024 * 1024,
      "Fixed multi-owner history stays within its measured memory allowance");
    const activeOwners = mediumResults.filter(({ status }) => status === 200)
      .map(({ principalId }) => principalId);
    assert.ok(activeOwners.every((principalId) => mediumClients.has(principalId)));
    mediumLive = true;
    const liveResults = [];
    const liveOwner = activeOwners[0];
    for (let round = 0; round < 4; round++) {
      for (let index = 0; index < activeOwners.length; index++) {
        const principalId = activeOwners[index];
        const sequence = (mediumWatermarks.get(principalId) ?? 9) + 1;
        mediumWatermarks.set(principalId, sequence);
        await mediumClients.get(principalId).notify(acp.methods.client.session.update, {
          sessionId: "session-medium",
          update: { sessionUpdate: "agent_message_chunk",
            messageId: `live-${sequence}`,
            content: { type: "text", text: "a".repeat(8 * 1024) } },
          _meta: { "antnest.dev/delivery": { kind: "part", sequence,
            partIndex: 0, partCount: 1, runId: "run-medium",
            messageId: `live-event-${sequence}` } },
        });
        const liveResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
          headers: {
            "x-antnest-organization-id": "org-1",
            "x-antnest-principal-id": principalId,
            "x-antnest-agent-id": "agent-1",
          },
          signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
        });
        const liveBody = await liveResponse.json();
        liveResults.push({ principalId, sequence, status: liveResponse.status,
          historyState: liveBody.selectedView?.historyState ?? null });
        assert.equal(liveBody.selectedView?.historyState, "ready");
        assert.equal(liveBody.selectedView.outputWatermark, sequence);
        assert.equal(typeof liveBody.selectedView.historyToken, "string");
        assert.equal(liveResponse.status, 200, JSON.stringify(liveBody));
      }
    }
    const survivingOwner = activeOwners.find((principalId) => principalId !== liveOwner);
    const survivingResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": survivingOwner,
        "x-antnest-agent-id": "agent-1",
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(survivingResponse.status, 200,
      "Continued output preserves another owner's running View");
    const continuedMemoryBytes = [await memoryBytes()];
    for (let index = 0; index < 24; index++) {
      const sequence = (mediumWatermarks.get(liveOwner) ?? 9) + 1;
      mediumWatermarks.set(liveOwner, sequence);
      await mediumClients.get(liveOwner).notify(acp.methods.client.session.update, {
        sessionId: "session-medium",
        update: { sessionUpdate: "agent_message_chunk", messageId: `live-${sequence}`,
          content: { type: "text", text: "b".repeat(8 * 1024) } },
        _meta: { "antnest.dev/delivery": { kind: "part", sequence,
          partIndex: 0, partCount: 1, runId: "run-medium",
          messageId: `live-event-${sequence}` } },
      });
    }
    const continuedResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
      headers: { "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": liveOwner,
        "x-antnest-agent-id": "agent-1" },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    const continuedBody = await continuedResponse.json();
    assert.equal(continuedResponse.status, 200);
    assert.equal(continuedBody.selectedView?.historyState, "ready");
    assert.equal(continuedBody.selectedView?.outputWatermark,
      mediumWatermarks.get(liveOwner));
    const continuedContent = await readTurnContent(`${base}/api/app/workspace/v1/agents/agent-1`,
      "session-medium", continuedBody.selectedView.turns[0],
      { ...streamHeaders, "x-antnest-principal-id": liveOwner }, interrupted.signal);
    const continuedText = "m".repeat(8 * 16 * 1024) + "a".repeat(4 * 8 * 1024) + "b".repeat(24 * 8 * 1024);
    assert.equal(continuedContent.finalResponse.map((block) => block.text).join(""), continuedText);
    continuedMemoryBytes.push(await memoryBytes());
    assert.ok(continuedMemoryBytes[1] - continuedMemoryBytes[0] < 64 * 1024 * 1024,
      `Continued-output memory samples: ${JSON.stringify(continuedMemoryBytes)}`);
    mediumMemoryBytes.push(await memoryBytes());
    assert.ok(Math.max(...mediumMemoryBytes) - mediumMemoryBytes[0] < 64 * 1024 * 1024,
      `Active-output memory samples: ${JSON.stringify(mediumMemoryBytes)}`);
    const oversizedBeforeBytes = await memoryBytes();
    const oversizedSequence = (mediumWatermarks.get(liveOwner) ?? 0) + 1;
    mediumWatermarks.set(liveOwner, oversizedSequence);
    await mediumClients.get(liveOwner).notify(acp.methods.client.session.update, {
      sessionId: "session-medium",
      update: { sessionUpdate: "agent_message_chunk", messageId: `live-${oversizedSequence}`,
        content: { type: "text", text: "c".repeat(17 * 1024 * 1024) } },
      _meta: { "antnest.dev/delivery": { kind: "part", sequence: oversizedSequence,
        partIndex: 0, partCount: 1, runId: "run-medium",
        messageId: `live-event-${oversizedSequence}` } },
    });
    let oversizedView;
    const oversizedReadyDeadline = performance.now() + 30_000;
    while (performance.now() < oversizedReadyDeadline) {
      const response = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
        headers: { "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": liveOwner,
          "x-antnest-agent-id": "agent-1" },
        signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
      });
      assert.equal(response.status, 200);
      oversizedView = await response.json();
      if (oversizedView.selectedView?.historyState === "ready" &&
        oversizedView.selectedView.outputWatermark === oversizedSequence) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(oversizedView?.selectedView?.historyState, "ready");
    assert.equal(oversizedView?.selectedView?.outputWatermark, oversizedSequence);
    const oversizedContent = await readTurnContent(`${base}/api/app/workspace/v1/agents/agent-1`,
      "session-medium", oversizedView.selectedView.turns[0],
      { ...streamHeaders, "x-antnest-principal-id": liveOwner }, interrupted.signal);
    assert.equal(oversizedContent.finalResponse.map((block) => block.text).join(""), continuedText + "c".repeat(17 * 1024 * 1024));
    const oversizedAfterBytes = await memoryBytes();
    assert.ok(oversizedAfterBytes - oversizedBeforeBytes < 128 * 1024 * 1024,
      `Oversized ACP update exceeded transient memory allowance: ${oversizedAfterBytes - oversizedBeforeBytes}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const oversizedDelivery = { sequence: oversizedSequence,
      beforeBytes: oversizedBeforeBytes, afterBytes: oversizedAfterBytes,
      afterIdleBytes: await memoryBytes() };
    mediumLive = false;
    const beforeReclaimBytes = await memoryBytes();
    for (let index = 0; index < 20; index++) {
      const coldReplacement = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view`, {
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": `user-replacement-${index}`,
          "x-antnest-agent-id": "agent-1",
        },
        signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
      });
      assert.equal(coldReplacement.status, 200,
        `New owner ${index} should evict a cold owner at capacity`);
      assert.equal((await coldReplacement.json()).selectedView, null);
    }
    const reclaimedResponse = await fetch(
      `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-after-reclaim",
          "x-antnest-agent-id": "agent-1",
        },
        signal: AbortSignal.any([AbortSignal.timeout(15_000), interrupted.signal]),
      });
    const reclaimedBody = await reclaimedResponse.json();
    assert.equal(reclaimedResponse.status, 200,
      `Cold owner eviction must release retained state: ${JSON.stringify(reclaimedBody)}`);
    assert.equal(reclaimedBody.selectedView?.sessionId, "session-medium");
    const afterReclaimBytes = await memoryBytes();
    const metricsPath = `${root}/artifacts/verification/agent-ui-capacity-20260925`;
    await mkdir(metricsPath, { recursive: true });
    await writeFile(`${metricsPath}/metrics.json`, JSON.stringify({
      capturedAt: new Date().toISOString(),
      coldStart,
      historyPolicy: "complete-history",
      longLoads,
      replayTextBytes: 20 * 16 * 1024,
      slowStreamEvidence,
      attempts: 12,
      containerMemoryBytes: capacityMemoryBytes,
      mediumLoads,
      mediumResults,
      mediumMemoryBytes,
      liveResults,
      continuedMemoryBytes,
      oversizedDelivery,
      reclamation: { beforeBytes: beforeReclaimBytes, afterBytes: afterReclaimBytes,
        replacementOwners: 20, recoveredStatus: reclaimedResponse.status },
    }, null, 2) + "\n");
    const catalogResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/sessions?cursor=old-page`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
    assert.deepEqual(catalog, {
      items: [{ sessionId: "session-1", title: "First", updatedAt: null, activeOperationId: null }],
      nextCursor: "next-page",
    });
    const createResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/sessions`, {
      method: "POST",
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 201, JSON.stringify(created));
    assert.deepEqual(created, { sessionId: "session-2" });
    assert.ok(seen.some(({ path }) => path === "/v1/acp"));
    assert.ok(seen.some(({ path, headers }) => path === "/v1/acp" &&
      new RegExp(`^00-${gatewayTraceId}-[a-f0-9]{16}-01$`).test(headers.traceparent ?? "")),
    "ACP initialization must continue the active Bridge HTTP trace");
    for (const { headers } of seen.filter(({ path }) => path !== "/rpc/agent-controller/list-workspace-agents")) {
      assert.equal(headers["x-antnest-organization-id"], "org-1");
      assert.match(headers["x-antnest-principal-id"] ?? "",
        /^user-(?:\d+|replacement-\d+|after-reclaim)$/);
      assert.equal(headers["x-antnest-agent-id"], "agent-1");
      assert.equal(headers.cookie, undefined);
    }
    await docker([
      "run", "-d", "--name", idleContainer,
      "--add-host", "host.docker.internal:host-gateway",
      "-p", "127.0.0.1::8080",
      "-e", `ANTNEST_AGENT_ACP_SERVICE_URL=http://host.docker.internal:${fixtureAddress.port}`,
      "-e", `ANTNEST_AGENT_CONTROLLER_URL=http://host.docker.internal:${fixtureAddress.port}`,
      "-e", "ANTNEST_AGENT_UI_BRIDGE_IDLE_MS=100",
      "-e", "ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS=50",
      image,
    ]);
    const idlePortOutput = await docker(["port", idleContainer, "8080/tcp"]);
    const idlePort = Number(idlePortOutput.stdout.trim().split(":").at(-1));
    assert.ok(Number.isSafeInteger(idlePort) && idlePort > 0);
    const idleBase = `http://127.0.0.1:${idlePort}`;
    let idleReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        idleReady = (await fetch(`${idleBase}/status`, {
          signal: AbortSignal.any([AbortSignal.timeout(500), interrupted.signal]),
        })).ok;
      } catch {}
      interrupted.signal.throwIfAborted();
      if (idleReady) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(idleReady, true, "Idle Bridge container did not become ready");
    const idleView = async () => {
      const result = await fetch(`${idleBase}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-idle",
          "x-antnest-agent-id": "agent-1",
        },
        signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
      });
      const body = await result.json();
      assert.equal(result.status, 200, JSON.stringify(body));
      assert.equal(body.selectedView?.sessionId, "session-medium");
      assert.ok(body.selectedView.incarnation);
      return body.selectedView.incarnation;
    };
    const initialIncarnation = await idleView();
    let replacementIncarnation;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      replacementIncarnation = await idleView();
      if (replacementIncarnation !== initialIncarnation) break;
    }
    assert.notEqual(replacementIncarnation, initialIncarnation,
      "Production Bridge must retire an idle owner and rebuild its readable Session");
    const stopStartedAt = performance.now();
    await docker(["stop", "-t", "30", container], 45_000);
    const stopDurationMs = performance.now() - stopStartedAt;
    const { stdout: exitCode } = await docker(["inspect", "-f", "{{.State.ExitCode}}", container]);
    const stopEvidence = `${root}/artifacts/verification/agent-ui-capacity-20260925`;
    await mkdir(stopEvidence, { recursive: true });
    await writeFile(`${stopEvidence}/normal-stop.json`,
      JSON.stringify({ stopDurationMs, exitCode: Number(exitCode.trim()), stopGraceMs: 30_000 }, null, 2) + "\n");
    assert.equal(exitCode.trim(), "0", "Bridge must exit normally after flushing telemetry");
    assert.ok(stopDurationMs < 30_000,
      `Bridge normal stop must finish within the 30 s container grace: ${stopDurationMs} ms`);
    for (const path of ["/v1/traces", "/v1/metrics"])
      assert.ok(telemetryRequests.some((item) => item.path === path && item.bytes > 0),
        `Production Bridge did not export ${path} during normal stop: ${JSON.stringify(telemetryRequests)}`);
    const exportedSpans = telemetryRequests.filter((item) => item.path === "/v1/traces")
      .flatMap((item) => JSON.parse(item.body).resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans)));
    assert.ok(exportedSpans.some((span) => span.traceId === gatewayTraceId &&
      span.parentSpanId === gatewayParentSpanId),
    "Production Bridge HTTP span must continue the incoming Gateway trace context");
    const exportedMetrics = telemetryRequests.filter((item) => item.path === "/v1/metrics")
      .flatMap((item) => JSON.parse(item.body).resourceMetrics.flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) => scope.metrics)));
    const gaugeValues = (name) => exportedMetrics.filter((metric) => metric.name === name)
      .flatMap((metric) => metric.gauge?.dataPoints ?? [])
      .map((point) => Number(point.asInt ?? point.asDouble));
    assert.ok(gaugeValues("antnest.ui.bridge.owners").some((value) => value > 0),
      "Production Bridge must export a live owner count");
    assert.ok(gaugeValues("antnest.ui.bridge.cached_history_bytes").some((value) => value > 0),
      "Production Bridge must export retained history bytes");
    assert.ok(gaugeValues("antnest.ui.bridge.stream_subscribers").length > 0);
    assert.ok(gaugeValues("antnest.ui.bridge.journal_queued_bytes").length > 0);
    assert.ok(gaugeValues("antnest.ui.bridge.journal_retained_bytes").length > 0);
    assert.ok(gaugeValues("antnest.ui.bridge.active_replays").length > 0);
    assert.ok(gaugeValues("antnest.ui.bridge.queued_replays").length > 0);
    assert.ok(gaugeValues("antnest.ui.bridge.uncertain_operations").length > 0);
    assert.ok(gaugeValues("antnest.ui.bridge.oldest_uncertain_ms").length > 0);
    const coldReplaySamples = exportedMetrics
      .filter((metric) => metric.name === "antnest.ui.bridge.cold_replay_duration")
      .flatMap((metric) => metric.histogram?.dataPoints ?? []);
    assert.ok(coldReplaySamples.some((point) => Number(point.count ?? point.countValue) > 0 &&
      point.attributes?.some((attribute) => attribute.key === "outcome" &&
        attribute.value?.stringValue === "success")),
    "Production Bridge must export a successful cold Session replay duration");
    assert.ok(gaugeValues("antnest.ui.process.heap_used_bytes").some((value) => value > 0));
    assert.ok(gaugeValues("antnest.ui.process.rss_bytes").some((value) => value > 0));
  } catch (error) {
    const diagnostics = `${root}/artifacts/verification/agent-ui-capacity-20260925`;
    await mkdir(diagnostics, { recursive: true });
    const logs = await docker(["logs", "--tail", "200", container], 30_000)
      .then(({ stdout, stderr }) => stdout + stderr).catch(() => "");
    await writeFile(`${diagnostics}/failure-container.log`, logs);
    await writeFile(`${diagnostics}/failure-fixture.json`, JSON.stringify({
      longLoads, longNotifications, longFailures, mediumLoads,
      mediumWatermarks: Object.fromEntries(mediumWatermarks),
      capacityMemoryBytes,
      telemetryRequests,
      requestPaths: seen.map(({ path }) => path),
    }, null, 2) + "\n");
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await cleanup();
  }
});
