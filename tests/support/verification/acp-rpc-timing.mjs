import "../../e2e/identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  durablePath,
  evidenceDirectory,
  writeEvidenceFile,
} from "../storage.mjs";
import {
  bracketOffsetBounds,
  clockOffsetBounds,
  intervalDifference,
  phaseOffsetBounds,
} from "./clock-interval.mjs";

const [
  { context, propagation, trace },
  { core, node, resources, tracing },
  { OTLPTraceExporter },
  { configureBoundaries },
  { observeHttpRequest },
  { applyExecutionConfiguration, EXECUTION_CONFIGURATION_PATH },
] = await Promise.all([
  import("@opentelemetry/api"),
  import("@opentelemetry/sdk-node"),
  import("@opentelemetry/exporter-trace-otlp-http"),
  import("../../../services/agent-acp-service/src/telemetry/diagnostics.ts"),
  import("../../../services/agent-acp-service/src/telemetry/http.ts"),
  import("../../../services/agent-acp-service/src/transport/execution-configuration.ts"),
]);

const binary = durablePath(process.argv[2]);
const directory = evidenceDirectory(process.argv[3]);
const count = Number(process.argv[4] ?? 100);
const fault = process.argv[5] ?? null;
assert(
  [
    null,
    "interrupt-before-child",
    "interrupt-rpc",
    "after-clock-failure",
    "interrupt-clock",
    "child-exits-with-open-pipe",
  ].includes(fault),
);
assert(
  directory && !existsSync(directory),
  "fresh private evidence directory required",
);
assert(Number.isSafeInteger(count) && count > 0 && count <= 1000);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const instance = `${hostname()}:${process.pid}:${process.hrtime.bigint()}`;
const clock = () => {
  const before = process.hrtime.bigint();
  const wall = Date.now();
  const after = process.hrtime.bigint();
  return {
    monotonic_before_ns: String(before),
    unix_ns: String(BigInt(wall) * 1_000_000n),
    monotonic_after_ns: String(after),
  };
};
const events = [],
  wire = [],
  errors = [],
  pending = new Set(),
  responses = [],
  output = [];
const event = (kind, fields) =>
  events.push({ kind, clock: clock(), ...fields });
let provider,
  child,
  childDone,
  server,
  go,
  summary,
  pairs,
  timer,
  killTimer,
  pipeTimer;
let interrupted = false,
  clocks = 0,
  childJoined = false;
