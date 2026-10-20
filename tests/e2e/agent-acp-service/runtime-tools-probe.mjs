import assert from "node:assert/strict";
import {
  verify,
  counterexamples,
  spansOf,
  expectedOutcome,
} from "./runtime-tools-evidence.mjs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { startTelemetry } from "./dist/telemetry/telemetry.js";
import { InstrumentedToolCatalog } from "./dist/telemetry/instrumented-ports.js";
import { OfficialMcpDialer } from "./dist/adapters/mcp/official-client.js";
import { McpToolCatalog } from "./dist/adapters/mcp/tool-catalog.js";

// Production SDK, instrumentation and exporter, with a controlled local MCP
// peer. Runtime authentication and the complete business workflow have separate gates.
const raw = [];
let changed = Promise.withResolvers();
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const modes = [
  ["list", "success"],
  ["call", "success"],
  ["call", "tool-error"],
  ["list", "http-error"],
  ["call", "http-error"],
  ["list", "caller-abort"],
  ["call", "caller-abort"],
];

function bounded(promise, signal) {
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([promise, interrupted]).finally(() =>
    signal.removeEventListener("abort", abort),
  );
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
function exported(request) {
  return spansOf(raw).find(
    (span) =>
      span.traceId === request.traceId && span.spanId === request.spanId,
  );
}
async function waitExport(request, signal) {
  for (;;) {
    const pending = changed.promise;
    if (exported(request)) return;
    await bounded(pending, signal);
  }
}

async function exercise(telemetry, method, mode) {
  const arrived = Promise.withResolvers();
  const releaseTool = Promise.withResolvers();
  const answered = Promise.withResolvers();
  const discoveryFinished = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const handlers = new Set();
  const failures = [];
  const requests = [];
  const order = [];
  const step = (phase) =>
    order.push({ phase, monotonic_ns: process.hrtime.bigint().toString() });
  const executionId = `runtime-tool-${method}-${mode}`;
  const caller = new AbortController();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("MCP tool probe deadline")),
    12000,
  );
  const signal = AbortSignal.any([caller.signal, deadline.signal]);
  let discovery, held, outcome, actual, failure, deadlineAt;
  const peer = createServer((request, response) => {
    const running = (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.method, "POST");
      assert.equal(
        request.headers["x-antnest-expected-execution-id"],
        executionId,
      );
      const parent = String(request.headers.traceparent ?? "");
      assert.match(parent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
      const [, traceId, spanId] = parent.split("-");
      requests.push({ method: message.method, traceId, spanId });
      if (message.method === "server/discover") {
        discovery = response;
        response.once("finish", () => discoveryFinished.resolve());
        response.writeHead(200, { "content-type": "text/event-stream" }).write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              ttlMs: 0,
              cacheScope: "private",
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
              _meta: {
                "io.modelcontextprotocol/serverInfo": {
                  name: "runtime-tool-peer",
                  version: "1",
                },
              },
            },
          })}\n\n`,
        );
        step("discovery-written");
        return;
      }
      assert.equal(message.method, `tools/${method}`);
      assert(discovery && !discovery.writableEnded && !discovery.destroyed);
      held = response;
      response.once("close", () => disconnected.resolve());
      step("tool-request-before-discovery-eof");
      arrived.resolve();
      await releaseTool.promise;
      step("tool-response");
      if (mode === "http-error")
        response
          .writeHead(503, { "content-type": "application/json" })
          .end("{}");
      else if (mode === "caller-abort")
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .write("event: message\ndata: ");
      else {
        const result =
          method === "list"
            ? {
                tools: [
                  {
                    name: "bash",
                    description: "PRIVATE-TOOL-DESCRIPTION",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : {
                content: [{ type: "text", text: "PRIVATE-TOOL-CONTENT" }],
                isError: mode === "tool-error",
                structuredContent: {
                  effect_state: mode === "tool-error" ? "none" : "settled",
                  effect_source: null,
                  ...(mode === "tool-error"
                    ? { error_code: "runtime_busy" }
                    : {}),
                },
              };
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result } })}\n\n`,
          );
      }
      answered.resolve();
    })().catch((error) => {
      failures.push(error);
      arrived.resolve();
      answered.resolve();
      response.destroy();
    });
    handlers.add(running);
    void running.finally(() => handlers.delete(running));
  });
  try {
    const endpoint = `${await listen(peer)}/mcp`;
    const catalog = new InstrumentedToolCatalog(
      new McpToolCatalog({
        runtimeDialer: new OfficialMcpDialer({
          trust: "runtime",
          connections: { fetchFor: () => fetch },
        }),
        revisions: { getClientMcpRevision: () => Promise.resolve([]) },
      }),
      telemetry,
    );
    const snapshot = {
      organizationId: "organization-1",
      providerConnectionId: "provider-1",
      configurationRevision: 1,
      agentSpecRevision: "spec-1",
      executionRevision: "execution-1",
      clientMcpRevisionId: "client-mcp-1",
      deadlineAt: new Date(Date.now() + 60000),
      executionSpec: {},
      runtime: {
        revision: "runtime-1",
        executionId,
        mcpEndpoint: endpoint,
        connectionId: "rci_11111111111111111111111111111111",
      },
    };
    deadlineAt = snapshot.deadlineAt.toISOString();
    const running =
      method === "list"
        ? catalog.list(snapshot, signal)
        : catalog.call({
            runId: "run-1",
            snapshot,
            signal,
            arguments: { command: "PRIVATE-TOOL-ARGUMENT" },
            tool: {
              source: "runtime",
              sourceId: "runtime",
              name: "bash",
              modelName: "bash",
              description: "PRIVATE-TOOL-DESCRIPTION",
            },
          });
    outcome = running.then(
      (result) => ({
        status: "resolved",
        ...(method === "list"
          ? { count: result.length }
          : {
              isError: result.isError,
              toolEffectState: result.toolEffectState,
              runtimeCallStopped: result.runtimeCallStopped,
            }),
      }),
      (error) => ({
        status: "rejected",
        error: {
          name: error.name,
          ...(method === "call"
            ? {
                effectState: error.effectState,
                runtimeCallStopped: error.runtimeCallStopped,
                cause: { name: error.cause?.name, code: error.cause?.code },
              }
            : { code: error.code }),
        },
      }),
    );
    await bounded(arrived.promise, deadline.signal);
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 2);
    assert(discovery && !discovery.writableEnded && !discovery.destroyed);
    assert.equal(exported(requests[0]), undefined);
    step("discovery-eof-released");
    discovery.end();
    await bounded(discoveryFinished.promise, deadline.signal);
    await waitExport(requests[0], deadline.signal);
    step("discovery-eof-exported");
    releaseTool.resolve();
    await bounded(answered.promise, deadline.signal);
    if (mode === "caller-abort") caller.abort();
    actual = await bounded(outcome, deadline.signal);
    assert.deepEqual(actual, expectedOutcome(method, mode));
    assert.equal(
      actual.status,
      mode === "success" || mode === "tool-error" ? "resolved" : "rejected",
    );
    if (actual.status === "resolved") {
      if (method === "list") assert.equal(actual.count, 1);
      else
        assert.deepEqual(actual, {
          status: "resolved",
          isError: mode === "tool-error",
          toolEffectState: mode === "tool-error" ? "none" : "settled",
          runtimeCallStopped: true,
        });
    } else if (method === "call")
      assert.deepEqual(actual.error, {
        name: "McpToolCallError",
        effectState: "unknown",
        runtimeCallStopped: false,
        cause: expectedOutcome(method, mode).error.cause,
      });
    await bounded(disconnected.promise, deadline.signal);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    releaseTool.resolve();
    caller.abort();
    discovery?.destroy();
    held?.destroy();
    const cleanup = AbortSignal.timeout(3000);
    const settled = await Promise.allSettled([
      bounded(closeServer(peer), cleanup),
      bounded(Promise.all([...handlers]), cleanup),
      bounded(outcome ?? Promise.resolve(), cleanup),
    ]);
    for (const item of settled)
      if (item.status === "rejected") failures.push(item.reason);
    emit({
      event: "runtime_tools_peer_receipt",
      method,
      mode,
      executionId,
      deadlineAt,
      requests,
      order,
      outcome: actual ?? null,
      complete: !failure && !failures.length,
    });
  }
  if (failure || failures.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...failures],
      `MCP tools/${method} ${mode} failed`,
    );
  return { method, mode, executionId, deadlineAt, requests, order, actual };
}

