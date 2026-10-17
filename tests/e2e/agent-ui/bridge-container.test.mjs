import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  agentStreamObserver,
  readTurnContent as readContent,
} from "../../support/agent-ui/bridge-protocol.mjs";
import { verifyExternalIdentitiesBrowser } from "../../support/agent-ui/external-identities-browser.mjs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  testFetch,
  testHeaders,
  testJwks,
  dockerAuthenticationArgs,
  authenticateFixtureRequest,
  testContext,
  workloadHeaders,
} from "./auth-fixture.mjs";
import {
  bridgeOwnerLabel,
  finishBridgeCase,
  openPausedResponse,
  ownFixtureServer,
  removeBridgeDocker,
  runJoined,
  startBridgePump,
} from "../../support/agent-ui/bridge-container-lifecycle.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const fromUi = createRequire(
  new URL("../../../services/agent-ui/web/package.json", import.meta.url),
);
const acp = await import(fromUi.resolve("@agentclientprotocol/sdk"));
const { AcpServer } = await import(
  fromUi.resolve("@agentclientprotocol/sdk/experimental/server")
);
const { createNodeHttpHandler } = await import(
  fromUi.resolve("@agentclientprotocol/sdk/experimental/node")
);
const dockerSoak = process.env.ANTNEST_UI_DOCKER_SOAK === "1";

function processResourceIdentity(requests, hostname) {
  const identities = new Set();
  for (const [path, key] of [
    ["/v1/traces", "resourceSpans"],
    ["/v1/metrics", "resourceMetrics"],
  ]) {
    const exports = requests.filter((item) => item.path === path);
    assert(exports.length > 0, `Missing production export ${path}`);
    for (const item of exports) {
      const groups = JSON.parse(item.body)[key];
      assert(groups.length > 0, `Missing production resource ${path}`);
      for (const group of groups) {
        const attributes = Object.fromEntries(
          group.resource.attributes.map((entry) => [
            entry.key,
            entry.value.stringValue ?? Number(entry.value.intValue),
          ]),
        );
        assert.equal(attributes["service.name"], "agent-ui");
        assert.equal(attributes["host.name"], hostname);
        assert.equal(attributes["process.pid"], 1);
        assert.match(
          attributes["service.instance.id"] ?? "",
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        );
        assert.equal(
          attributes["deployment.environment.name"],
          "ui-process-generation-test",
        );
        identities.add(attributes["service.instance.id"]);
      }
    }
  }
  assert.equal(
    identities.size,
    1,
    "Trace and metrics share one process generation",
  );
  return [...identities][0];
}

async function inspectContainerMemory(container, docker) {
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
  const { stdout } = await docker(
    ["exec", container, "node", "--input-type=module", "-e", code],
    20_000,
  );
  return JSON.parse(stdout);
}