const signalChildGroup = (signal) => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") errors.push(error);
  }
};
const terminateChild = () => {
  if (!child?.pid || childJoined) return;
  signalChildGroup("SIGTERM");
  killTimer ??= setTimeout(() => {
    if (childJoined) return;
    errors.push(
      new Error("diagnostic child group did not close; sent SIGKILL"),
    );
    signalChildGroup("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  }, 7_000);
};
const interrupt = (reason) => {
  interrupted = true;
  errors.push(new Error(`RPC timing diagnostic interrupted: ${reason}`));
  terminateChild();
};
const signals = ["SIGINT", "SIGTERM"].map((signal) => [
  signal,
  () => interrupt(signal),
]);
const bounded = async (promise, label, milliseconds = 6_000) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} deadline exceeded`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const readGoEvidence = () => {
  if (!go && child?.pid)
    go = JSON.parse(readFileSync(join(directory, "go.private.json"), "utf8"));
};
try {
  for (const [signal, listener] of signals) process.on(signal, listener);
  server = createServer((request, response) => {
    if (request.url === "/v1/traces") {
      const body = {
        content_type: request.headers["content-type"],
        chunks: [],
        complete: false,
      };
      wire.push(body);
      request.on("data", (chunk) => body.chunks.push(Buffer.from(chunk)));
      request.once("error", (error) => errors.push(error));
      request.once("end", () => {
        body.complete = true;
        if (body.content_type === "application/json") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        } else {
          response.writeHead(200, { "content-type": "application/x-protobuf" });
          response.end();
        }
      });
      return;
    }
    if (request.url === "/diagnostic/clock") {
      const received = clock();
      clocks++;
      if (fault === "interrupt-clock") process.kill(process.pid, "SIGTERM");
      if (fault === "after-clock-failure" && clocks === 6) {
        response.writeHead(503);
        response.end("intentional post-RPC clock failure");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      const sent = clock();
      response.end(
        JSON.stringify({ received, sent, pid: process.pid, instance }),
      );
      return;
    }
    if (request.url !== EXECUTION_CONFIGURATION_PATH) {
      response.writeHead(404);
      response.end();
      return;
    }
    const [, trace_id, parent_span_id] = request.headers.traceparent.split("-");
    const fields = { trace_id, parent_span_id };
    responses.push(
      new Promise((resolve) => {
        response.once("finish", () => {
          event("response_finish", fields);
          resolve();
        });
        response.once("close", () => {
          event("response_close", fields);
          resolve();
        });
      }),
    );
    const task = observeHttpRequest(
      request,
      response,
      () =>
        applyExecutionConfiguration(
          request,
          response,
          {
            async apply(input) {
              event("apply_enter", fields);
              if (fault === "interrupt-rpc") {
                const closed = new Promise((resolve) =>
                  response.once("close", resolve),
                );
                process.kill(process.pid, "SIGTERM");
                await closed;
                throw new Error("intentional interrupted RPC");
              }
              const applied = {
                organization_id: input.organization_id,
                applied_revision: input.revision,
              };
              event("apply_settled", fields);
              return applied;
            },
          },
          1024 * 1024,
        ),
      "control",
    );
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error) => {
        pending.delete(task);
        errors.push(error);
      },
    );
  });
  await bounded(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    "listener startup",
  );
  server.on("error", (error) => errors.push(error));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  provider = new node.NodeTracerProvider({
    resource: resources.defaultResource().merge(
      resources.resourceFromAttributes({
        "service.name": "acp-rpc-timing-diagnostic",
        "host.name": hostname(),
        "process.pid": process.pid,
        "service.instance.id": instance,
        "process.runtime.name": "nodejs",
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
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      new tracing.BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
          timeoutMillis: 2_000,
        }),
      ),
    ],
  });
  provider.register({ propagator: new core.W3CTraceContextPropagator() });
  configureBoundaries({ captureRpcContent: false, disabled: false });
  if (fault === "interrupt-before-child") {
    await bounded(
      new Promise((resolve) => {
        process.once("SIGTERM", resolve);
        process.kill(process.pid, "SIGTERM");
      }),
      "intentional signal delivery",
    );
  }
  assert(!interrupted, "diagnostic interrupted before child creation");
  child = spawn(
    binary,
    [endpoint, join(directory, "go.private.json"), String(count)],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
  childDone = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  writeEvidenceFile(
    directory,
    "child.private.json",
    JSON.stringify({ pid: child.pid }) + "\n",
  );
  child.once("exit", () => {
    pipeTimer = setTimeout(() => {
      if (childJoined) return;
      errors.push(new Error("exited diagnostic child left stdio open"));
      terminateChild();
    }, 1_000);
  });
  child.once("close", () => {
    childJoined = true;
    clearTimeout(killTimer);
    clearTimeout(pipeTimer);
  });
  timer = setTimeout(() => interrupt("operation deadline"), 45_000);
  const exit = await bounded(
    childDone,
    "Go diagnostic process and stdio",
    55_000,
  );
  clearTimeout(timer);
  readGoEvidence();
  assert.deepEqual(exit, { code: 0, signal: null }, "Go diagnostic failed");
  assert(!go.failure, "Go diagnostic failed");
  assert(!interrupted, "diagnostic interrupted");
  assert.equal(go.host, hostname());
  assert.notEqual(go.pid, process.pid);
  await bounded(Promise.all(pending), "HTTP observers");
  await bounded(Promise.all(responses), "HTTP responses");
  await bounded(provider.forceFlush(), "OTLP flush");
  assert(wire.every((body) => body.complete));
  const bodies = wire.map(({ chunks, ...rest }) => ({
    ...rest,
    body_base64: Buffer.concat(chunks).toString("base64"),
  }));
  const nodeBodies = bodies.filter(
    (body) => body.content_type === "application/json",
  );
  const goBodies = bodies.filter(
    (body) => body.content_type === "application/x-protobuf",
  );
  assert.equal(nodeBodies.length + goBodies.length, bodies.length);
  assert.deepEqual(
    goBodies.map((body) => body.body_base64).sort(),
    go.otlp_exports.map((body) => body.body_base64).sort(),
  );
  const spans = (body) =>
    body.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    );
  const servers = nodeBodies.flatMap((body) =>
    spans(JSON.parse(Buffer.from(body.body_base64, "base64"))),
  );
  const clients = go.otlp_exports.flatMap((body) => spans(body.decoded_otlp));
  assert.equal(servers.length, count);
  assert.equal(clients.length, count);
  assert.equal(go.spans.length, count);
  assert.equal(go.samples.length, count);
  const offset = (sample) => {
    assert.equal(sample.remote.pid, process.pid);
    assert.equal(sample.remote.instance, instance);
    return clockOffsetBounds({
      local_send_ns: sample.local_send.monotonic_before_ns,
      local_receive_ns: sample.local_receive.monotonic_after_ns,
      remote_receive_ns: sample.remote.received.monotonic_after_ns,
      remote_send_ns: sample.remote.sent.monotonic_before_ns,
    });
  };
  assert.equal(go.calibrations_per_phase, 5);
  const phase = (sample, name) => {
    assert.equal(sample[name].length, 5);
    const observations = sample[name].map((observation, sequence) => {
      assert.equal(observation.rpc_index, sample.index);
      assert.equal(observation.phase, name);
      assert.equal(observation.sequence, sequence);
      assert.equal(observation.failure, undefined);
      assert.equal(observation.status_code, 200);
      return offset(observation);
    });
    return phaseOffsetBounds(observations);
  };
  const one = (values, predicate, description) => {
    const found = values.filter(predicate);
    assert.equal(found.length, 1, description);
    return found[0];
  };
  pairs = go.samples.map((sample) => {
    assert.equal(sample.complete, true);
    assert.equal(sample.phase, "complete");
    const client = one(
      go.spans,
      (span) =>
        span.attributes["antnest.configuration.applied_revision"] ===
        sample.index + 1,
      "actual successful Go CLIENT",
    );
    const clientWire = one(
      clients,
      (span) =>
        Buffer.from(span.traceId, "base64").toString("hex") ===
          client.trace_id &&
        Buffer.from(span.spanId, "base64").toString("hex") === client.span_id,
      "original Go OTLP CLIENT",
    );
    assert.equal(clientWire.startTimeUnixNano, client.start_unix_ns);
    assert.equal(clientWire.endTimeUnixNano, client.end_unix_ns);
    const serverSpan = one(
      servers,
      (span) =>
        span.traceId === client.trace_id &&
        span.parentSpanId === client.span_id &&
        span.kind === 2,
      "original direct ACP SERVER",
    );
    const closed = one(
      go.events,
      (item) =>
        item.trace_id === client.trace_id &&
        item.span_id === client.span_id &&
        item.kind === "body_close_return",
      "Go Close return",
    );
    const finish = one(
      events,
      (item) =>
        item.trace_id === client.trace_id &&
        item.parent_span_id === client.span_id &&
        item.kind === "response_finish",
      "Node response finish",
    );
    const ended = one(
      events,
      (item) =>
        item.trace_id === client.trace_id &&
        item.span_id === serverSpan.spanId &&
        item.kind === "server_span_ended",
      "Node SERVER onEnd",
    );
    const before = phase(sample, "before");
    const after = phase(sample, "after");
    const bounds = before && after ? bracketOffsetBounds(before, after) : null;
    const difference = bounds
      ? intervalDifference(
          {
            lower_ns: finish.clock.monotonic_before_ns,
            upper_ns: ended.clock.monotonic_after_ns,
          },
          {
            lower_ns: closed.clock.monotonic_before_ns,
            upper_ns: client.clock.monotonic_after_ns,
          },
          bounds,
        )
      : null;
    return {
      index: sample.index,
      trace_id: client.trace_id,
      client_span_id: client.span_id,
      server_span_id: serverSpan.spanId,
      raw_end_difference_ns: String(
        BigInt(serverSpan.endTimeUnixNano) - BigInt(client.end_unix_ns),
      ),
      estimated_end_difference: difference,
      offset_bounds: bounds,
      phase_bounds: { before, after },
      estimated_end_order: !bounds?.overlaps
        ? "uncertain"
        : BigInt(difference.lower_ns) > 0n
          ? "server_later"
          : BigInt(difference.upper_ns) < 0n
            ? "server_earlier"
            : "uncertain",
    };
  });
  summary = {
    samples: count,
    node_pid: process.pid,
    go_pid: go.pid,
    raw_server_end_later: pairs.filter(
      (p) => BigInt(p.raw_end_difference_ns) > 0n,
    ).length,
    estimated_server_end_later: pairs.filter(
      (p) => p.estimated_end_order === "server_later",
    ).length,
    estimated_server_end_earlier: pairs.filter(
      (p) => p.estimated_end_order === "server_earlier",
    ).length,
    uncertain_order: pairs.filter((p) => p.estimated_end_order === "uncertain")
      .length,
    assumption:
      "same-rate process monotonic clocks and fixed offset within each five-exchange phase; endpoint envelope is assumed to cover the RPC but cannot exclude an unobserved clock step or drift; wall readings have unknown resolution and do not establish order",
    timestamps_modified: false,
    warning_admission_changed: false,
    historical_sample_attributed: false,
  };
} catch (error) {
  errors.push(error);
} finally {
  clearTimeout(timer);
  terminateChild();
  try {
    await bounded(childDone, "child cleanup", 9_000);
    readGoEvidence();
  } catch (error) {
    errors.push(error);
    signalChildGroup("SIGKILL");
    child?.stdout.destroy();
    child?.stderr.destroy();
  }
  clearTimeout(killTimer);
  clearTimeout(pipeTimer);
  // Unblock incomplete requests before joining observers on failure. Keep the
  // listener available for both providers' final original OTLP submissions.
  if (errors.length) server?.closeAllConnections();
  for (const [label, finish] of [
    ["HTTP observers", () => Promise.all(pending)],
    ["HTTP responses", () => Promise.all(responses)],
    ["OTLP flush", () => provider?.forceFlush()],
    ["OTLP shutdown", () => provider?.shutdown()],
    [
      "listener close",
      () =>
        new Promise((resolve, reject) => {
          if (!server?.listening) return resolve();
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ],
  ]) {
    try {
      await bounded(Promise.resolve().then(finish), label);
    } catch (error) {
      errors.push(error);
    }
  }
  trace.disable();
  context.disable();
  propagation.disable();
  for (const [signal, listener] of signals) process.off(signal, listener);
  for (const [name, contents] of [
    ["go-output.private.log", Buffer.concat(output)],
    [
      "node.private.json",
      JSON.stringify({
        summary,
        fault,
        pairs,
        events,
        original_otlp_http_bodies: wire.map(({ chunks, ...rest }) => ({
          ...rest,
          body_base64: Buffer.concat(chunks).toString("base64"),
        })),
        errors: errors.map((error) => inspect(error, { depth: 8 })),
        cleanup: {
          listener_closed: !server?.listening,
          observer_tasks: pending.size,
          child_pid: child?.pid,
          child_process_group: child?.pid,
          child_joined: childJoined,
          child_exit_code: child?.exitCode,
          child_signal: child?.signalCode,
        },
      }) + "\n",
    ],
  ]) {
    try {
      writeEvidenceFile(directory, name, contents);
    } catch (error) {
      errors.push(error);
    }
  }
}
if (errors.length)
  throw new AggregateError(
    errors,
    "cross-process RPC timing diagnostic failed",
  );
console.log(JSON.stringify(summary));
