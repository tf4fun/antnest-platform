import assert from "node:assert/strict";
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

test("Bridge production container connects to official ACP HTTP and serves a selected view", { timeout: 240_000 }, async () => {
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
  let longLoads = 0;
  let mediumLoads = 0;
  const mediumClients = [];
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
      assert(["session-1", "session-long", "session-medium"].includes(params.sessionId));
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
            update: { sessionUpdate: "agent_message_chunk", messageId: `answer-${index}`,
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
      if (params.sessionId === "session-medium") {
        mediumLoads++;
        mediumClients.push(client);
        for (let index = 0; index < 8; index++)
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", messageId: `medium-${index}`,
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
          : params.sessionId === "session-medium" ? 9 : session1Watermark,
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
      acpHandler(request, response);
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
      request.url === "/rpc/agent-acp/workspace/sessions/session-medium/execution") {
      response.end(JSON.stringify({
        sessionId: request.url.split("/").at(-2),
        appendVersion: 1, outputWatermark: request.url.includes("session-long") ? 21
          : request.url.includes("session-medium")
            ? mediumWatermarks.get(request.headers["x-antnest-principal-id"]) ?? 9
            : session1Watermark,
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
      "-e", "ANTNEST_AGENT_UI_BRIDGE_SESSION_HISTORY_BYTES=262144",
      "-e", "ANTNEST_AGENT_UI_BRIDGE_CACHE_BYTES=524288",
      "-e", "ANTNEST_AGENT_UI_BRIDGE_TOTAL_HISTORY_BYTES=1048576",
      "-e", "ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS=16",
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
    const streamUpdates = 3000;
    const finalStreamWatermark = streamUpdates;
    let slowStreamBytes = 0;
    let slowFrames = "";
    const slowTimer = setInterval(() => {
      const chunk = slowResponse.read(1024);
      if (chunk) {
        slowStreamBytes += chunk.length;
        slowFrames += chunk.toString("utf8");
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
      let fastFrames = "";
      let latestFastWatermark = 0;
      const fastReads = (async () => {
        for (;;) {
          const next = await fastReader.read();
          if (next.done) return false;
          fastFrames += new TextDecoder().decode(next.value);
          const mark = fastFrames.lastIndexOf('"outputWatermark":');
          if (mark >= 0) {
            const value = fastFrames.slice(mark + '"outputWatermark":'.length).match(/^\d+/);
            if (value) latestFastWatermark = Math.max(latestFastWatermark, Number(value[0]));
          }
          if (latestFastWatermark >= finalStreamWatermark) return true;
          if (fastFrames.length > 256 * 1024) fastFrames = fastFrames.slice(-128 * 1024);
        }
      })();
      const beforeStreamBytes = await memoryBytes();
      for (let index = 1; index <= streamUpdates; index++) {
        const sequence = index;
        session1Watermark = sequence;
        await session1Client.notify(acp.methods.client.session.update, {
          sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", messageId: `stream-${sequence}`,
            content: { type: "text", text: "s".repeat(8 * 1024) } },
          _meta: { "antnest.dev/delivery": { kind: "part", sequence,
            partIndex: 0, partCount: 1, runId: "run-stream",
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
        slowFrames += chunk.toString("utf8");
      });
      slowResponse.resume();
      for (let attempt = 0; attempt < 200 &&
        !slowFrames.includes(`"outputWatermark":${finalStreamWatermark}`); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(slowFrames.includes(`"outputWatermark":${finalStreamWatermark}`),
        "A slow production SSE observer must recover the latest ACP watermark");
      const revisions = [...slowFrames.matchAll(/"toStreamRevision":(\d+)/g)]
        .map((match) => Number(match[1]));
      assert.ok(revisions.some((revision, index) => index > 0 &&
        revision - revisions[index - 1] > 1),
      `A slow production observer should coalesce missed resets: ${revisions.length} frames, ${slowStreamBytes} bytes`);
      slowStreamEvidence = { updates: streamUpdates, slowStreamBytes,
        observedFrames: revisions.length,
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
    assert.ok(slowStreamEvidence.afterDisconnectBytes - slowStreamEvidence.beforeStreamBytes <
      64 * 1024 * 1024,
    `Production SSE retained memory after disconnect: ${JSON.stringify(slowStreamEvidence)}`);
    const metadataAfterLimit = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`, {
      headers: streamHeaders,
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(metadataAfterLimit.status, 200);
    const limitedMetadata = (await metadataAfterLimit.json()).selectedView;
    assert.equal(limitedMetadata.title, "Fixture session title");
    assert.equal(limitedMetadata.updatedAt, "2026-09-24T00:00:00Z");
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
      assert.equal(longResponse.status, 429,
        `long replay attempt ${attempt + 1}: ${longBody.code}`);
      assert.equal(longBody.code, "history_capacity_exceeded");
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
      if (mediumResponse.status === 429) {
        assert.equal(body.code, "history_capacity_exceeded");
        break;
      }
      assert.equal(mediumResponse.status, 200, JSON.stringify(body));
      assert.equal(body.selectedView?.sessionId, "session-medium");
    }
    assert.ok(mediumResults.filter(({ status }) => status === 200).length >= 3,
      "Several independent owners should retain their histories");
    assert.equal(mediumResults.at(-1)?.status, 429,
      `Global history budget did not reject a scope: ${JSON.stringify(mediumResults)}`);
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
      "Global overload must preserve an existing owner's readable Session");
    assert.ok(Math.max(...mediumMemoryBytes) - mediumMemoryBytes[0] < 64 * 1024 * 1024,
      "Retained multi-owner history must not cause unbounded container growth");
    const activeOwners = mediumResults.filter(({ status }) => status === 200)
      .map(({ principalId }) => principalId);
    assert.ok(mediumClients.length >= activeOwners.length);
    mediumLive = true;
    const liveResults = [];
    let limitedLiveOwner;
    for (let round = 0; round < 14 && !limitedLiveOwner; round++) {
      for (let index = 0; index < activeOwners.length; index++) {
        const principalId = activeOwners[index];
        const sequence = (mediumWatermarks.get(principalId) ?? 9) + 1;
        mediumWatermarks.set(principalId, sequence);
        await mediumClients[index].notify(acp.methods.client.session.update, {
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
        if (liveBody.selectedView?.historyState === "view_limited") {
          assert.equal(liveResponse.status, 200);
          assert.equal(liveBody.selectedView.outputWatermark, sequence);
          assert.equal(liveBody.selectedView.historyToken, null);
          assert.deepEqual(liveBody.selectedView.turns, []);
          assert.equal(liveBody.selectedView.limitedPreview.truncated, true);
          assert.ok(liveBody.selectedView.limitedPreview.text.length <= 4096);
          limitedLiveOwner = principalId;
          break;
        }
        assert.equal(liveResponse.status, 200, JSON.stringify(liveBody));
      }
    }
    assert.ok(limitedLiveOwner,
      `Active output did not reach global capacity: ${JSON.stringify(liveResults)}`);
    assert.ok((mediumWatermarks.get(limitedLiveOwner) ?? 0) < 24,
      "The global budget must limit output before a Session reaches its own 256 KiB limit");
    const survivingOwner = activeOwners.find((principalId) => principalId !== limitedLiveOwner);
    const survivingResponse = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": survivingOwner,
        "x-antnest-agent-id": "agent-1",
      },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    assert.equal(survivingResponse.status, 200,
      "Global active-output overload must preserve another owner's running View");
    const limitedMemoryBytes = [await memoryBytes()];
    const limitedClient = mediumClients[activeOwners.indexOf(limitedLiveOwner)];
    for (let index = 0; index < 24; index++) {
      const sequence = (mediumWatermarks.get(limitedLiveOwner) ?? 9) + 1;
      mediumWatermarks.set(limitedLiveOwner, sequence);
      await limitedClient.notify(acp.methods.client.session.update, {
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
        "x-antnest-principal-id": limitedLiveOwner,
        "x-antnest-agent-id": "agent-1" },
      signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
    });
    const continuedBody = await continuedResponse.json();
    assert.equal(continuedResponse.status, 200);
    assert.equal(continuedBody.selectedView?.historyState, "view_limited");
    assert.equal(continuedBody.selectedView?.outputWatermark,
      mediumWatermarks.get(limitedLiveOwner));
    assert.equal(continuedBody.selectedView?.limitedPreview.text, "b".repeat(4096));
    limitedMemoryBytes.push(await memoryBytes());
    assert.ok(limitedMemoryBytes[1] - limitedMemoryBytes[0] < 64 * 1024 * 1024,
      `Limited-output memory samples: ${JSON.stringify(limitedMemoryBytes)}`);
    mediumMemoryBytes.push(await memoryBytes());
    assert.ok(Math.max(...mediumMemoryBytes) - mediumMemoryBytes[0] < 64 * 1024 * 1024,
      `Active-output memory samples: ${JSON.stringify(mediumMemoryBytes)}`);
    const oversizedBeforeBytes = await memoryBytes();
    const oversizedSequence = (mediumWatermarks.get(limitedLiveOwner) ?? 0) + 1;
    mediumWatermarks.set(limitedLiveOwner, oversizedSequence);
    await limitedClient.notify(acp.methods.client.session.update, {
      sessionId: "session-medium",
      update: { sessionUpdate: "agent_message_chunk", messageId: `live-${oversizedSequence}`,
        content: { type: "text", text: "c".repeat(17 * 1024 * 1024) } },
      _meta: { "antnest.dev/delivery": { kind: "part", sequence: oversizedSequence,
        partIndex: 0, partCount: 1, runId: "run-medium",
        messageId: `live-event-${oversizedSequence}` } },
    });
    let oversizedView;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await fetch(`${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`, {
        headers: { "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": limitedLiveOwner,
          "x-antnest-agent-id": "agent-1" },
        signal: AbortSignal.any([AbortSignal.timeout(10_000), interrupted.signal]),
      });
      assert.equal(response.status, 200);
      oversizedView = await response.json();
      if (oversizedView.selectedView?.outputWatermark === oversizedSequence) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(oversizedView?.selectedView?.historyState, "view_limited");
    assert.equal(oversizedView?.selectedView?.outputWatermark, oversizedSequence);
    assert.equal(oversizedView?.selectedView?.limitedPreview.text, "c".repeat(4096));
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
      `Cold owner eviction must release global history budget: ${JSON.stringify(reclaimedBody)}`);
    assert.equal(reclaimedBody.selectedView?.sessionId, "session-medium");
    const afterReclaimBytes = await memoryBytes();
    const metricsPath = `${root}/artifacts/verification/agent-ui-capacity-20260923`;
    await mkdir(metricsPath, { recursive: true });
    await writeFile(`${metricsPath}/metrics.json`, JSON.stringify({
      capturedAt: new Date().toISOString(),
      coldStart,
      sessionHistoryLimitBytes: 262144,
      replayTextBytes: 20 * 16 * 1024,
      slowStreamEvidence,
      attempts: 12,
      containerMemoryBytes: capacityMemoryBytes,
      mediumLoads,
      mediumResults,
      mediumMemoryBytes,
      liveResults,
      limitedMemoryBytes,
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
    await docker(["stop", "-t", "30", container], 45_000);
    const { stdout: exitCode } = await docker(["inspect", "-f", "{{.State.ExitCode}}", container]);
    assert.equal(exitCode.trim(), "0", "Bridge must exit normally after flushing telemetry");
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
    const diagnostics = `${root}/artifacts/verification/agent-ui-capacity-20260923`;
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