const failures = [],
  handlers = new Set();
const collector = createServer((request, response) => {
  const running = (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(request.url, "/v1/traces");
    raw.push(JSON.parse(body.toString("utf8")));
    emit({
      event: "runtime_tools_otlp_raw",
      sha256: createHash("sha256").update(body).digest("hex"),
      body_base64: body.toString("base64"),
    });
    changed.resolve();
    changed = Promise.withResolvers();
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  })().catch((error) => {
    failures.push(error);
    response.destroy();
  });
  handlers.add(running);
  void running.finally(() => handlers.delete(running));
});
let telemetry, failure, verified;
try {
  telemetry = await startTelemetry({
    serviceName: "agent-acp-service",
    endpoint: new URL(await listen(collector)),
    disabled: false,
    tracesEnabled: true,
    metricsEnabled: false,
    captureRpcContent: false,
  });
  const receipts = [];
  for (const [method, mode] of modes)
    receipts.push(await exercise(telemetry.telemetry, method, mode));
  await telemetry.shutdown();
  telemetry = undefined;
  assert.deepEqual(failures, []);
  const identity = `${hostname()}:${process.pid}`;
  const counts = verify(receipts, raw, identity);
  emit(counterexamples(receipts, raw, identity));
  verified = { event: "runtime_tools_verified", modes, ...counts };
} catch (error) {
  failure = error;
} finally {
  const signal = AbortSignal.timeout(5000);
  const settled = await Promise.allSettled([
    bounded(telemetry?.shutdown() ?? Promise.resolve(), signal),
    bounded(Promise.all([...handlers]), signal),
  ]);
  for (const item of settled)
    if (item.status === "rejected") failures.push(item.reason);
  try {
    await bounded(closeServer(collector), signal);
  } catch (error) {
    failures.push(error);
  }
}
if (failure || failures.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...failures],
    "ACP Runtime tools production probe failed",
  );
emit(verified);
