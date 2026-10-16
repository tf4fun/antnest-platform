import assert from "node:assert/strict";
import { hostname } from "node:os";
import { inspect } from "node:util";
import {
  acp,
  authHeaders,
  bounded,
  httpFixture,
  turn,
} from "../../e2e/identity-closeout/private-acp-http.fixture.mjs";
import { evidenceDirectory, writeEvidenceFile } from "../storage.mjs";

// The fixture installs the repository's locked dependency mappings before
// these modules (including TypeScript production imports) are resolved.
const [
  { createPrivateACPHTTP },
  { context, propagation, trace },
  { core, node, resources, tracing },
  { OTLPTraceExporter },
  { configureBoundaries },
  { observeHttpRequest },
] = await Promise.all([
  import("../../e2e/identity-closeout/private-acp-http.mjs"),
  import("@opentelemetry/api"),
  import("@opentelemetry/sdk-node"),
  import("@opentelemetry/exporter-trace-otlp-http"),
  import("../../../services/agent-acp-service/src/telemetry/diagnostics.ts"),
  import("../../../services/agent-acp-service/src/telemetry/http.ts"),
]);

// Run with the service's locked tsx loader. This observes actual SDK/HTTP and
// production SERVER instrumentation in one process; it does not calibrate two
// processes, change timestamps, waive diagnostics, or replace a Docker gate.
const directory = evidenceDirectory(process.argv[2]);
assert(directory, "private diagnostic evidence directory required");
const iterations = Number(process.argv[3] ?? 10);
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 20);
const fault = process.argv[4] ?? null;
assert([null, "setup", "open-and-cleanup"].includes(fault));
const records = [];

