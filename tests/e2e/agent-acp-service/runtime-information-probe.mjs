import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { startTelemetry } from "./dist/telemetry/telemetry.js";
import { OfficialMcpDialer } from "./dist/adapters/mcp/official-client.js";
import { McpToolCatalog } from "./dist/adapters/mcp/tool-catalog.js";

// Runs inside the production image. The peer controls MCP responses; the
// production SDK, parser, HTTP instrumentation and OTLP exporter remain real.
// Runtime credential admission has its own authentication and component gates.
const raw = [];
let exportChanged = Promise.withResolvers();
const failures = [];
const modes = [
  "success",
  "invalid-resource",
  "caller-abort",
  "http-error",
  "discovery-held",
];
const successfulRead = (mode) =>
  mode === "success" || mode === "discovery-held";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const expectedFailure = {
  "invalid-resource": {
    name: "DomainError",
    code: "invalid_runtime_information",
  },
  "caller-abort": { name: "SdkError", code: "REQUEST_TIMEOUT" },
  "http-error": { name: "SdkHttpError", code: "CLIENT_HTTP_NOT_IMPLEMENTED" },
};
const errorIdentity = (error) => ({ name: error?.name, code: error?.code });
const attributeValue = (value) =>
  value.arrayValue
    ? value.arrayValue.values.map(attributeValue)
    : (value.stringValue ??
      value.boolValue ??
      Number(value.intValue ?? value.doubleValue));
const attributes = (values = []) =>
  Object.fromEntries(
    values.map(({ key, value }) => [key, attributeValue(value)]),
  );
function attributeKeys(values, allowed) {
  assert(
    (values ?? []).every(({ key }) => allowed.includes(key)),
    "unexpected span or event attribute",
  );
  assert.equal(
    new Set((values ?? []).map(({ key }) => key)).size,
    (values ?? []).length,
  );
}

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

function exportedSpan(request) {
  return raw
    .flatMap((row) => JSON.parse(row.body.toString("utf8")).resourceSpans ?? [])
    .flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans))
    .find(
      (span) =>
        span.traceId === request.traceId && span.spanId === request.spanId,
    );
}