test(
  "Bridge production container connects to official ACP HTTP and serves a selected view",
  { timeout: 600_000 },
  async (t) => {
    const suffix = randomUUID().slice(0, 12);
    const evidenceRoot = `${root}/artifacts/verification/agent-ui-service-authentication-${suffix}`;
    const image = `antnest-agent-ui-bridge-e2e:${suffix}`;
    const container = `antnest-agent-ui-bridge-e2e-${suffix}`;
    const idleContainer = `${container}-idle`;
    const interrupted = new AbortController();
    const signal = AbortSignal.any([t.signal, interrupted.signal]);
    signal.throwIfAborted();
    const docker = (args, timeout = 180_000) =>
      runJoined("docker", args, { cwd: root, timeout, signal });
    const cleanupDocker = (args, timeout = 30_000) =>
      runJoined("docker", args, { cwd: root, timeout });
    const requestOptions = (options = {}) => ({
      ...options,
      signal: AbortSignal.any([
        signal,
        options.signal ?? AbortSignal.timeout(10_000),
      ]),
    });
    const fetch = (url, options) => testFetch(url, requestOptions(options));
    const nativeFetch = (url, options) =>
      globalThis.fetch(url, requestOptions(options));
    const readTurnContent = (base, sessionId, turn, headers, requestSignal) =>
      readContent(
        base,
        sessionId,
        turn,
        testHeaders(headers),
        requestOptions({ signal: requestSignal }).signal,
      );
    const sleep = (ms) => delay(ms, undefined, { signal });
    const interrupt = (code) => {
      process.exitCode = code;
      interrupted.abort(new Error("Bridge container test interrupted"));
    };
    const onInterrupt = () => interrupt(130);
    const onTerminate = () => interrupt(143);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const seen = [];
    const telemetryRequests = [];
    const initializedConnections = new Map();
    const cleanupReceipts = [];
    let holdCleanup = false,
      heldCleanup;
    let cleanupStarted, releaseCleanup;
    const cleanupHeld = new Promise((resolve) => {
      cleanupStarted = resolve;
    });
    const cleanupRelease = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    signal.addEventListener("abort", releaseCleanup, { once: true });
    const revocationTraceId = "0987654321abcdef0987654321abcdef";
    let revocationWatch,
      revocationDelegation,
      revocationSentAt,
      revocationClosedAt;
    const gatewayTraceId = "0123456789abcdef0123456789abcdef";
    const gatewayParentSpanId = "1111111111111111";
    const controllerCalls = [];
    let accountOnly = false;
    let session1Client;
    let session1Watermark = 0;
    let memoryClient;
    let memoryWatermark = 0;
    let longLoads = 0;
    let mediumLoads = 0;
    const requestPrincipal = new AsyncLocalStorage();
    const mediumClients = new Map();
    const mediumWatermarks = new Map();
    const mediumHistory = new Map();
    const publishMedium = async (principalId, text) => {
      const sequence = (mediumWatermarks.get(principalId) ?? 9) + 1;
      const params = {
        sessionId: "session-medium",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: `live-${sequence}`,
          content: { type: "text", text },
        },
        _meta: {
          "antnest.dev/delivery": {
            kind: "part",
            sequence,
            partIndex: 0,
            partCount: 1,
            runId: "run-medium",
            messageId: `live-event-${sequence}`,
          },
        },
      };
      const history = mediumHistory.get(principalId) ?? [];
      history.push(params);
      mediumHistory.set(principalId, history);
      // The execution endpoint may be observed before SSE delivery. Every
      // advertised event must already be available to a concurrent replay.
      mediumWatermarks.set(principalId, sequence);
      await mediumClients
        .get(principalId)
        .notify(acp.methods.client.session.update, params);
      return sequence;
    };
    let mediumLive = false;
    const capacityMemoryBytes = [];
    let longNotifications = 0;
    const longFailures = [];
    const commandMutations = { prompts: 0, sessions: 0 };
    const agent = acp
      .agent({ name: "bridge-container-fixture" })
      .onRequest(acp.methods.agent.initialize, ({ params }) => {
        assert.equal(params._meta?.["antnest.dev/bridge"]?.deliveryMark, 1);
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {} },
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
          },
          _meta: {
            "antnest.dev/bridge": {
              intentReceipt: 1,
              targetCancel: 1,
              deliveryMark: 1,
            },
          },
        };
      })
      .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
        let mediumCut = 9;
        assert(
          [
            "session-1",
            "session-long",
            "session-medium",
            "session-memory",
          ].includes(params.sessionId),
        );
        if (params.sessionId === "session-1") {
          session1Client = client;
          await client.notify(acp.methods.client.session.update, {
            sessionId: "session-1",
            update: {
              sessionUpdate: "session_info_update",
              title: "Fixture session title",
              updatedAt: "2026-09-24T00:00:00Z",
            },
          });
        }
        if (params.sessionId === "session-long") {
          longLoads++;
          for (let index = 0; index < 20; index++) {
            try {
              await client.notify(acp.methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  messageId: "long-answer",
                  content: { type: "text", text: "x".repeat(16 * 1024) },
                },
                _meta: {
                  "antnest.dev/delivery": {
                    kind: "part",
                    sequence: index + 1,
                    partIndex: 0,
                    partCount: 1,
                    runId: "run-long",
                    messageId: `event-${index}`,
                  },
                },
              });
              longNotifications++;
            } catch (error) {
              longFailures.push({ index, message: error.message });
              throw error;
            }
          }
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [],
            },
            _meta: {
              "antnest.dev/delivery": { kind: "checkpoint", sequence: 21 },
            },
          });
        }
        if (params.sessionId === "session-memory") memoryClient = client;
        if (params.sessionId === "session-medium") {
          mediumLoads++;
          const principalId = requestPrincipal.getStore();
          assert.equal(typeof principalId, "string");
          mediumClients.set(principalId, client);
          const liveHistory = [...(mediumHistory.get(principalId) ?? [])];
          mediumCut = mediumWatermarks.get(principalId) ?? 9;
          for (let index = 0; index < 8; index++)
            await client.notify(acp.methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "medium-answer",
                content: { type: "text", text: "m".repeat(16 * 1024) },
              },
              _meta: {
                "antnest.dev/delivery": {
                  kind: "part",
                  sequence: index + 1,
                  partIndex: 0,
                  partCount: 1,
                  runId: "run-medium",
                  messageId: `medium-event-${index}`,
                },
              },
            });
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [],
            },
            _meta: {
              "antnest.dev/delivery": { kind: "checkpoint", sequence: 9 },
            },
          });
          for (const notification of liveHistory)
            await client.notify(
              acp.methods.client.session.update,
              notification,
            );
        }
        return {
          _meta: {
            "antnest.dev/delivery": {
              sealedWatermark:
                params.sessionId === "session-long"
                  ? 21
                  : params.sessionId === "session-medium"
                    ? mediumCut
                    : params.sessionId === "session-memory"
                      ? memoryWatermark
                      : session1Watermark,
              appendVersion: 1,
            },
          },
        };
      })
      .onRequest(acp.methods.agent.session.list, ({ params }) => {
        assert.ok(params.cursor === undefined || params.cursor === "old-page");
        return {
          sessions: [
            { sessionId: "session-1", cwd: "/workspace", title: "First" },
          ],
          nextCursor: "next-page",
        };
      })
      .onRequest(acp.methods.agent.session.new, ({ params }) => {
        commandMutations.sessions++;
        assert.equal(params.cwd, "/workspace");
        assert.deepEqual(params.mcpServers, []);
        return { sessionId: "session-2" };
      })
      .onRequest(acp.methods.agent.session.prompt, () => {
        commandMutations.prompts++;
        throw new Error("Controls must never dispatch a model prompt");
      });
    const transport = new AcpServer({ agent });
    let transportClosing;
    const closeTransport = () => (transportClosing ??= transport.close());
    const stopTransport = () => {
      void closeTransport().catch(() => {});
    };
    signal.addEventListener("abort", stopTransport, { once: true });
    const acpHandler = createNodeHttpHandler(transport);
    const verifiedScopes = new WeakMap();
    const fixture = createServer((request, response) => {
      if (request.url === "/v1/traces" || request.url === "/v1/metrics") {
        const chunks = [];
        request.on("data", (chunk) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          const body = Buffer.concat(chunks);
          telemetryRequests.push({
            path: request.url,
            bytes: body.length,
            body: body.toString("utf8"),
          });
          response.writeHead(200).end();
        });
        return;
      }
      seen.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        claims: verifiedScopes.get(request),
      });
      if (request.url === "/rpc/agent-controller/list-workspace-agents") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          controllerCalls.push(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              agents: accountOnly
                ? []
                : [
                    {
                      agent_id: "agent-1",
                      name: "Research",
                      lifecycle_state: "created",
                      activation_state: "enabled",
                      runtime_state: "available",
                    },
                  ],
              next_cursor: null,
            }),
          );
        });
        return;
      }
      if (request.url === "/v1/acp") {
        if (
          request.method === "POST" &&
          !request.headers["acp-connection-id"]
        ) {
          response.once("finish", () => {
            const connectionId = response.getHeader("acp-connection-id");
            if (typeof connectionId === "string")
              initializedConnections.set(
                connectionId,
                request.headers.traceparent,
              );
          });
        }
        if (request.method === "DELETE") {
          const receipt = {
            connectionId: request.headers["acp-connection-id"],
            traceparent: request.headers.traceparent,
            complete: false,
          };
          cleanupReceipts.push(receipt);
          response.once("finish", () => {
            receipt.complete = true;
          });
          if (
            holdCleanup &&
            verifiedScopes.get(request)?.sub === "user-9876" &&
            verifiedScopes.get(request)?.agt === "agent-1"
          ) {
            heldCleanup = receipt;
            const flush = response.flushHeaders.bind(response);
            response.flushHeaders = () => {
              // The SDK flushes before calling end(), so framing must be set
              // here, while headers are still mutable.
              if (!response.headersSent) {
                response.removeHeader("content-length");
                response.setHeader("transfer-encoding", "chunked");
              }
              return flush();
            };
            const end = response.end.bind(response);
            response.end = (...args) => {
              response.end = end;
              receipt.status = response.statusCode;
              // The real SDK closes its connection and supplies the 202 status.
              // Keep that response body open after headers reach the container.
              response.flushHeaders();
              response.write(" ");
              cleanupStarted();
              void cleanupRelease.then(() => end(...args));
              return response;
            };
          }
        }
        requestPrincipal.run(verifiedScopes.get(request)?.sub, () => {
          acpHandler(request, response);
        });
        return;
      }
      if (
        request.url === "/rpc/agent-acp/watch-agent-execution-state" &&
        verifiedScopes.get(request)?.sub === "user-9876"
      ) {
        revocationWatch = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `event: workspace_state\ndata: ${JSON.stringify({
            agent_id: "agent-1",
            access_allowed: true,
            availability: "ready",
            active_session_id: null,
            configuration_revision: "a".repeat(64),
            unavailable_reason: null,
          })}\n\n`,
        );
        return;
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/rpc/agent-acp/get-agent-execution-state") {
        response.end(
          JSON.stringify({
            agent_id: "agent-1",
            access_allowed: true,
            availability: mediumLive ? "busy" : "ready",
            active_session_id: mediumLive ? "session-medium" : null,
            configuration_revision: "a".repeat(64),
            unavailable_reason: null,
          }),
        );
        return;
      }
      if (
        request.url ===
          "/rpc/agent-acp/workspace/sessions/session-1/execution" ||
        request.url ===
          "/rpc/agent-acp/workspace/sessions/session-long/execution" ||
        request.url ===
          "/rpc/agent-acp/workspace/sessions/session-medium/execution" ||
        request.url ===
          "/rpc/agent-acp/workspace/sessions/session-memory/execution"
      ) {
        response.end(
          JSON.stringify({
            sessionId: request.url.split("/").at(-2),
            appendVersion: 1,
            outputWatermark: request.url.includes("session-long")
              ? 21
              : request.url.includes("session-medium")
                ? (mediumWatermarks.get(verifiedScopes.get(request)?.sub) ?? 9)
                : request.url.includes("session-memory")
                  ? memoryWatermark
                  : session1Watermark,
            activeRunId:
              mediumLive && request.url.includes("session-medium")
                ? "run-medium"
                : null,
            recentReceipts: [],
            configurationRevision: null,
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: "not_found" }));
    });
    const handler = fixture.listeners("request")[0];
    fixture.removeAllListeners("request");
    const authenticatedHandler = (receiver) => (request, response) => {
      if (
        receiver === "agent-acp-service" &&
        ["/v1/traces", "/v1/metrics"].includes(request.url)
      ) {
        handler(request, response);
        return;
      }
      void authenticateFixtureRequest(request, receiver)
        .then((claims) => {
          verifiedScopes.set(request, claims);
          if (receiver === "identity-service") {
            if (request.url !== "/rpc/identity/jwks") {
              response.writeHead(404).end();
              return;
            }
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(testJwks));
          } else handler(request, response);
        })
        .catch(() =>
          response
            .writeHead(401)
            .end(JSON.stringify({ code: "fixture_rejected" })),
        );
    };
    fixture.on("request", authenticatedHandler("agent-acp-service"));
    const controllerFixture = createServer(
      authenticatedHandler("agent-controller"),
    );
    const identityFixture = createServer(
      authenticatedHandler("identity-service"),
    );
    const fixtures = [fixture, controllerFixture, identityFixture].map(
      (server) => ownFixtureServer(server, signal),
    );
    await finishBridgeCase({
      body: async () => {
        for (const server of fixtures) await server.listen();
        const fixtureAddress = fixture.address();
        assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
        await docker([
          "build",
          "--label",
          `${bridgeOwnerLabel}=${suffix}`,
          "-f",
          "services/agent-ui/Dockerfile",
          "-t",
          image,
          ".",
        ]);
        const launchStartedAt = performance.now();
        await docker([
          "run",
          "-d",
          "--name",
          container,
          "--label",
          `${bridgeOwnerLabel}=${suffix}`,
          ...dockerAuthenticationArgs(),
          "-e",
          `ANTNEST_AGENT_UI_IDENTITY_URL=http://host.docker.internal:${identityFixture.address().port}`,
          "--add-host",
          "host.docker.internal:host-gateway",
          "-p",
          "127.0.0.1::8080",
          "-e",
          `ANTNEST_AGENT_ACP_SERVICE_URL=http://host.docker.internal:${fixtureAddress.port}`,
          "-e",
          `ANTNEST_AGENT_CONTROLLER_URL=http://host.docker.internal:${controllerFixture.address().port}`,
          "-e",
          `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:${fixtureAddress.port}`,
          "-e",
          "OTEL_SERVICE_NAME=agent-ui",
          "-e",
          "OTEL_RESOURCE_ATTRIBUTES=service.instance.id=environment-instance,host.name=environment-host,process.pid=999999999,deployment.environment.name=ui-process-generation-test",
          "-e",
          "OTEL_SDK_DISABLED=false",
          "-e",
          "ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS=16",
          "-e",
          "ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS=1000",
          "-e",
          "ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES=1024",
          image,
        ]);
        const { stdout: hostnameOutput } = await docker([
          "inspect",
          "-f",
          "{{.Config.Hostname}}",
          container,
        ]);
        const hostname = hostnameOutput.trim();
        assert(hostname.length > 0);
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
            response = await fetch(`${base}/workspace/agent-1/`, {
              headers: {
                "x-antnest-organization-id": "org-1",
                "x-antnest-principal-id": "user-1",
                "x-antnest-administrator": "false",
                "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
                "x-antnest-organization-name": "RW5naW5lZXJpbmc",
              },
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            });
          } catch {
            signal.throwIfAborted();
          }
          if (response) {
            assert.equal(
              response.status,
              200,
              "Cold authenticated SSR request failed",
            );
            coldDocumentHtml = await response.text();
            assert.match(coldDocumentHtml, /Research/);
            break;
          }
          await sleep(100);
        }
        assert.ok(
          coldDocumentHtml,
          "Cold authenticated SSR document did not become available",
        );
        const coldStart = {
          containerLaunchToPortResolvedMs: Math.round(portResolvedMs),
          containerLaunchToAuthenticatedHtmlCompleteMs: Math.round(
            performance.now() - launchStartedAt,
          ),
          requestAttempts: coldAttempts,
        };
        const coldEvidencePath = `${evidenceRoot}/cold-start`;
        await mkdir(coldEvidencePath, { recursive: true });
        await writeFile(
          `${coldEvidencePath}/run-${Date.now()}.json`,
          JSON.stringify(
            { capturedAt: new Date().toISOString(), ...coldStart },
            null,
            2,
          ) + "\n",
        );
        assert.ok(
          coldStart.containerLaunchToAuthenticatedHtmlCompleteMs < 5_000,
          `Cold authenticated SSR took ${coldStart.containerLaunchToAuthenticatedHtmlCompleteMs} ms`,
        );
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            ready = (
              await fetch(`${base}/status`, {
                signal: AbortSignal.any([AbortSignal.timeout(500), signal]),
              })
            ).ok;
          } catch {}
          signal.throwIfAborted();
          if (ready) break;
          await sleep(100);
        }
        assert.equal(ready, true, "Bridge container did not become ready");
        const authenticationChecks = [];
        const authorized = {
          ...workloadHeaders(),
          "Antnest-Caller-Context": testContext({ agt: "agent-1" }).token,
        };
        const beforeDenied = seen.length;
        for (const [name, headers, status, method = "GET", body] of [
          ["missing workload", {}, 401],
          [
            "forged identity headers",
            {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-agent-id": "agent-1",
              "x-antnest-administrator": "true",
            },
            401,
          ],
          ["wrong caller", workloadHeaders("admin-console"), 403],
          ["missing CCT", workloadHeaders(), 401],
          [
            "bad CCT",
            { ...workloadHeaders(), "Antnest-Caller-Context": "bad" },
            401,
          ],
          [
            "foreign Agent",
            {
              ...workloadHeaders(),
              "Antnest-Caller-Context": testContext({ agt: "other" }).token,
            },
            401,
          ],
          [
            "foreign audience",
            {
              ...workloadHeaders(),
              "Antnest-Caller-Context": testContext({
                agt: "agent-1",
                aud: ["agent-acp-service"],
              }).token,
            },
            401,
          ],
          [
            "expired CCT",
            {
              ...workloadHeaders(),
              "Antnest-Caller-Context": testContext({
                agt: "agent-1",
                iat: 1,
                exp: 61,
              }).token,
            },
            401,
          ],
          [
            "wrong media",
            { ...authorized, "content-type": "text/plain" },
            415,
            "POST",
            "{}",
          ],
          [
            "duplicate JSON",
            { ...authorized, "content-type": "application/json" },
            400,
            "POST",
            '{"a":1,"\\u0061":2}',
          ],
        ]) {
          const response = await nativeFetch(
            `${base}/api/app/workspace/v1/agents/agent-1/sessions`,
            { method, headers, body, signal: AbortSignal.timeout(10000) },
          );
          assert.equal(response.status, status, name);
          await response.text();
          authenticationChecks.push(name);
        }
        for (const duplicate of [
          "Antnest-Service-Authorization",
          "Antnest-Caller-Context",
        ]) {
          const response = await new Promise((resolve, reject) => {
            const request = httpRequest(
              `${base}/api/app/workspace/v1/agents/agent-1/sessions`,
              {
                headers: [
                  "Host",
                  new URL(base).host,
                  ...Object.entries(authorized).flat(),
                  duplicate.toLowerCase(),
                  authorized[duplicate],
                ],
                signal: requestOptions().signal,
              },
              resolve,
            );
            request.once("error", reject);
            request.end();
          });
          assert.equal(response.statusCode, 401);
          for await (const chunk of response) {
            void chunk;
          }
          authenticationChecks.push(`duplicate ${duplicate}`);
        }
        assert.equal(
          seen.length,
          beforeDenied,
          "Denied requests must have no upstream effects",
        );
        assert.equal(
          (await nativeFetch(`${base}/workspace/assets/missing.js`)).status,
          401,
        );
        authenticationChecks.push("assets require workload");
        assert.equal((await nativeFetch(`${base}/live`)).status, 200);
        authenticationChecks.push("minimal unauthenticated liveness");
        await mkdir(evidenceRoot, { recursive: true });
        await writeFile(
          `${evidenceRoot}/authentication.json`,
          JSON.stringify({ checks: authenticationChecks }, null, 2) + "\n",
        );
        process.stdout.write(
          JSON.stringify({
            authentication_checks: authenticationChecks.length,
          }) + "\n",
        );
        const memoryBytes = async () => {
          const { stdout } = await docker([
            "stats",
            "--no-stream",
            "--format",
            "{{.MemUsage}}",
            container,
          ]);
          const match = stdout.trim().match(/^([\d.]+)(B|KiB|MiB|GiB)/);
          assert.ok(match, `Unexpected container memory: ${stdout.trim()}`);
          return Math.round(
            Number(match[1]) *
              1024 ** ["B", "KiB", "MiB", "GiB"].indexOf(match[2]),
          );
        };
        await docker([
          "exec",
          container,
          "test",
          "!",
          "-e",
          "/app/dist/index.html",
        ]);
        const bootstrapResponse = await fetch(
          `${base}/api/app/workspace/v1/bootstrap`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-administrator": "false",
              "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
              "x-antnest-organization-name": "RW5naW5lZXJpbmc",
              traceparent: `00-${gatewayTraceId}-${gatewayParentSpanId}-01`,
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        const bootstrap = await bootstrapResponse.json();
        assert.equal(bootstrapResponse.status, 200, JSON.stringify(bootstrap));
        assert.deepEqual(bootstrap.principal, {
          userId: "user-1",
          organizationId: "org-1",
          administrator: false,
          organizationSlug: "engineering",
          organizationName: "Engineering",
        });
        assert.equal(bootstrap.agents[0]?.agentId, "agent-1");
        assert.equal(controllerCalls[0]?.organization_id, "org-1");
        assert.equal(controllerCalls[0]?.principal_id, "user-1");
        assert.ok(
          seen.some(
            ({ path, headers }) =>
              path === "/rpc/agent-controller/list-workspace-agents" &&
              new RegExp(`^00-${gatewayTraceId}-[a-f0-9]{16}-01$`).test(
                headers.traceparent ?? "",
              ),
          ),
          "Controller discovery must continue the authenticated Bridge HTTP trace",
        );
        assert.equal((await fetch(`${base}/workspace/agent-1/`)).status, 401);
        const documentResponse = await fetch(`${base}/workspace/agent-1/`, {
          headers: {
            "x-antnest-organization-id": "org-1",
            "x-antnest-principal-id": "user-1",
            "x-antnest-administrator": "false",
            "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
            "x-antnest-organization-name": "RW5naW5lZXJpbmc",
          },
          signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
        });
        assert.equal(documentResponse.status, 200);
        assert.equal(
          documentResponse.headers.get("cache-control"),
          "private, no-store",
        );
        const html = await documentResponse.text();
        assert.match(html, /Research/);
        const clientScript = html.match(
          /src="(\/workspace\/assets\/entry-client-[^"]+\.js)"/,
        )?.[1];
        assert.ok(clientScript, "SSR document omitted its client script");
        const scriptResponse = await fetch(`${base}${clientScript}`);
        assert.equal(scriptResponse.status, 200);
        assert.match(
          scriptResponse.headers.get("content-type") ?? "",
          /javascript/,
        );
        const response = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-agent-id": "agent-1",
              traceparent: `00-${gatewayTraceId}-${gatewayParentSpanId}-01`,
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        const view = await response.json();
        assert.equal(response.status, 200, JSON.stringify(view));
        assert.equal(view.selectedView?.sessionId, "session-1");
        assert.equal(view.selectedView?.appendVersion, 1);
        assert.equal(view.selectedView?.title, "Fixture session title");
        assert.equal(view.selectedView?.updatedAt, "2026-09-24T00:00:00Z");
        const commandHeaders = {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-1",
          "x-antnest-agent-id": "agent-1",
          "content-type": "application/json",
        };
        const control = async (text, sessionId = null, status = 200) => {
          const response = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/commands`,
            {
              method: "POST",
              headers: commandHeaders,
              body: JSON.stringify({ text, sessionId }),
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          const result = await response.json();
          assert.equal(response.status, status, JSON.stringify(result));
          return result;
        };
        assert.match((await control("/help")).text, /\/sessions/);
        assert.match(
          (await control("/status", "session-1")).text,
          /Fixture session title/,
        );
        assert.match(
          (await control("/usage", "session-1")).text,
          /Not reported/,
        );
        assert.match(
          (await control("/sessions old-page")).text,
          /\/sessions next-page/,
        );
        assert.deepEqual((await control("/resume session-1")).selection, {
          sessionId: "session-1",
        });
        assert.deepEqual((await control("/new", "session-1")).selection, {
          sessionId: null,
        });
        assert.equal(
          (await control("/fork", "session-1", 422)).code,
          "command_unavailable",
        );
        assert.equal(
          (await control("/model", "session-1", 422)).code,
          "command_unavailable",
        );
        assert.deepEqual(commandMutations, { prompts: 0, sessions: 0 });
        const oversizedPrompt = {
          intentId: "intent-cap",
          expectedAppendVersion: 1,
          prompt: [{ type: "text", text: "x".repeat(850) }],
        };
        assert.ok(Buffer.byteLength(JSON.stringify(oversizedPrompt)) < 1024);
        const rejectedPrompt = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts`,
          {
            method: "POST",
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-agent-id": "agent-1",
              "content-type": "application/json",
              "idempotency-key": "intent-cap",
              "if-match": view.selectedView.historyToken,
            },
            body: JSON.stringify(oversizedPrompt),
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        assert.equal(rejectedPrompt.status, 413);
        assert.equal((await rejectedPrompt.json()).code, "request_too_large");
        const inputPhaseTraceId = randomUUID().replaceAll("-", "");
        const inputPhaseBody = JSON.stringify({
          intentId: "phase-witness",
          expectedAppendVersion: 1,
          prompt: [
            {
              type: "text",
              text:
                "PRIVATE-PHASE-CONTENT-CANARY" + "x".repeat(2 * 1024 * 1024),
            },
          ],
        });
        const inputPhaseClientStart = process.hrtime.bigint().toString();
        const inputPhaseResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts`,
          {
            method: "POST",
            headers: {
              ...commandHeaders,
              "idempotency-key": "phase-witness",
              "if-match": view.selectedView.historyToken,
              traceparent: `00-${inputPhaseTraceId}-${gatewayParentSpanId}-01`,
            },
            body: inputPhaseBody,
          },
        );
        assert.equal(inputPhaseResponse.status, 413);
        assert.equal(
          (await inputPhaseResponse.json()).code,
          "request_too_large",
        );
        const inputPhaseClientEnd = process.hrtime.bigint().toString();
        assert.deepEqual(commandMutations, { prompts: 0, sessions: 0 });
        assert.deepEqual(view.promptCapabilities, {
          image: true,
          audio: false,
          embeddedContext: true,
        });
        const initialTurns = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-agent-id": "agent-1",
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        assert.equal(initialTurns.status, 200);
        assert.deepEqual(await initialTurns.json(), {
          items: [],
          nextCursor: null,
          newerCursor: null,
        });
        const memoryViewUrl = `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-memory`;
        const memoryStreamUrl = `${base}/api/app/workspace/v1/agents/agent-1/events?sessionId=session-memory`;
        const memoryHeaders = {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-1",
          "x-antnest-agent-id": "agent-1",
        };
        const firstMemoryResponse = await fetch(memoryViewUrl, {
          headers: memoryHeaders,
          signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
        });
        assert.equal(firstMemoryResponse.status, 200);
        await firstMemoryResponse.body.cancel();
        assert.ok(
          memoryClient,
          "Memory Session must use the official ACP client",
        );
        const memoryBody = `start 界\\\"\n${"x".repeat(1024 * 1024)}\nend`;
        const memoryNotify = async (sequence, messageId, update) => {
          memoryWatermark = sequence;
          await memoryClient.notify(acp.methods.client.session.update, {
            sessionId: "session-memory",
            update,
            _meta: {
              "antnest.dev/delivery": {
                kind: "part",
                sequence,
                partIndex: 0,
                partCount: 1,
                runId: "run-memory",
                messageId,
              },
            },
          });
        };
        await memoryNotify(1, "memory-large", {
          sessionUpdate: "tool_call",
          toolCallId: "memory-large",
          title: "Large",
          status: "in_progress",
          content: [
            { type: "content", content: { type: "text", text: memoryBody } },
          ],
        });
        await memoryNotify(2, "memory-small", {
          sessionUpdate: "tool_call",
          toolCallId: "memory-small",
          title: "Small",
          status: "in_progress",
          content: [
            { type: "content", content: { type: "text", text: "original" } },
          ],
        });
        const memoryReaders = [];
        const memoryControllers = [];
        let memoryEvidence;
        try {
          for (let index = 0; index < 4; index++) {
            const controller = new AbortController();
            memoryControllers.push(controller);
            const stream = await fetch(memoryStreamUrl, {
              headers: memoryHeaders,
              signal: AbortSignal.any([
                controller.signal,
                signal,
                AbortSignal.timeout(60_000),
              ]),
            });
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
            await memoryNotify(sequence, `memory-small-${step}`, {
              sessionUpdate: "tool_call_update",
              toolCallId: "memory-small",
              title: `Small ${step}`,
              status: "in_progress",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: `small output ${step}` },
                },
              ],
            });
            for (const { reader, observer } of memoryReaders) {
              for (
                let attempt = 0;
                attempt < 4 &&
                (observer.view?.selectedView?.outputWatermark ?? 0) < sequence;
                attempt++
              ) {
                const next = await reader.read();
                assert.equal(next.done, false);
                sseBytes += next.value.length;
                assert.ok(
                  next.value.length < 128 * 1024,
                  "Unrelated large tool body leaked into production SSE",
                );
                observer.push(next.value);
              }
              assert.equal(
                observer.view?.selectedView?.outputWatermark,
                sequence,
              );
            }
            const current = await fetch(memoryViewUrl, {
              headers: memoryHeaders,
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            });
            assert.equal(current.status, 200);
            const wire = await current.text();
            viewBytes += Buffer.byteLength(wire);
            assert.ok(
              Buffer.byteLength(wire) < 128 * 1024,
              "Unrelated large tool body leaked into production View",
            );
            assert.equal(
              JSON.parse(wire).selectedView?.outputWatermark,
              sequence,
            );
          }
          const afterSmallBytes = await memoryBytes();
          memoryEvidence = {
            bodyBytes: Buffer.byteLength(memoryBody),
            updates: 8,
            observers: memoryReaders.length,
            viewBytes,
            sseBytes,
            beforeSmallBytes,
            afterSmallBytes,
          };
          assert.ok(
            afterSmallBytes - beforeSmallBytes < 64 * 1024 * 1024,
            `Small updates retained excessive production container memory: ${JSON.stringify(memoryEvidence)}`,
          );
        } finally {
          memoryControllers.forEach((controller) => controller.abort());
          await Promise.all(
            memoryReaders.map(({ reader }) => reader.cancel().catch(() => {})),
          );
        }
        const processResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process`,
          {
            headers: memoryHeaders,
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        assert.equal(processResponse.status, 200);
        const processView = await processResponse.json();
        const largeTool = processView.items.find(
          (item) => item.kind === "tool" && item.summary === "Large",
        );
        assert.ok(
          largeTool?.contentCursor,
          "Large tool must retain paged content",
        );
        let processCursor = largeTool.contentCursor;
        const contentBytes = [];
        while (processCursor) {
          const pageResponse = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process/${encodeURIComponent(largeTool.id)}/content?cursor=${encodeURIComponent(processCursor)}`,
            {
              headers: memoryHeaders,
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          assert.equal(pageResponse.status, 200);
          const page = await pageResponse.json();
          assert.ok(
            page.fragment,
            "Large tool content must use exact fragments",
          );
          contentBytes.push(
            Buffer.from(page.fragment.serializedBlockBase64, "base64"),
          );
          processCursor = page.nextCursor;
        }
        assert.equal(
          JSON.parse(Buffer.concat(contentBytes).toString("utf8")).text,
          memoryBody,
        );
        const abandonedBaseline = await inspectContainerMemory(
          container,
          docker,
        );
        const abandonedBeforeBytes = await memoryBytes();
        const abandonedPages = 12;
        for (let cycle = 0; cycle < abandonedPages; cycle++) {
          const nextBody = `${cycle}:${memoryBody}`;
          await memoryNotify(11 + cycle, `memory-large-revision-${cycle}`, {
            sessionUpdate: "tool_call_update",
            toolCallId: "memory-large",
            title: "Large",
            status: "in_progress",
            content: [
              { type: "content", content: { type: "text", text: nextBody } },
            ],
          });
          const directoryResponse = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process`,
            {
              headers: memoryHeaders,
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          assert.equal(directoryResponse.status, 200);
          const directory = await directoryResponse.json();
          const tool = directory.items.find((item) => item.id === largeTool.id);
          assert.ok(tool?.contentCursor);
          const firstPageResponse = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/sessions/session-memory/turns/run-memory/process/${encodeURIComponent(tool.id)}/content?cursor=${encodeURIComponent(tool.contentCursor)}`,
            {
              headers: memoryHeaders,
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          assert.equal(firstPageResponse.status, 200);
          const firstPage = await firstPageResponse.json();
          assert.ok(
            firstPage.nextCursor,
            "The reader must stop before the large content is complete",
          );
        }
        await sleep(34_000);
        const abandonedAfter = await inspectContainerMemory(container, docker);
        const abandonedAfterBytes = await memoryBytes();
        const abandonedEvidence = {
          abandonedPages,
          bodyBytes: Buffer.byteLength(memoryBody),
          beforeGcHeapUsed: abandonedBaseline.afterGc.heapUsed,
          afterGcHeapUsed: abandonedAfter.afterGc.heapUsed,
          beforeGcContainerBytes: abandonedBeforeBytes,
          afterGcContainerBytes: abandonedAfterBytes,
        };
        assert.ok(
          abandonedAfter.afterGc.heapUsed - abandonedBaseline.afterGc.heapUsed <
            16 * 1024 * 1024,
          `Abandoned process pages retained heap: ${JSON.stringify(abandonedEvidence)}`,
        );
        assert.ok(
          abandonedAfterBytes - abandonedBeforeBytes < 32 * 1024 * 1024,
          `Abandoned process pages retained container memory: ${JSON.stringify(abandonedEvidence)}`,
        );
        await mkdir(`${evidenceRoot}`, {
          recursive: true,
        });
        await writeFile(
          `${evidenceRoot}/abandoned-process-pages-container.json`,
          JSON.stringify(abandonedEvidence, null, 2) + "\n",
        );
        const memoryEvidencePath = `${evidenceRoot}/memory-container-small-updates.json`;
        await mkdir(`${evidenceRoot}`, {
          recursive: true,
        });
        await writeFile(
          memoryEvidencePath,
          JSON.stringify(memoryEvidence, null, 2) + "\n",
        );
        assert.ok(
          session1Client,
          "The official ACP load must retain its live client",
        );
        const streamUrl = `${base}/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1`;
        const streamHeaders = {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-1",
          "x-antnest-agent-id": "agent-1",
        };
        let slowStream, fastPump, slowTimer;
        let slowStreamEvidence;
        await finishBridgeCase({
          body: async () => {
            slowStream = await openPausedResponse(streamUrl, {
              headers: testHeaders(streamHeaders),
              signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
              onFailure: (error) => interrupted.abort(error),
            });
            const slowResponse = slowStream.response;
            assert.equal(slowResponse.statusCode, 200);
            slowResponse.pause();
            // New turns slide the visible window, so this produces enough actual wire
            // traffic to exceed TCP buffering even with incremental publication.
            const streamUpdates = 512;
            const finalStreamWatermark = streamUpdates;
            let slowStreamBytes = 0;
            const slowObserver = agentStreamObserver();
            slowTimer = setInterval(() => {
              try {
                const chunk = slowResponse.read(1024);
                if (chunk) {
                  slowStreamBytes += chunk.length;
                  slowObserver.push(chunk);
                }
              } catch (error) {
                interrupted.abort(error);
              }
            }, 200);
            const fastResponse = await fetch(streamUrl, {
              headers: streamHeaders,
              signal: AbortSignal.timeout(120_000),
            });
            assert.equal(fastResponse.status, 200);
            const fastReader = fastResponse.body.getReader();
            const fastObserver = agentStreamObserver();
            let latestFastWatermark = 0;
            fastPump = startBridgePump(
              fastReader,
              (chunk) => {
                fastObserver.push(chunk);
                latestFastWatermark =
                  fastObserver.view?.selectedView?.outputWatermark ?? 0;
                return latestFastWatermark >= finalStreamWatermark;
              },
              (error) => interrupted.abort(error),
            );
            const beforeStreamBytes = await memoryBytes();
            for (let index = 1; index <= streamUpdates; index++) {
              const sequence = index;
              session1Watermark = sequence;
              await session1Client.notify(acp.methods.client.session.update, {
                sessionId: "session-1",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  messageId: `stream-${sequence}`,
                  content: {
                    type: "text",
                    text: `${sequence}:` + "s".repeat(8 * 1024),
                  },
                },
                _meta: {
                  "antnest.dev/delivery": {
                    kind: "part",
                    sequence,
                    partIndex: 0,
                    partCount: 1,
                    runId: `run-stream-${sequence}`,
                    messageId: `stream-${sequence}`,
                  },
                },
              });
              for (
                let attempt = 0;
                attempt < 200 && latestFastWatermark < sequence;
                attempt++
              )
                await sleep(10);
              assert.ok(
                latestFastWatermark >= sequence,
                `Normal observer did not see ACP update ${sequence}; latest ${latestFastWatermark}`,
              );
            }
            assert.equal(
              await fastPump.done,
              true,
              "A normal production SSE observer must see the final ACP watermark",
            );
            clearInterval(slowTimer);
            slowResponse.on("data", (chunk) => {
              try {
                slowStreamBytes += chunk.length;
                slowObserver.push(chunk);
              } catch (error) {
                interrupted.abort(error);
              }
            });
            slowResponse.resume();
            for (
              let attempt = 0;
              attempt < 200 &&
              slowObserver.view?.selectedView?.outputWatermark !==
                finalStreamWatermark;
              attempt++
            )
              await sleep(50);
            assert.equal(
              slowObserver.view?.selectedView?.outputWatermark,
              finalStreamWatermark,
              "A slow production SSE observer must recover the latest ACP watermark",
            );
            const revisions = slowObserver.revisions;
            assert.ok(
              revisions.some(
                (revision, index) =>
                  index > 0 && revision - revisions[index - 1] > 1,
              ),
              `A slow production observer should coalesce missed resets: ${revisions.length} frames, ${slowStreamBytes} bytes`,
            );
            slowStreamEvidence = {
              updates: streamUpdates,
              slowStreamBytes,
              observedFrames: revisions.length,
              resetFrames: slowObserver.resets,
              beforeStreamBytes,
              afterStreamBytes: await memoryBytes(),
            };
            assert.ok(
              slowStreamEvidence.afterStreamBytes < 384 * 1024 * 1024,
              `Production SSE overload exceeded its fixed-load peak: ${JSON.stringify(slowStreamEvidence)}`,
            );
          },
          cleanup: [
            async () => {
              clearInterval(slowTimer);
            },
            async () => {
              await slowStream?.close();
            },
            async () => {
              await fastPump?.stop();
            },
          ],
        });
        await sleep(10_000);
        slowStreamEvidence.afterDisconnectBytes = await memoryBytes();
        slowStreamEvidence.inspector = await inspectContainerMemory(
          container,
          docker,
        );
        slowStreamEvidence.afterGcContainerBytes = await memoryBytes();
        assert.ok(
          slowStreamEvidence.afterGcContainerBytes -
            slowStreamEvidence.beforeStreamBytes <
            64 * 1024 * 1024,
          `Production SSE retained memory after disconnect and GC: ${JSON.stringify(slowStreamEvidence)}`,
        );
        const metadataAfterStream = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`,
          {
            headers: streamHeaders,
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        assert.equal(metadataAfterStream.status, 200);
        const streamMetadata = (await metadataAfterStream.json()).selectedView;
        assert.equal(streamMetadata.title, "Fixture session title");
        assert.equal(streamMetadata.updatedAt, "2026-09-24T00:00:00Z");
        const observerChurn = {
          cycles: dockerSoak ? 180 : 24,
          beforeBytes: slowStreamEvidence.afterGcContainerBytes,
          samples: [],
        };
        for (let cycle = 0; cycle < observerChurn.cycles; cycle++) {
          const controller = new AbortController();
          try {
            const response = await fetch(streamUrl, {
              headers: streamHeaders,
              signal: AbortSignal.any([
                AbortSignal.timeout(10_000),
                signal,
                controller.signal,
              ]),
            });
            assert.equal(response.status, 200);
            const reader = response.body.getReader();
            const first = await reader.read();
            assert.equal(first.done, false);
            await reader.cancel();
          } finally {
            controller.abort();
          }
          if (dockerSoak) {
            await sleep(1_000);
            if ((cycle + 1) % 30 === 0) {
              const passiveBytes = await memoryBytes();
              const inspector = await inspectContainerMemory(container, docker);
              const afterGcBytes = await memoryBytes();
              observerChurn.samples.push({
                cycle: cycle + 1,
                passiveBytes,
                afterGcBytes,
                heapUsedBytes: inspector.afterGc.heapUsed,
              });
              assert.ok(
                passiveBytes < 384 * 1024 * 1024,
                `Production observer churn exceeded its peak budget: ${JSON.stringify(observerChurn)}`,
              );
              assert.ok(
                afterGcBytes - observerChurn.beforeBytes < 32 * 1024 * 1024,
                `Production observer churn retained memory: ${JSON.stringify(observerChurn)}`,
              );
            }
          }
        }
        if (!dockerSoak) await sleep(500);
        observerChurn.inspector = await inspectContainerMemory(
          container,
          docker,
        );
        observerChurn.afterGcBytes = await memoryBytes();
        assert.ok(
          observerChurn.afterGcBytes - observerChurn.beforeBytes <
            32 * 1024 * 1024,
          `Repeated production SSE observers retained memory: ${JSON.stringify(observerChurn)}`,
        );
        const churnEvidencePath = `${evidenceRoot}/${
          dockerSoak
            ? "observer-churn-container-soak"
            : "observer-churn-container"
        }.json`;
        await mkdir(`${evidenceRoot}`, {
          recursive: true,
        });
        await writeFile(
          churnEvidencePath,
          JSON.stringify(observerChurn, null, 2) + "\n",
        );
        capacityMemoryBytes.push(await memoryBytes());
        for (let attempt = 0; attempt < 12; attempt++) {
          const longResponse = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-long`,
            {
              headers: {
                "x-antnest-organization-id": "org-1",
                "x-antnest-principal-id": "user-1",
                "x-antnest-agent-id": "agent-1",
              },
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          const longBody = await longResponse.json();
          assert.equal(
            longResponse.status,
            200,
            `long replay attempt ${attempt + 1}: ${longBody.code}`,
          );
          assert.equal(longBody.selectedView.historyState, "ready");
          assert.equal(typeof longBody.selectedView.historyToken, "string");
          assert.equal(
            longLoads,
            1,
            "Repeated reads must reuse complete loaded history",
          );
          if (attempt === 0) {
            const full = await readTurnContent(
              `${base}/api/app/workspace/v1/agents/agent-1`,
              "session-long",
              longBody.selectedView.turns[0],
              streamHeaders,
              signal,
            );
            assert.equal(
              full.finalResponse.map((block) => block.text).join(""),
              "x".repeat(20 * 16 * 1024),
            );
          }
          capacityMemoryBytes.push(await memoryBytes());
        }
        assert.ok(
          Math.max(...capacityMemoryBytes) - capacityMemoryBytes[0] <
            64 * 1024 * 1024,
          `Repeated replay memory samples: ${JSON.stringify(capacityMemoryBytes)}`,
        );
        const retainedResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-agent-id": "agent-1",
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        assert.equal(retainedResponse.status, 200);
        const mediumResults = [];
        const mediumMemoryBytes = [await memoryBytes()];
        for (let userIndex = 2; userIndex <= 16; userIndex++) {
          const mediumResponse = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
            {
              headers: {
                "x-antnest-organization-id": "org-1",
                "x-antnest-principal-id": `user-${userIndex}`,
                "x-antnest-agent-id": "agent-1",
              },
              signal: AbortSignal.any([AbortSignal.timeout(15_000), signal]),
            },
          );
          const body = await mediumResponse.json();
          mediumResults.push({
            principalId: `user-${userIndex}`,
            status: mediumResponse.status,
            code: body.code ?? null,
          });
          mediumMemoryBytes.push(await memoryBytes());
          assert.equal(mediumResponse.status, 200, JSON.stringify(body));
          assert.equal(body.selectedView?.sessionId, "session-medium");
        }
        assert.equal(
          mediumResults.length,
          15,
          "All independent owners retain their complete histories",
        );
        const firstMediumOwner = mediumResults[0].principalId;
        const existingMediumResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": firstMediumOwner,
              "x-antnest-agent-id": "agent-1",
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        assert.equal(
          existingMediumResponse.status,
          200,
          "Other owners must preserve an existing owner's readable Session",
        );
        assert.ok(
          Math.max(...mediumMemoryBytes) - mediumMemoryBytes[0] <
            64 * 1024 * 1024,
          "Fixed multi-owner history stays within its measured memory allowance",
        );
        const activeOwners = mediumResults
          .filter(({ status }) => status === 200)
          .map(({ principalId }) => principalId);
        assert.ok(
          activeOwners.every((principalId) => mediumClients.has(principalId)),
        );
        mediumLive = true;
        const liveResults = [];
        const liveOwner = activeOwners[0];
        for (let round = 0; round < 4; round++) {
          for (let index = 0; index < activeOwners.length; index++) {
            const principalId = activeOwners[index];
            const sequence = await publishMedium(
              principalId,
              "a".repeat(8 * 1024),
            );
            const liveResponse = await fetch(
              `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
              {
                headers: {
                  "x-antnest-organization-id": "org-1",
                  "x-antnest-principal-id": principalId,
                  "x-antnest-agent-id": "agent-1",
                },
                signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
              },
            );
            const liveBody = await liveResponse.json();
            liveResults.push({
              principalId,
              sequence,
              status: liveResponse.status,
              historyState: liveBody.selectedView?.historyState ?? null,
            });
            assert.equal(liveBody.selectedView?.historyState, "ready");
            assert.equal(liveBody.selectedView.outputWatermark, sequence);
            assert.equal(typeof liveBody.selectedView.historyToken, "string");
            assert.equal(liveResponse.status, 200, JSON.stringify(liveBody));
          }
        }
        const survivingOwner = activeOwners.find(
          (principalId) => principalId !== liveOwner,
        );
        const survivingResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": survivingOwner,
              "x-antnest-agent-id": "agent-1",
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        assert.equal(
          survivingResponse.status,
          200,
          "Continued output preserves another owner's running View",
        );
        const continuedMemoryBytes = [await memoryBytes()];
        for (let index = 0; index < 24; index++) {
          await publishMedium(liveOwner, "b".repeat(8 * 1024));
        }
        const continuedResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": liveOwner,
              "x-antnest-agent-id": "agent-1",
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        const continuedBody = await continuedResponse.json();
        assert.equal(continuedResponse.status, 200);
        assert.equal(continuedBody.selectedView?.historyState, "ready");
        assert.equal(
          continuedBody.selectedView?.outputWatermark,
          mediumWatermarks.get(liveOwner),
        );
        const continuedContent = await readTurnContent(
          `${base}/api/app/workspace/v1/agents/agent-1`,
          "session-medium",
          continuedBody.selectedView.turns[0],
          { ...streamHeaders, "x-antnest-principal-id": liveOwner },
          signal,
        );
        const continuedText =
          "m".repeat(8 * 16 * 1024) +
          "a".repeat(4 * 8 * 1024) +
          "b".repeat(24 * 8 * 1024);
        assert.equal(
          continuedContent.finalResponse.map((block) => block.text).join(""),
          continuedText,
        );
        continuedMemoryBytes.push(await memoryBytes());
        assert.ok(
          continuedMemoryBytes[1] - continuedMemoryBytes[0] < 64 * 1024 * 1024,
          `Continued-output memory samples: ${JSON.stringify(continuedMemoryBytes)}`,
        );
        mediumMemoryBytes.push(await memoryBytes());
        assert.ok(
          Math.max(...mediumMemoryBytes) - mediumMemoryBytes[0] <
            64 * 1024 * 1024,
          `Active-output memory samples: ${JSON.stringify(mediumMemoryBytes)}`,
        );
        const oversizedBeforeBytes = await memoryBytes();
        const oversizedSequence = await publishMedium(
          liveOwner,
          "c".repeat(17 * 1024 * 1024),
        );
        let oversizedView;
        const oversizedReadyDeadline = performance.now() + 30_000;
        while (performance.now() < oversizedReadyDeadline) {
          const response = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
            {
              headers: {
                "x-antnest-organization-id": "org-1",
                "x-antnest-principal-id": liveOwner,
                "x-antnest-agent-id": "agent-1",
              },
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          assert.equal(response.status, 200);
          oversizedView = await response.json();
          if (
            oversizedView.selectedView?.historyState === "ready" &&
            oversizedView.selectedView.outputWatermark === oversizedSequence
          )
            break;
          await sleep(100);
        }
        assert.equal(oversizedView?.selectedView?.historyState, "ready");
        assert.equal(
          oversizedView?.selectedView?.outputWatermark,
          oversizedSequence,
        );
        const oversizedContent = await readTurnContent(
          `${base}/api/app/workspace/v1/agents/agent-1`,
          "session-medium",
          oversizedView.selectedView.turns[0],
          { ...streamHeaders, "x-antnest-principal-id": liveOwner },
          signal,
        );
        assert.equal(
          oversizedContent.finalResponse.map((block) => block.text).join(""),
          continuedText + "c".repeat(17 * 1024 * 1024),
        );
        const oversizedAfterBytes = await memoryBytes();
        assert.ok(
          oversizedAfterBytes - oversizedBeforeBytes < 128 * 1024 * 1024,
          `Oversized ACP update exceeded transient memory allowance: ${oversizedAfterBytes - oversizedBeforeBytes}`,
        );
        await sleep(10_000);
        const oversizedDelivery = {
          sequence: oversizedSequence,
          beforeBytes: oversizedBeforeBytes,
          afterBytes: oversizedAfterBytes,
          afterIdleBytes: await memoryBytes(),
        };
        mediumLive = false;
        const beforeReclaimBytes = await memoryBytes();
        for (let index = 0; index < 20; index++) {
          const coldReplacement = await fetch(
            `${base}/api/app/workspace/v1/agents/agent-1/view`,
            {
              headers: {
                "x-antnest-organization-id": "org-1",
                "x-antnest-principal-id": `user-replacement-${index}`,
                "x-antnest-agent-id": "agent-1",
              },
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          assert.equal(
            coldReplacement.status,
            200,
            `New owner ${index} should evict a cold owner at capacity`,
          );
          assert.equal((await coldReplacement.json()).selectedView, null);
        }
        const reclaimedResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-after-reclaim",
              "x-antnest-agent-id": "agent-1",
            },
            signal: AbortSignal.any([AbortSignal.timeout(15_000), signal]),
          },
        );
        const reclaimedBody = await reclaimedResponse.json();
        assert.equal(
          reclaimedResponse.status,
          200,
          `Cold owner eviction must release retained state: ${JSON.stringify(reclaimedBody)}`,
        );
        assert.equal(reclaimedBody.selectedView?.sessionId, "session-medium");
        const afterReclaimBytes = await memoryBytes();
        const metricsPath = `${evidenceRoot}/capacity`;
        await mkdir(metricsPath, { recursive: true });
        await writeFile(
          `${metricsPath}/metrics.json`,
          JSON.stringify(
            {
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
              reclamation: {
                beforeBytes: beforeReclaimBytes,
                afterBytes: afterReclaimBytes,
                replacementOwners: 20,
                recoveredStatus: reclaimedResponse.status,
              },
            },
            null,
            2,
          ) + "\n",
        );
        const catalogResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/sessions?cursor=old-page`,
          {
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-agent-id": "agent-1",
            },
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        const catalog = await catalogResponse.json();
        assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
        assert.deepEqual(catalog, {
          items: [
            {
              sessionId: "session-1",
              title: "First",
              updatedAt: null,
              activeOperationId: null,
            },
          ],
          nextCursor: "next-page",
        });
        const createResponse = await fetch(
          `${base}/api/app/workspace/v1/agents/agent-1/sessions`,
          {
            method: "POST",
            headers: {
              "x-antnest-organization-id": "org-1",
              "x-antnest-principal-id": "user-1",
              "x-antnest-agent-id": "agent-1",
              "content-type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
          },
        );
        const created = await createResponse.json();
        assert.equal(createResponse.status, 201, JSON.stringify(created));
        assert.deepEqual(created, { sessionId: "session-2" });
        assert.deepEqual(commandMutations, { prompts: 0, sessions: 1 });
        assert.ok(seen.some(({ path }) => path === "/v1/acp"));
        assert.ok(
          seen.some(
            ({ path, headers }) =>
              path === "/v1/acp" &&
              new RegExp(`^00-${gatewayTraceId}-[a-f0-9]{16}-01$`).test(
                headers.traceparent ?? "",
              ),
          ),
          "ACP initialization must continue the active Bridge HTTP trace",
        );
        for (const { headers, claims } of seen.filter(
          ({ path }) => path !== "/rpc/agent-controller/list-workspace-agents",
        )) {
          assert.equal(claims.org, "org-1");
          assert.match(
            claims.sub,
            /^user-(?:\d+|replacement-\d+|after-reclaim)$/,
          );
          assert.equal(claims.agt, "agent-1");
          assert.equal(headers["x-antnest-organization-id"], undefined);
          assert.equal(headers["x-antnest-principal-id"], undefined);
          assert.equal(headers["x-antnest-agent-id"], undefined);
          assert.equal(headers.cookie, undefined);
        }
        await docker([
          "run",
          "-d",
          "--name",
          idleContainer,
          "--label",
          `${bridgeOwnerLabel}=${suffix}`,
          ...dockerAuthenticationArgs(),
          "-e",
          `ANTNEST_AGENT_UI_IDENTITY_URL=http://host.docker.internal:${identityFixture.address().port}`,
          "--add-host",
          "host.docker.internal:host-gateway",
          "-p",
          "127.0.0.1::8080",
          "-e",
          `ANTNEST_AGENT_ACP_SERVICE_URL=http://host.docker.internal:${fixtureAddress.port}`,
          "-e",
          `ANTNEST_AGENT_CONTROLLER_URL=http://host.docker.internal:${controllerFixture.address().port}`,
          "-e",
          "ANTNEST_AGENT_UI_BRIDGE_IDLE_MS=100",
          "-e",
          "ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS=50",
          image,
        ]);
        const idlePortOutput = await docker([
          "port",
          idleContainer,
          "8080/tcp",
        ]);
        const idlePort = Number(idlePortOutput.stdout.trim().split(":").at(-1));
        assert.ok(Number.isSafeInteger(idlePort) && idlePort > 0);
        const idleBase = `http://127.0.0.1:${idlePort}`;
        let idleReady = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            idleReady = (
              await fetch(`${idleBase}/status`, {
                signal: AbortSignal.any([AbortSignal.timeout(500), signal]),
              })
            ).ok;
          } catch {}
          signal.throwIfAborted();
          if (idleReady) break;
          await sleep(100);
        }
        assert.equal(
          idleReady,
          true,
          "Idle Bridge container did not become ready",
        );
        const idleView = async () => {
          const result = await fetch(
            `${idleBase}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-medium`,
            {
              headers: {
                "x-antnest-organization-id": "org-1",
                "x-antnest-principal-id": "user-idle",
                "x-antnest-agent-id": "agent-1",
              },
              signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
            },
          );
          const body = await result.json();
          assert.equal(result.status, 200, JSON.stringify(body));
          assert.equal(body.selectedView?.sessionId, "session-medium");
          assert.ok(body.selectedView.incarnation);
          return body.selectedView.incarnation;
        };
        const initialIncarnation = await idleView();
        let replacementIncarnation;
        for (let attempt = 0; attempt < 20; attempt++) {
          await sleep(200);
          replacementIncarnation = await idleView();
          if (replacementIncarnation !== initialIncarnation) break;
        }
        assert.notEqual(
          replacementIncarnation,
          initialIncarnation,
          "Production Bridge must retire an idle owner and rebuild its readable Session",
        );
        accountOnly = true;
        try {
          await verifyExternalIdentitiesBrowser({
            base,
            signal: signal,
            headersForRequest: testHeaders,
            output: `${evidenceRoot}/external-identities`,
          });
        } finally {
          accountOnly = false;
        }
        const revocationAbort = new AbortController();
        const revocationSignal = AbortSignal.any([
          revocationAbort.signal,
          AbortSignal.timeout(10_000),
          signal,
        ]);
        let revocationReader;
        try {
          revocationDelegation = testContext({
            agt: "agent-1",
            sub: "user-9876",
          });
          revocationSentAt = performance.now();
          const response = await nativeFetch(
            `${base}/api/app/workspace/v1/agents/agent-1/events`,
            {
              headers: {
                ...workloadHeaders(),
                "Antnest-Caller-Context": revocationDelegation.token,
                traceparent: `00-${revocationTraceId}-${gatewayParentSpanId}-01`,
              },
              signal: revocationSignal,
            },
          );
          assert.equal(response.status, 200);
          revocationReader = response.body.getReader();
          assert.equal(
            (await revocationReader.read()).done,
            false,
            "revocation must follow a real opened SSE",
          );
          for (let attempt = 0; !revocationWatch && attempt < 100; attempt++) {
            revocationSignal.throwIfAborted();
            await sleep(25);
          }
          assert(
            revocationWatch,
            "production owner must establish its authenticated execution-state watch",
          );
          revocationWatch.write(
            `event: workspace_state\ndata: ${JSON.stringify({ agent_id: "agent-1", access_allowed: false })}\n\n`,
          );
          while (!(await revocationReader.read()).done)
            revocationSignal.throwIfAborted();
          revocationClosedAt = performance.now();
          revocationSignal.throwIfAborted();
        } finally {
          revocationAbort.abort();
          await revocationReader?.cancel().catch(() => {});
          revocationReader?.releaseLock();
          revocationWatch?.end();
        }
        const stopStartedAt = performance.now();
        holdCleanup = true;
        let stopSettled = false;
        const stopping = docker(
          ["stop", "-t", "30", container],
          45_000,
        ).finally(() => {
          stopSettled = true;
        });
        void stopping.catch(() => {});
        await finishBridgeCase({
          body: async () => {
            let timer;
            try {
              await Promise.race([
                cleanupHeld,
                stopping.then(() => {
                  throw new Error("Bridge stopped before DELETE cleanup");
                }),
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        new Error("Bridge did not reach held DELETE cleanup"),
                      ),
                    5000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
            assert.equal(heldCleanup.complete, false);
            assert.equal(heldCleanup.status, 202);
            assert.equal(
              (await fetch(`${base}/status`)).status,
              503,
              "Bridge remains draining while the DELETE body is unfinished",
            );
            assert.equal((await fetch(`${base}/live`)).status, 200);
            const running = await docker([
              "inspect",
              "-f",
              "{{.State.Running}}",
              container,
            ]);
            assert.equal(running.stdout.trim(), "true");
            assert.equal(stopSettled, false);
          },
          cleanup: [
            async () => {
              releaseCleanup();
              await stopping;
            },
          ],
        });
        const stopDurationMs = performance.now() - stopStartedAt;
        const { stdout: exitCode } = await docker([
          "inspect",
          "-f",
          "{{.State.ExitCode}}",
          container,
        ]);
        const stopEvidence = `${evidenceRoot}/capacity`;
        await mkdir(stopEvidence, { recursive: true });
        await writeFile(
          `${stopEvidence}/normal-stop.json`,
          JSON.stringify(
            {
              stopDurationMs,
              exitCode: Number(exitCode.trim()),
              stopGraceMs: 30_000,
            },
            null,
            2,
          ) + "\n",
        );
        assert.equal(
          exitCode.trim(),
          "0",
          "Bridge must exit normally after flushing telemetry",
        );
        const finalLogs = await docker(["logs", container]);
        assert.doesNotMatch(
          finalLogs.stdout + finalLogs.stderr,
          /Bridge (?:drain did not close cleanly|shutdown failed|owner sweep failed)/,
          "a clean exit must also retain successful owner cleanup",
        );
        assert.ok(
          stopDurationMs < 30_000,
          `Bridge normal stop must finish within the 30 s container grace: ${stopDurationMs} ms`,
        );
        for (const path of ["/v1/traces", "/v1/metrics"])
          assert.ok(
            telemetryRequests.some(
              (item) => item.path === path && item.bytes > 0,
            ),
            `Production Bridge did not export ${path} during normal stop: ${JSON.stringify(telemetryRequests)}`,
          );
        await writeFile(
          `${evidenceRoot}/process-generation-1-otlp.json`,
          JSON.stringify(telemetryRequests, null, 2) + "\n",
        );
        const firstInstanceId = processResourceIdentity(
          telemetryRequests,
          hostname,
        );
        const exportedSpans = telemetryRequests
          .filter((item) => item.path === "/v1/traces")
          .flatMap((item) =>
            JSON.parse(item.body).resourceSpans.flatMap((resource) =>
              resource.scopeSpans.flatMap((scope) => scope.spans),
            ),
          );
        assert.ok(
          exportedSpans.some(
            (span) =>
              span.traceId === gatewayTraceId &&
              span.parentSpanId === gatewayParentSpanId,
          ),
          "Production Bridge HTTP span must continue the incoming Gateway trace context",
        );
        const revocationSpans = exportedSpans.filter(
          (span) =>
            span.traceId === revocationTraceId &&
            span.parentSpanId === gatewayParentSpanId,
        );
        assert.equal(revocationSpans.length, 1);
        const revocationSpan = revocationSpans[0];
        const attributes = (entries) =>
          Object.fromEntries(
            entries.map((entry) => [
              entry.key,
              entry.value.stringValue ??
                entry.value.boolValue ??
                (entry.value.intValue === undefined
                  ? undefined
                  : Number(entry.value.intValue)),
            ]),
          );
        const inputPhaseSpans = exportedSpans.filter(
          (span) => span.traceId === inputPhaseTraceId,
        );
        assert.equal(inputPhaseSpans.length, 1);
        const inputPhaseSpan = inputPhaseSpans[0];
        assert.equal(inputPhaseSpan.name, "agent_ui.http.request");
        assert.equal(inputPhaseSpan.kind, 2);
        assert.equal(inputPhaseSpan.parentSpanId, gatewayParentSpanId);
        const inputAttributes = attributes(inputPhaseSpan.attributes);
        assert.equal(inputAttributes["http.response.status_code"], 413);
        const remoteStart =
          inputAttributes["antnest.ui.http.started_monotonic_ns"];
        assert.match(remoteStart ?? "", /^[1-9][0-9]{0,29}$/u);
        const inputEvents = (inputPhaseSpan.events ?? []).filter(
          (event) => event.name === "antnest.ui.prompt_input",
        );
        assert.deepEqual(
          inputEvents.map((event) => attributes(event.attributes).phase),
          ["receive-started", "body-eof", "body-parsed"],
        );
        let previousPhaseTime = BigInt(remoteStart);
        for (const event of inputEvents) {
          const values = attributes(event.attributes);
          assert.deepEqual(Object.keys(values).sort(), [
            "bytes",
            "monotonic_ns",
            "phase",
          ]);
          assert.match(values.monotonic_ns, /^[1-9][0-9]{0,29}$/u);
          assert(BigInt(values.monotonic_ns) >= previousPhaseTime);
          previousPhaseTime = BigInt(values.monotonic_ns);
          assert(
            Number.isSafeInteger(values.bytes) &&
              values.bytes > 0 &&
              values.bytes <= Buffer.byteLength(inputPhaseBody),
          );
          if (values.phase !== "receive-started")
            assert.equal(values.bytes, Buffer.byteLength(inputPhaseBody));
          assert(
            BigInt(inputPhaseSpan.startTimeUnixNano) <=
              BigInt(event.timeUnixNano),
          );
          assert(
            BigInt(event.timeUnixNano) <=
              BigInt(inputPhaseSpan.endTimeUnixNano),
          );
        }
        assert(
          !JSON.stringify(exportedSpans).includes(
            "PRIVATE-PHASE-CONTENT-CANARY",
          ),
        );
        await writeFile(
          `${evidenceRoot}/native-upload-phases.json`,
          JSON.stringify(
            {
              scope:
                "production native input phases; route size rejection has no accepted intent",
              process_instance: firstInstanceId,
              client_clock: "process.hrtime.bigint",
              client_send_ns: inputPhaseClientStart,
              client_complete_ns: inputPhaseClientEnd,
              server_minus_client_offset_ns: {
                low: (
                  BigInt(remoteStart) - BigInt(inputPhaseClientEnd)
                ).toString(),
                high: (
                  BigInt(remoteStart) - BigInt(inputPhaseClientStart)
                ).toString(),
              },
              upload_bytes: Buffer.byteLength(inputPhaseBody),
              span: inputPhaseSpan,
            },
            null,
            2,
          ) + "\n",
        );
        const delegationReceipt = attributes(revocationSpan.attributes);
        assert.equal(
          delegationReceipt["antnest.ui.stream.delegation_expires_at_unix_ms"],
          revocationDelegation.claims.exp * 1000,
          "production SSE must retain its actual original verified CCT expiry",
        );
        const delegationRemaining =
          delegationReceipt["antnest.ui.stream.delegation_remaining_ms"];
        assert(
          Number.isSafeInteger(delegationRemaining) && delegationRemaining > 0,
        );
        assert(
          revocationClosedAt < revocationSentAt + delegationRemaining,
          "revocation must precede the original delegation's conservative deadline",
        );
        assert(
          !JSON.stringify(exportedSpans).includes(revocationDelegation.token),
        );
        assert.equal(heldCleanup.complete, true);
        assert.equal(
          cleanupReceipts.filter(
            (receipt) => receipt.connectionId === heldCleanup.connectionId,
          ).length,
          1,
        );
        assert.match(
          heldCleanup.traceparent ?? "",
          /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
        );
        const [, cleanupTraceId, cleanupSpanId] =
          heldCleanup.traceparent.split("-");
        const closeSpans = exportedSpans.filter(
          (span) =>
            span.name === "agent_ui.acp.close" &&
            span.traceId === cleanupTraceId &&
            span.spanId === cleanupSpanId,
        );
        assert.equal(closeSpans.length, 1);
        const closeSpan = closeSpans[0];
        assert(!closeSpan.parentSpanId, "ACP cleanup is a separate root");
        assert.notEqual(closeSpan.status?.code, 2);
        assert.deepEqual(attributes(closeSpan.attributes), {
          "antnest.ui.acp.close.trigger": "requested",
          "antnest.ui.acp.close.outcome": "closed",
          "antnest.ui.acp.close.target_observed": true,
          "antnest.ui.acp.close.delete_attempts": 1,
          "antnest.ui.acp.close.delete_responses": 1,
          "antnest.ui.acp.close.delete_completed": 1,
          "antnest.ui.acp.close.delete_status": 202,
          "antnest.ui.acp.close.pending_requests": 0,
          "antnest.ui.acp.close.stream_joined": true,
          "antnest.ui.acp.close.failures": 0,
          "antnest.ui.acp.close.diagnostics_truncated": false,
        });
        assert.equal(closeSpan.events?.length ?? 0, 0);
        const initialTraceparent = initializedConnections.get(
          heldCleanup.connectionId,
        );
        assert.match(
          initialTraceparent ?? "",
          /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
        );
        const [, initialTraceId, initialSpanId] = initialTraceparent.split("-");
        assert.equal(initialTraceId, revocationSpan.traceId);
        assert.equal(initialSpanId, revocationSpan.spanId);
        assert.notEqual(closeSpan.traceId, initialTraceId);
        assert.deepEqual(
          closeSpan.links.map((link) => ({
            traceId: link.traceId,
            spanId: link.spanId,
          })),
          [{ traceId: initialTraceId, spanId: initialSpanId }],
        );
        const initializationSpan = exportedSpans.find(
          (span) =>
            span.traceId === initialTraceId && span.spanId === initialSpanId,
        );
        assert(
          initializationSpan,
          "the exact linked initialization HTTP span was exported",
        );
        await writeFile(
          `${evidenceRoot}/acp-owned-close.json`,
          JSON.stringify(
            {
              scope:
                "production Agent UI container with authenticated official ACP SDK fixture",
              process_waited_for_delete_body: true,
              readiness_while_waiting: 503,
              liveness_while_waiting: 200,
              actual_delete_body_completed: true,
              duplicate_deletes: 0,
              delete_traceparent: heldCleanup.traceparent,
              close_span: closeSpan,
              initialization_span: initializationSpan,
            },
            null,
            2,
          ) + "\n",
        );
        assert.equal(revocationSpan.kind, 2);
        assert.equal(
          Number(
            attributes(revocationSpan.attributes)["http.response.status_code"],
          ),
          200,
        );
        assert.notEqual(revocationSpan.status?.code, 2);
        const terminations = (revocationSpan.events ?? []).filter(
          (event) => event.name === "antnest.stream.termination",
        );
        assert.equal(terminations.length, 1);
        assert.deepEqual(attributes(terminations[0].attributes), {
          reason: "access_denied",
          source: "agent-execution-state",
          "antnest.organization.id": "org-1",
          "antnest.principal.id": "user-9876",
          "antnest.agent.id": "agent-1",
        });
        assert(
          BigInt(terminations[0].timeUnixNano) >=
            BigInt(revocationSpan.startTimeUnixNano),
        );
        assert(
          BigInt(terminations[0].timeUnixNano) <=
            BigInt(revocationSpan.endTimeUnixNano),
        );
        await writeFile(
          `${evidenceRoot}/stream-access-revocation.json`,
          JSON.stringify(
            {
              transport: "normal-eof",
              delegation_active: true,
              span: revocationSpan,
            },
            null,
            2,
          ) + "\n",
        );
        const exportedMetrics = telemetryRequests
          .filter((item) => item.path === "/v1/metrics")
          .flatMap((item) =>
            JSON.parse(item.body).resourceMetrics.flatMap((resource) =>
              resource.scopeMetrics.flatMap((scope) => scope.metrics),
            ),
          );
        const gaugeValues = (name) =>
          exportedMetrics
            .filter((metric) => metric.name === name)
            .flatMap((metric) => metric.gauge?.dataPoints ?? [])
            .map((point) => Number(point.asInt ?? point.asDouble));
        assert.ok(
          gaugeValues("antnest.ui.bridge.owners").some((value) => value > 0),
          "Production Bridge must export a live owner count",
        );
        assert.ok(
          gaugeValues("antnest.ui.bridge.cached_history_bytes").some(
            (value) => value > 0,
          ),
          "Production Bridge must export retained history bytes",
        );
        assert.ok(
          gaugeValues("antnest.ui.bridge.stream_subscribers").length > 0,
        );
        assert.ok(
          gaugeValues("antnest.ui.bridge.journal_queued_bytes").length > 0,
        );
        assert.ok(
          gaugeValues("antnest.ui.bridge.journal_retained_bytes").length > 0,
        );
        assert.ok(gaugeValues("antnest.ui.bridge.active_replays").length > 0);
        assert.ok(gaugeValues("antnest.ui.bridge.queued_replays").length > 0);
        assert.ok(
          gaugeValues("antnest.ui.bridge.uncertain_operations").length > 0,
        );
        assert.ok(
          gaugeValues("antnest.ui.bridge.oldest_uncertain_ms").length > 0,
        );
        const coldReplaySamples = exportedMetrics
          .filter(
            (metric) =>
              metric.name === "antnest.ui.bridge.cold_replay_duration",
          )
          .flatMap((metric) => metric.histogram?.dataPoints ?? []);
        assert.ok(
          coldReplaySamples.some(
            (point) =>
              Number(point.count ?? point.countValue) > 0 &&
              point.attributes?.some(
                (attribute) =>
                  attribute.key === "outcome" &&
                  attribute.value?.stringValue === "success",
              ),
          ),
          "Production Bridge must export a successful cold Session replay duration",
        );
        assert.ok(
          gaugeValues("antnest.ui.process.heap_used_bytes").some(
            (value) => value > 0,
          ),
        );
        assert.ok(
          gaugeValues("antnest.ui.process.rss_bytes").some(
            (value) => value > 0,
          ),
        );
        const firstExportCount = telemetryRequests.length;
        holdCleanup = false;
        await docker(["start", container]);
        const { stdout: restartedPort } = await docker([
          "port",
          container,
          "8080/tcp",
        ]);
        const newPort = Number(restartedPort.trim().split(":").at(-1));
        assert(Number.isSafeInteger(newPort) && newPort > 0);
        let restarted = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const response = await fetch(`http://127.0.0.1:${newPort}/status`, {
              signal: AbortSignal.any([AbortSignal.timeout(500), signal]),
            });
            await response.text();
            restarted = response.status === 200;
          } catch {
            signal.throwIfAborted();
          }
          if (restarted) break;
          await sleep(100);
        }
        assert(
          restarted,
          "The same production container must restart normally",
        );
        await docker(["stop", "-t", "30", container], 45_000);
        const { stdout: restartedExitCode } = await docker([
          "inspect",
          "-f",
          "{{.State.ExitCode}}",
          container,
        ]);
        assert.equal(restartedExitCode.trim(), "0");
        const { stdout: restartedHostname } = await docker([
          "inspect",
          "-f",
          "{{.Config.Hostname}}",
          container,
        ]);
        assert.equal(restartedHostname.trim(), hostname);
        const secondExports = telemetryRequests.slice(firstExportCount);
        await writeFile(
          `${evidenceRoot}/process-generation-2-otlp.json`,
          JSON.stringify(secondExports, null, 2) + "\n",
        );
        const secondInstanceId = processResourceIdentity(
          secondExports,
          hostname,
        );
        assert.notEqual(
          firstInstanceId,
          secondInstanceId,
          "Same-container PID 1 restart must produce a new process generation",
        );
        await writeFile(
          `${evidenceRoot}/process-generations.json`,
          JSON.stringify(
            {
              container,
              hostname,
              pid: 1,
              instances: [firstInstanceId, secondInstanceId],
              exitCodes: [
                Number(exitCode.trim()),
                Number(restartedExitCode.trim()),
              ],
            },
            null,
            2,
          ) + "\n",
        );
      },
      diagnostics: async (error) => {
        interrupted.abort(error);
        const diagnostics = `${evidenceRoot}/capacity`;
        await mkdir(diagnostics, { recursive: true });
        const exists = (
          await cleanupDocker([
            "container",
            "ls",
            "-aq",
            "--filter",
            `name=^/${container}$`,
          ])
        ).stdout.trim();
        const logs = exists
          ? await cleanupDocker(["logs", "--tail", "200", container]).then(
              ({ stdout, stderr }) => stdout + stderr,
            )
          : "No owned container was created.\n";
        await writeFile(`${diagnostics}/failure-container.log`, logs);
        await writeFile(
          `${diagnostics}/failure-fixture.json`,
          JSON.stringify(
            {
              longLoads,
              longNotifications,
              longFailures,
              mediumLoads,
              mediumWatermarks: Object.fromEntries(mediumWatermarks),
              capacityMemoryBytes,
              telemetryRequests,
              requestPaths: seen.map(({ path }) => path),
              cleanupReceiptCount: cleanupReceipts.length,
              heldCleanup: heldCleanup
                ? {
                    traceparent: heldCleanup.traceparent,
                    status: heldCleanup.status,
                    complete: heldCleanup.complete,
                  }
                : null,
            },
            null,
            2,
          ) + "\n",
        );
      },
      cleanup: [
        async () => {
          releaseCleanup();
          interrupted.abort();
        },
        () =>
          removeBridgeDocker(cleanupDocker, {
            containers: [idleContainer, container],
            image,
            owner: suffix,
          }),
        closeTransport,
        ...fixtures.map((fixture) => fixture.close),
        async () => {
          signal.removeEventListener("abort", releaseCleanup);
          signal.removeEventListener("abort", stopTransport);
          process.off("SIGINT", onInterrupt);
          process.off("SIGTERM", onTerminate);
        },
      ],
    });
  },
);