for (let iteration = 0; iteration < iterations; iteration++) {
  const cleanup = [],
    events = [],
    pending = new Set(),
    failures = [],
    wire = [];
  const event = (kind, fields = {}) => {
    events.push({
      kind,
      monotonic_ns: process.hrtime.bigint().toString(),
      unix_ms: Date.now(),
      ...fields,
    });
  };
  let f, provider, http, received;
  try {
    f = await httpFixture(
      { after: (fn) => cleanup.push(fn) },
      {
        shutdownTelemetry: async (shutdownClient) => {
          const errors = [];
          // The fixture has already closed the SDK peer. Join API responses while
          // the real OTLP receiver is still listening, then drain both providers.
          for (const finish of [
            () => f.joinResponses(),
            () => Promise.all(pending),
            () => provider?.forceFlush(),
            () => provider?.shutdown(),
            shutdownClient,
          ]) {
            try {
              await finish();
            } catch (error) {
              errors.push(error);
            }
          }
          if (fault === "open-and-cleanup")
            errors.push(new Error("intentional diagnostic cleanup failure"));
          if (errors.length)
            throw new AggregateError(
              errors,
              "diagnostic telemetry cleanup failed",
            );
        },
      },
    );
    provider = new node.NodeTracerProvider({
      resource: resources.defaultResource().merge(
        resources.resourceFromAttributes({
          "service.name": "acp-http-boundary-diagnostic",
          "host.name": hostname(),
          "process.pid": process.pid,
          "process.runtime.name": "nodejs",
          "service.instance.id": `${hostname()}:${process.pid}`,
        }),
      ),
      spanProcessors: [
        {
          onStart() {},
          onEnd(span) {
            event("server_span_ended", {
              trace_id: span.spanContext().traceId,
              span_id: span.spanContext().spanId,
            });
          },
          forceFlush: async () => {},
          shutdown: async () => {},
        },
        new tracing.BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${new URL(f.endpoint).origin}/v1/traces`,
            concurrencyLimit: 8,
          }),
        ),
      ],
    });
    provider.register({ propagator: new core.W3CTraceContextPropagator() });
    if (fault === "setup")
      throw new Error("intentional diagnostic setup failure");
    configureBoundaries({ captureRpcContent: false, disabled: false });
    const server = f.resources.server;
    const [handler] = server.listeners("request");
    assert.equal(server.listenerCount("request"), 1);
    server.removeListener("request", handler);
    server.on("request", (request, response) => {
      if (request.url === "/v1/traces") {
        const record = { chunks: [], complete: false };
        wire.push(record);
        request.on("data", (chunk) => record.chunks.push(Buffer.from(chunk)));
        request.once("end", () => {
          record.complete = true;
        });
        request.once("error", () => {
          record.failed = true;
        });
        return handler(request, response);
      }
      const [, trace_id, parent_span_id] =
        request.headers.traceparent.split("-");
      const fields = { trace_id, parent_span_id, method: request.method };
      response.once("finish", () => event("server_finish", fields));
      response.once("close", () =>
        event("server_close", {
          ...fields,
          writable_finished: response.writableFinished,
        }),
      );
      const task = observeHttpRequest(request, response, async () =>
        handler(request, response),
      );
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        (error) => {
          pending.delete(task);
          failures.push(error);
        },
      );
    });
    const telemetry = {
      ...f.telemetry,
      startHTTP(method) {
        const original = f.telemetry.startHTTP(method);
        const fields = {
          trace_id: original.traceID,
          span_id: original.clientSpanID,
          method,
        };
        return {
          ...original,
          end(...args) {
            event("client_end_enter", fields);
            original.end(...args);
            event("client_end_return", fields);
          },
        };
      },
    };
    http = f.register(
      createPrivateACPHTTP(f.endpoint, { telemetry, headersFor: authHeaders }),
    );
    const connection = acp.client().connect(http.stream);
    http.bindConnection(connection);
    await bounded(
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      }),
    );
    http.completeInitialization();
    if (fault === "open-and-cleanup")
      throw new Error("intentional diagnostic open failure");
    for (const count of [12, 7, 4, 3]) {
      const session = await bounded(
        connection.agent.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        }),
      );
      for (let index = 0; index < count; index++)
        assert.equal(
          (
            await bounded(
              connection.agent.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "diagnostic" }],
              }),
            )
          ).stopReason,
          "end_turn",
        );
    }
    await bounded(
      (async () => {
        while (http.snapshot().requests.some((item) => item.status === null))
          await turn();
      })(),
    );
    event("connection_close_enter");
    await bounded(http.closeAndWait());
    event("connection_close_return");
    await f.joinResponses();
    await Promise.all(pending);
    await telemetry.flush();
    await provider.forceFlush();
    const receipt = http.snapshot();
    assert.equal(receipt.requests.length, 37);
    assert.equal(receipt.pendingRequests, 0);
    assert.deepEqual(receipt.failures, []);
    const spans = f.spans();
    const pairs = receipt.requests
      .filter((item) => item.method === "GET")
      .map((item) => {
        const client = spans.filter(
          (span) =>
            span.traceId === item.traceID && span.spanId === item.clientSpanID,
        );
        const received = spans.filter(
          (span) =>
            span.traceId === item.traceID &&
            span.parentSpanId === item.clientSpanID &&
            span.kind === 2,
        );
        assert.equal(client.length, 1);
        assert.equal(received.length, 1);
        const one = (kind, id) => {
          const values = events.filter(
            (entry) =>
              entry.kind === kind &&
              entry.trace_id === item.traceID &&
              (entry.span_id ?? entry.parent_span_id) === id,
          );
          assert.equal(values.length, 1, kind);
          return values[0];
        };
        const local = one("client_end_return", item.clientSpanID);
        const entering = one("client_end_enter", item.clientSpanID);
        const remote = one("server_span_ended", received[0].spanId);
        const closed = one("server_close", item.clientSpanID);
        assert.equal(closed.writable_finished, false);
        assert(BigInt(remote.monotonic_ns) >= BigInt(closed.monotonic_ns));
        assert.equal(item.bodyOutcome, "cancelled");
        assert(item.events.some((entry) => entry.kind === "body_closed"));
        return {
          request_index: item.index,
          trace_id: item.traceID,
          client_span_id: item.clientSpanID,
          server_span_id: received[0].spanId,
          raw_end_difference_ns: (
            BigInt(received[0].endTimeUnixNano) -
            BigInt(client[0].endTimeUnixNano)
          ).toString(),
          observed_end_difference_min_ns: (
            BigInt(closed.monotonic_ns) - BigInt(local.monotonic_ns)
          ).toString(),
          observed_end_difference_max_ns: (
            BigInt(remote.monotonic_ns) - BigInt(entering.monotonic_ns)
          ).toString(),
        };
      });
    assert.equal(pairs.length, 5);
    records.push({
      iteration,
      receipt,
      events,
      decoded_otlp: f.exports,
      pairs,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    // The fixture joins clients with allSettled. Capture this client's original
    // rejection separately so a business failure cannot hide DELETE/close failure.
    try {
      await http?.closeAndWait();
    } catch (error) {
      failures.push(error);
    }
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    trace.disable();
    context.disable();
    propagation.disable();
    received = wire.map(({ chunks, ...rest }) => ({
      ...rest,
      body_base64: Buffer.concat(chunks).toString("base64"),
    }));
    try {
      writeEvidenceFile(
        directory,
        `iteration-${iteration}.private.json`,
        JSON.stringify({
          iteration,
          receipt: http?.snapshot(),
          events,
          decoded_otlp: f?.exports,
          original_otlp_http_bodies: received,
          failures: failures.map((error) => inspect(error, { depth: 8 })),
          cleanup: {
            listener_closed: !f?.resources.server.listening,
            observer_tasks: pending.size,
          },
        }) + "\n",
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "HTTP lifecycle diagnostic failed");
  assert.equal(f.resources.server.listening, false);
  assert.equal(pending.size, 0);
  assert(received.every((body) => body.complete && !body.failed));
  assert.deepEqual(
    received
      .map((body) =>
        JSON.stringify(JSON.parse(Buffer.from(body.body_base64, "base64"))),
      )
      .sort(),
    f.exports.map((body) => JSON.stringify(body)).sort(),
  );
}

const pairs = records.flatMap((record) => record.pairs);
const summary = {
  status: "diagnostic_complete",
  scope:
    "same-process actual private SDK HTTP and production ACP SERVER boundary over TCP/OTLP",
  host: hostname(),
  pid: process.pid,
  node: process.version,
  iterations,
  original_get_pairs: pairs.length,
  server_ends_after_client: pairs.filter(
    (pair) => BigInt(pair.observed_end_difference_min_ns) > 0n,
  ).length,
  server_ends_over_1ms_later: pairs.filter(
    (pair) => BigInt(pair.observed_end_difference_min_ns) >= 1_000_000n,
  ).length,
  maximum_proven_delay_ns: pairs
    .map((pair) => BigInt(pair.observed_end_difference_min_ns))
    .reduce((a, b) => (a > b ? a : b))
    .toString(),
  cross_process_clock_calibrated: false,
  timestamps_modified: false,
  strict_admission_changed: false,
};
writeEvidenceFile(
  directory,
  "get-close-timing.private.json",
  JSON.stringify({ summary, records }) + "\n",
);
console.log(JSON.stringify(summary));