async function waitForExport(request, signal) {
  for (;;) {
    const changed = exportChanged.promise;
    const span = exportedSpan(request);
    if (span) return span;
    await bounded(changed, signal);
  }
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

async function exercise(mode) {
  const received = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const resourceArrived = Promise.withResolvers();
  const releaseResource = Promise.withResolvers();
  const discoveryFinished = Promise.withResolvers();
  const discoveryOrder = [];
  const discoveryStep = (phase) =>
    discoveryOrder.push({
      phase,
      monotonic_ns: process.hrtime.bigint().toString(),
    });
  const requests = [];
  const handlers = new Set();
  const peerFailures = [];
  const executionId = `runtime-read-${mode}`;
  const caller = new AbortController();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("MCP probe deadline")),
    10000,
  );
  const signal = AbortSignal.any([caller.signal, deadline.signal]);
  let held;
  let discovery;
  let bytes = 0;
  let outcome;
  let actual;
  let failure;
  const peer = createServer((request, response) => {
    const running = (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.method, "POST");
      assert(["server/discover", "resources/read"].includes(message.method));
      const parent = String(request.headers.traceparent ?? "");
      assert.match(parent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
      const [, traceId, spanId] = parent.split("-");
      const resource = message.method === "resources/read";
      requests.push({ traceId, spanId, resource });
      const result = {
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "runtime-info-peer",
            version: "1",
          },
        },
      };
      if (!resource) {
        Object.assign(result, {
          supportedVersions: ["2026-07-28"],
          capabilities: { resources: {} },
        });
        if (mode === "discovery-held") {
          discovery = response;
          response.once("finish", () => discoveryFinished.resolve());
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
          );
          discoveryStep("message-written");
        } else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        return;
      }
      assert.equal(message.params.uri, "antnest://runtime/info");
      held = response;
      response.once("close", () => disconnected.resolve());
      if (mode === "discovery-held") {
        assert(discovery && !discovery.writableEnded && !discovery.destroyed);
        discoveryStep("resource-request-before-eof");
        resourceArrived.resolve();
        await releaseResource.promise;
        discoveryStep("resource-response");
      }
      if (mode === "http-error") {
        response
          .writeHead(503, { "content-type": "application/json" })
          .end('{"error":"unavailable"}');
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "caller-abort") response.write("event: message\ndata: ");
        else {
          const information = {
            execution_id: executionId,
            environment: {
              os: "linux",
              arch: process.arch,
              home: "/workspace",
              workspace: "/workspace",
            },
            instructions: {
              path: { root: "workspace", path: "AGENTS.md" },
              content: "PRIVATE-RESOURCE-CONTENT",
              truncated: false,
            },
            skills: [],
            warnings: [],
            truncated: false,
          };
          result.contents = [
            {
              uri: "antnest://runtime/info",
              mimeType: "application/json",
              text:
                mode === "invalid-resource"
                  ? "{}"
                  : JSON.stringify(information),
            },
          ];
          const payload = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`;
          bytes = Buffer.byteLength(payload);
          response.write(payload);
        }
      }
      received.resolve();
    })().catch((error) => {
      peerFailures.push(error);
      received.resolve();
      response.destroy();
    });
    handlers.add(running);
    void running.finally(() => handlers.delete(running));
  });
  try {
    const endpoint = `${await listen(peer)}/mcp`;
    const catalog = new McpToolCatalog({
      runtimeDialer: new OfficialMcpDialer({
        trust: "runtime",
        connections: { fetchFor: () => fetch },
      }),
      revisions: { getClientMcpRevision: () => Promise.resolve([]) },
    });
    outcome = catalog
      .readBinding(
        {
          revision: "runtime-1",
          executionId,
          mcpEndpoint: endpoint,
          connectionId: "rci_11111111111111111111111111111111",
        },
        signal,
      )
      .then(
        (value) => ({ status: "resolved", executionId: value.executionId }),
        (error) => ({ status: "rejected", error: errorIdentity(error) }),
      );
    if (mode === "discovery-held") {
      await bounded(resourceArrived.promise, signal);
      assert(discovery && !discovery.writableEnded && !discovery.destroyed);
      assert.equal(requests.length, 2);
      assert.equal(exportedSpan(requests[0]), undefined);
      discoveryStep("eof-released");
      discovery.end();
      await bounded(discoveryFinished.promise, signal);
      // Await the unmodified production exporter, not a timer or a fabricated
      // EOF timestamp, before letting the peer answer the resource request.
      await waitForExport(requests[0], signal);
      discoveryStep("eof-exported");
      releaseResource.resolve();
    }
    await bounded(received.promise, signal);
    if (mode === "caller-abort") caller.abort();
    // The deadline remains independent of the deliberately cancelled caller.
    actual = await bounded(outcome, deadline.signal);
    assert.deepEqual(
      actual,
      successfulRead(mode)
        ? { status: "resolved", executionId }
        : { status: "rejected", error: expectedFailure[mode] },
    );
    await bounded(disconnected.promise, deadline.signal);
    assert.equal(requests.filter((row) => row.resource).length, 1);
    assert.equal(requests.length, 2);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    releaseResource.resolve();
    caller.abort();
    discovery?.destroy();
    held?.destroy();
    const cleanup = AbortSignal.timeout(3000);
    const settled = await Promise.allSettled([
      bounded(closeServer(peer), cleanup),
      bounded(Promise.all([...handlers]), cleanup),
      bounded(outcome ?? Promise.resolve(), cleanup),
    ]);
    for (const result of settled)
      if (result.status === "rejected") peerFailures.push(result.reason);
    emit({
      event: "runtime_information_peer_receipt",
      mode,
      executionId,
      bytes,
      requests,
      discoveryOrder,
      outcome: actual ?? null,
      complete: !failure && peerFailures.length === 0,
      failures: [...(failure ? [failure] : []), ...peerFailures].map(
        errorIdentity,
      ),
    });
  }
  if (failure || peerFailures.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...peerFailures],
      `MCP ${mode} failed`,
    );
  return {
    mode,
    executionId,
    bytes,
    requests,
    discoveryOrder,
    outcome: actual,
  };
}

function verify(receipts, evidence = raw) {
  const timeObservations = [];
  const groups = evidence.flatMap(
    (row) => JSON.parse(row.body.toString("utf8")).resourceSpans ?? [],
  );
  assert(groups.length > 0, "production exporter produced no traces");
  for (const group of groups) {
    const resource = attributes(group.resource.attributes);
    assert.equal(resource["service.name"], "agent-acp-service");
    assert.equal(
      resource["service.instance.id"],
      hostname() + ":" + process.pid,
    );
  }
  const spans = groups.flatMap((group) =>
    group.scopeSpans.flatMap((scope) => scope.spans),
  );
  assert.equal(
    spans.length,
    receipts.reduce((n, receipt) => n + receipt.requests.length + 1, 0),
  );
  assert.equal(
    new Set(spans.map((span) => span.traceId + ":" + span.spanId)).size,
    spans.length,
  );
  for (const span of spans) {
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    assert(start <= end);
    assert.equal(Number(span.droppedAttributesCount ?? 0), 0);
    assert.equal(Number(span.droppedEventsCount ?? 0), 0);
    assert.equal(Number(span.droppedLinksCount ?? 0), 0);
    for (const event of span.events ?? []) {
      const at = BigInt(event.timeUnixNano);
      assert(start <= at && at <= end, "event outside its own span");
      assert.equal(Number(event.droppedAttributesCount ?? 0), 0);
      attributeKeys(
        event.attributes,
        (event.attributes ?? []).map(({ key }) => key),
      );
    }
  }
  const httpAttributes = [
    "http.request.method",
    "peer.service",
    "server.address",
    "server.port",
    "http.response.status_code",
    "http.response.body.size",
  ];
  const cancellation = {
    "antnest.cancellation.phase": "http.send_or_read",
    "antnest.cancellation.type": "AbortError",
  };
  for (const receipt of receipts) {
    const reads = spans.filter(
      (span) =>
        span.name === "mcp.runtime.info.read" &&
        attributes(span.attributes)["antnest.runtime.execution.id"] ===
          receipt.executionId,
    );
    assert.equal(reads.length, 1);
    const read = reads[0];
    assert.equal(Number(read.kind), 1);
    assert(
      !read.parentSpanId || /^0+$/u.test(read.parentSpanId),
      "read must be an actual root",
    );
    assert.equal((read.links ?? []).length, 0);
    const attrs = attributes(read.attributes);
    attributeKeys(read.attributes, [
      "antnest.runtime.execution.id",
      "antnest.mcp.resource_read.outcome",
      "antnest.mcp.connection.close.outcome",
      "antnest.mcp.caller_cancelled",
      ...(successfulRead(receipt.mode)
        ? []
        : ["error.type", "antnest.outcome", "antnest.operation.phase"]),
    ]);
    assert.equal(attrs["antnest.mcp.connection.close.outcome"], "closed");
    assert.equal(
      attrs["antnest.mcp.caller_cancelled"],
      receipt.mode === "caller-abort",
    );
    assert.equal(
      attrs["antnest.mcp.resource_read.outcome"],
      successfulRead(receipt.mode) ? "success" : "failed",
    );
    const children = spans.filter(
      (span) =>
        span.traceId === read.traceId && span.parentSpanId === read.spanId,
    );
    assert.deepEqual(
      children.map((span) => span.traceId + ":" + span.spanId).sort(),
      receipt.requests
        .map((request) => request.traceId + ":" + request.spanId)
        .sort(),
    );
    assert(children.every((span) => Number(span.kind) === 3));
    assert(children.every((span) => (span.links ?? []).length === 0));
    const resourceRequest = receipt.requests.find(
      (request) => request.resource,
    );
    const client = children.find(
      (span) => span.spanId === resourceRequest.spanId,
    );
    const clientAttrs = attributes(client.attributes);
    attributeKeys(client.attributes, [
      ...httpAttributes,
      "antnest.outcome",
      ...(receipt.mode === "http-error"
        ? []
        : ["antnest.operation.phase", "antnest.cancellation.type"]),
    ]);
    assert.equal(clientAttrs["http.request.method"], "POST");
    assert.equal(clientAttrs["peer.service"], "antnest-runtime");
    const handshake = children.find((span) => span !== client);
    const handshakeAttrs = attributes(handshake.attributes);
    attributeKeys(handshake.attributes, httpAttributes);
    assert.equal(Number(handshake.status?.code ?? 0), 0);
    assert.deepEqual(handshake.events ?? [], []);
    assert.equal(handshakeAttrs["http.response.status_code"], 200);
    assert.equal(handshakeAttrs["http.request.method"], "POST");
    assert.equal(handshakeAttrs["peer.service"], "antnest-runtime");
    assert.deepEqual(
      read.events.slice(0, 2).map((event) => event.name),
      ["antnest.mcp.discovery.ready", "antnest.mcp.resource.read.started"],
    );
    for (const event of read.events.slice(0, 2))
      assert.deepEqual(attributes(event.attributes), {});
    for (let i = 1; i < read.events.length; i++)
      assert(
        BigInt(read.events[i - 1].timeUnixNano) <=
          BigInt(read.events[i].timeUnixNano),
      );
    if (receipt.mode === "discovery-held") {
      assert.deepEqual(
        receipt.discoveryOrder.map((step) => step.phase),
        [
          "message-written",
          "resource-request-before-eof",
          "eof-released",
          "eof-exported",
          "resource-response",
        ],
      );
      for (let i = 1; i < receipt.discoveryOrder.length; i++)
        assert(
          BigInt(receipt.discoveryOrder[i - 1].monotonic_ns) <=
            BigInt(receipt.discoveryOrder[i].monotonic_ns),
        );
    } else assert.deepEqual(receipt.discoveryOrder, []);
    const closeEvents = read.events.filter((event) =>
      event.name.startsWith("antnest.mcp.connection.close."),
    );
    assert.deepEqual(
      closeEvents.map((event) => event.name),
      [
        "antnest.mcp.connection.close.started",
        "antnest.mcp.connection.close.completed",
      ],
    );
    assert.deepEqual(attributes(closeEvents[0].attributes), {
      "antnest.mcp.caller_cancelled": receipt.mode === "caller-abort",
    });
    assert.deepEqual(attributes(closeEvents[1].attributes), {
      outcome: "closed",
    });
    if (!successfulRead(receipt.mode)) {
      // Raw fixture failures independently prove the cause. Keep the existing
      // safeError projection; do not widen production diagnostic whitelists.
      const errorType =
        receipt.mode === "invalid-resource" ? "DomainError" : "Error";
      assert.equal(attrs["error.type"], errorType);
      assert.equal(attrs["antnest.operation.phase"], "mcp.runtime.info.read");
      assert.equal(
        attrs["antnest.outcome"],
        receipt.mode === "invalid-resource" ? "rejected" : "error",
      );
      assert.equal(
        Number(read.status?.code ?? 0),
        receipt.mode === "invalid-resource" ? 0 : 2,
      );
      assert.deepEqual(
        read.events.map((event) => event.name),
        [
          "antnest.mcp.discovery.ready",
          "antnest.mcp.resource.read.started",
          "antnest.error",
          "antnest.mcp.connection.close.started",
          "antnest.mcp.connection.close.completed",
        ],
      );
      assert.deepEqual(attributes(read.events[2].attributes), {
        "antnest.error.stage": "mcp.runtime.info.read",
        "antnest.error.type": errorType,
        "antnest.error.message": errorType + ": unregistered message omitted",
        "antnest.error.cause_types": [],
        "antnest.error.causes": JSON.stringify([
          {
            type: errorType,
            message: errorType + ": unregistered message omitted",
          },
        ]),
        "antnest.operation.phase": "mcp.runtime.info.read",
      });
      if (receipt.mode === "http-error") {
        assert.equal(clientAttrs["http.response.status_code"], 503);
        assert.equal(Number(client.status?.code), 2);
        assert.equal(clientAttrs["antnest.outcome"], "http_error");
        assert.deepEqual(client.events ?? [], []);
      } else {
        assert.equal(Number(client.status?.code ?? 0), 0);
        assert.equal(clientAttrs["antnest.outcome"], "cancelled");
        assert.equal(clientAttrs["antnest.cancellation.type"], "AbortError");
        assert.equal(
          clientAttrs["antnest.operation.phase"],
          "http.send_or_read",
        );
        assert.deepEqual(
          client.events.map((event) => event.name),
          ["antnest.cancelled"],
        );
        assert.deepEqual(attributes(client.events[0].attributes), cancellation);
        if (receipt.mode === "invalid-resource") {
          assert.equal(clientAttrs["http.response.status_code"], 200);
          assert.equal(clientAttrs["http.response.body.size"], receipt.bytes);
        }
      }
      continue;
    }
    assert.equal(Number(read.status?.code ?? 0), 0);
    assert.equal(Number(client.status?.code ?? 0), 0);
    assert.equal(clientAttrs["http.response.status_code"], 200);
    assert.equal(clientAttrs["http.response.body.size"], receipt.bytes);
    assert.equal(clientAttrs["antnest.outcome"], "cancelled");
    assert.equal(clientAttrs["antnest.cancellation.type"], "AbortError");
    assert.equal(clientAttrs["antnest.operation.phase"], "http.send_or_read");
    assert.deepEqual(
      client.events.map((event) => event.name),
      ["antnest.cancelled"],
    );
    assert.deepEqual(attributes(client.events[0].attributes), cancellation);
    assert.deepEqual(
      read.events.map((event) => event.name),
      [
        "antnest.mcp.discovery.ready",
        "antnest.mcp.resource.read.started",
        "antnest.mcp.resource.validated",
        "antnest.mcp.connection.close.started",
        "antnest.mcp.connection.close.completed",
      ],
    );
    assert.deepEqual(attributes(read.events[2].attributes), {});
    const [, , validated, started, completed] = read.events.map((event) =>
      BigInt(event.timeUnixNano),
    );
    const cancelled = BigInt(client.events[0].timeUnixNano);
    assert(validated <= started && started <= completed);
    for (const [boundary, excess] of [
      ["close.started", started - cancelled],
      ["close.completed", cancelled - completed],
    ]) {
      if (excess <= 0n) continue;
      assert.equal(client.parentSpanId, read.spanId);
      assert.equal(BigInt(read.startTimeUnixNano) % 1_000_000n, 0n);
      assert.equal(BigInt(client.startTimeUnixNano) % 1_000_000n, 0n);
      assert(excess < 1_000_000n);
      timeObservations.push({
        trace_id: read.traceId,
        read_span_id: read.spanId,
        client_span_id: client.spanId,
        boundary,
        raw_difference_ns: excess.toString(),
        read_start_ns: read.startTimeUnixNano,
        client_start_ns: client.startTimeUnixNano,
        cancelled_ns: cancelled.toString(),
        close_started_ns: started.toString(),
        close_completed_ns: completed.toString(),
        reason: "deferred-same-node-sdk-sub-ms-cross-span-event",
      });
    }
  }
  assert(
    !evidence.some((row) => row.body.includes("PRIVATE")),
    "private content escaped into OTLP",
  );
  return {
    traces: new Set(spans.map((span) => span.traceId)).size,
    spans: spans.length,
    timeObservations,
  };
}

function verifyCounterexamples(receipts) {
  const cases = [
    [
      "cancellation after its own CLIENT end",
      "success",
      (_read, children, receipt) => {
        const client = children.find(
          (span) =>
            span.spanId ===
            receipt.requests.find((request) => request.resource).spanId,
        );
        client.endTimeUnixNano = (
          BigInt(client.events[0].timeUnixNano) - 1n
        ).toString();
      },
    ],
    [
      "cancellation before its own CLIENT start",
      "success",
      (_read, children, receipt) => {
        const client = children.find(
          (span) =>
            span.spanId ===
            receipt.requests.find((request) => request.resource).spanId,
        );
        client.startTimeUnixNano = (
          BigInt(client.events[0].timeUnixNano) + 1n
        ).toString();
      },
    ],
    [
      "cancellation one millisecond after close",
      "success",
      (read, children, receipt) => {
        const client = children.find(
          (span) =>
            span.spanId ===
            receipt.requests.find((request) => request.resource).spanId,
        );
        client.events[0].timeUnixNano = (
          BigInt(read.events[4].timeUnixNano) + 1_000_000n
        ).toString();
        client.endTimeUnixNano = (
          BigInt(client.events[0].timeUnixNano) + 1n
        ).toString();
      },
    ],
    [
      "sub-millisecond difference without integer-ms SDK anchors",
      "success",
      (read, children, receipt) => {
        const client = children.find(
          (span) =>
            span.spanId ===
            receipt.requests.find((request) => request.resource).spanId,
        );
        client.startTimeUnixNano = (
          BigInt(client.startTimeUnixNano) + 1n
        ).toString();
        client.events[0].timeUnixNano = (
          BigInt(read.events[4].timeUnixNano) + 1n
        ).toString();
        client.endTimeUnixNano = (
          BigInt(client.events[0].timeUnixNano) + 1n
        ).toString();
      },
    ],
    [
      "success read ERROR",
      "success",
      (read) => {
        read.status = { code: 2 };
      },
    ],
    [
      "foreign root parent",
      "success",
      (read) => {
        read.parentSpanId = "f".repeat(16);
      },
    ],
    [
      "missing validated event",
      "success",
      (read) => {
        read.events.splice(2, 1);
      },
    ],
    [
      "duplicate close event",
      "success",
      (read) => {
        read.events.push(structuredClone(read.events[3]));
      },
    ],
    [
      "unexpected handshake error",
      "success",
      (_read, children, receipt) => {
        children.find(
          (span) =>
            span.spanId ===
            receipt.requests.find((request) => !request.resource).spanId,
        ).status = { code: 2 };
      },
    ],
    [
      "wrong parse rejection",
      "invalid-resource",
      (read) => {
        read.attributes.push({
          key: "antnest.error.code",
          value: { stringValue: "foreign" },
        });
      },
    ],
    [
      "wrong caller diagnostic",
      "caller-abort",
      (read) => {
        read.attributes.find(({ key }) => key === "error.type").value = {
          stringValue: "TypeError",
        };
      },
    ],
    [
      "missing HTTP failure status",
      "http-error",
      (_read, children, receipt) => {
        children.find(
          (span) =>
            span.spanId ===
            receipt.requests.find((request) => request.resource).spanId,
        ).status = { code: 0 };
      },
    ],
    [
      "legacy error flag",
      "success",
      (read) => {
        read.attributes.push({ key: "error", value: { boolValue: true } });
      },
    ],
    [
      "handshake exception field",
      "success",
      (_read, children, receipt) => {
        children
          .find(
            (span) =>
              span.spanId ===
              receipt.requests.find((request) => !request.resource).spanId,
          )
          .attributes.push({
            key: "exception.type",
            value: { stringValue: "Error" },
          });
      },
    ],
    [
      "resource exception field",
      "success",
      (_read, children, receipt) => {
        children
          .find(
            (span) =>
              span.spanId ===
              receipt.requests.find((request) => request.resource).spanId,
          )
          .attributes.push({
            key: "exception.type",
            value: { stringValue: "Error" },
          });
      },
    ],
    [
      "validated event error field",
      "success",
      (read) => {
        read.events[2].attributes.push({
          key: "error",
          value: { boolValue: true },
        });
      },
    ],
    [
      "missing discovery-ready event",
      "discovery-held",
      (read) => {
        read.events.shift();
      },
    ],
    [
      "dispatch before discovery-ready",
      "discovery-held",
      (read) => {
        [read.events[0], read.events[1]] = [read.events[1], read.events[0]];
      },
    ],
    [
      "dispatch after resource validation",
      "success",
      (read) => {
        read.events[1].timeUnixNano = (
          BigInt(read.events[2].timeUnixNano) + 1n
        ).toString();
      },
    ],
    [
      "discovery-ready content field",
      "discovery-held",
      (read) => {
        read.events[0].attributes.push({
          key: "content",
          value: { stringValue: "unexpected" },
        });
      },
    ],
  ];
  for (const [name, mode, mutate] of cases) {
    const copies = raw.map((row) => JSON.parse(row.body.toString("utf8")));
    const spans = copies.flatMap((row) =>
      row.resourceSpans.flatMap((group) =>
        group.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const receipt = receipts.find((row) => row.mode === mode);
    const read = spans.find(
      (span) =>
        span.name === "mcp.runtime.info.read" &&
        attributes(span.attributes)["antnest.runtime.execution.id"] ===
          receipt.executionId,
    );
    const children = spans.filter(
      (span) =>
        span.traceId === read.traceId && span.parentSpanId === read.spanId,
    );
    mutate(read, children, receipt);
    const changed = copies.map((row) => ({
      body: Buffer.from(JSON.stringify(row)),
    }));
    assert.throws(
      () => verify(receipts, changed),
      { code: "ERR_ASSERTION" },
      name,
    );
  }
  emit({
    event: "runtime_information_inspector_counterexamples",
    passed: cases.map(([name]) => name),
  });
}

let telemetry;
let failure;
let verified;
const handlers = new Set();
const collector = createServer((request, response) => {
  const running = (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    raw.push({ body });
    exportChanged.resolve();
    exportChanged = Promise.withResolvers();
    emit({
      event: "runtime_information_otlp_raw",
      path: request.url,
      sha256: createHash("sha256").update(body).digest("hex"),
      body_base64: body.toString("base64"),
    });
    assert.equal(request.url, "/v1/traces");
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  })().catch((error) => {
    failures.push(error);
    response.destroy();
  });
  handlers.add(running);
  void running.finally(() => handlers.delete(running));
});

try {
  const endpoint = await listen(collector);
  telemetry = await startTelemetry({
    serviceName: "agent-acp-service",
    endpoint: new URL(endpoint),
    disabled: false,
    tracesEnabled: true,
    metricsEnabled: false,
    captureRpcContent: false,
  });
  const receipts = [];
  for (const mode of modes) {
    const receipt = await exercise(mode);
    receipts.push(receipt);
  }
  await telemetry.shutdown();
  telemetry = undefined;
  assert.deepEqual(failures, []);
  const counts = verify(receipts);
  verifyCounterexamples(receipts);
  verified = { event: "runtime_information_verified", modes, ...counts };
} catch (error) {
  failure = error;
} finally {
  const cleanup = AbortSignal.timeout(5000);
  const settled = await Promise.allSettled([
    bounded(telemetry?.shutdown() ?? Promise.resolve(), cleanup),
    bounded(Promise.all([...handlers]), cleanup),
  ]);
  for (const result of settled)
    if (result.status === "rejected") failures.push(result.reason);
  try {
    await bounded(closeServer(collector), cleanup);
  } catch (error) {
    failures.push(error);
  }
}
if (failure || failures.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...failures],
    "ACP Runtime information production probe failed",
  );
emit(verified);
