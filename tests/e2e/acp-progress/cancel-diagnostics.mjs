import assert from "node:assert/strict";
import { inspect } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { captureProgressConnection } from "./client-evidence.mjs";
import {
  collectPrivateACPTrace,
  collectPrivateACPNotificationTrace,
} from "../identity-closeout/private-acp-trace.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";

// Public diagnostics accept fixed values as well as fixed keys. Arbitrary
// operation names, tag values, error messages and raw frames stay private.
const services = new Set([
  "agent-acp-service",
  "antnest-runtime",
  "antnest-private-acp-client",
  "antnest-executor",
]);
const operations = new Set([
  "session/cancel",
  "acp session/cancel",
  "acp session/prompt",
  "acp.session.prompt",
  "acp.session.cancel",
  "executor.run",
  "agent.run",
  "mcp.tools.call",
  "mcp.stdio.call",
  "HTTP GET agent-acp-workspace",
  "HTTP GET /v1/acp",
  "HTTP GET /v2/acp",
]);
const enums = {
  "span.kind": ["client", "server", "internal", "producer", "consumer"],
  "rpc.method": [
    "session/prompt",
    "session/cancel",
    "tools/call",
    "tools/list",
    "initialize",
  ],
  "antnest.operation.phase": ["acp.dispatch", "execute", "cancel", "complete"],
  "antnest.outcome": [
    "success",
    "succeeded",
    "failed",
    "error",
    "rejected",
    "cancelled",
    "canceled",
    "completed",
    "not_received",
  ],
  "antnest.error.code": [
    "cancelled",
    "canceled",
    "protocol_failed",
    "runtime_barrier_required",
    "-32020",
  ],
  "antnest.error.type": ["DomainError", "AbortError", "TimeoutError", "Error"],
  "error.type": ["DomainError", "AbortError", "TimeoutError", "Error"],
  "otel.status_code": ["OK", "ERROR", "UNSET"],
  "executor.exit.classification": [
    "success",
    "failed",
    "canceled",
    "cancelled",
    "protocol_failed",
  ],
};
const milliseconds = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value / 1000)
    : null;
export function summarizeSpans(trace, originUs) {
  return (trace?.spans ?? [])
    .map((span) => {
      const fields = {};
      for (const { key, value } of span.tags ?? []) {
        if (Object.hasOwn(enums, key))
          fields[key] = enums[key].includes(value) ? value : "other";
        else if (
          ["http.status_code", "http.response.status_code"].includes(key)
        )
          fields[key] =
            Number.isInteger(value) && value >= 100 && value <= 599
              ? value
              : null;
      }
      const service = trace.processes?.[span.processID]?.serviceName;
      return {
        service: services.has(service) ? service : "other",
        operation: operations.has(span.operationName)
          ? span.operationName
          : "other",
        start_ms:
          typeof span.startTime === "number"
            ? milliseconds(span.startTime - originUs)
            : null,
        duration_ms: milliseconds(span.duration),
        ...fields,
      };
    })
    .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
}
export function summarizeFrames(frames) {
  const values = {
    status: ["pending", "in_progress", "completed", "failed", "cancelled"],
    state: ["idle", "running", "busy"],
    stopReason: [
      "end_turn",
      "cancelled",
      "_unresolved",
      "max_tokens",
      "max_turn_requests",
      "refusal",
    ],
  };
  return frames
    .map((frame) => frame.update)
    .filter((update) =>
      ["tool_call", "tool_call_update", "state_update"].includes(
        update?.sessionUpdate,
      ),
    )
    .map((update) => {
      const result = { update: update.sessionUpdate };
      for (const [key, allowed] of Object.entries(values))
        if (Object.hasOwn(update, key))
          result[key === "stopReason" ? "stop_reason" : key] = allowed.includes(
            update[key],
          )
            ? update[key]
            : "other";
      return result;
    });
}

function promptExpectation(connection, meta) {
  const rows = connection.evidence.filter(
    (row) => row.method === "session/prompt",
  );
  assert.equal(rows.length, 1, "one original prompt required for diagnosis");
  const row = rows[0];
  for (const [key, value] of Object.entries({
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: meta.version,
    agentId: meta.agentId,
    sessionId: meta.sessionId,
    inputSessionID: meta.sessionId,
    connectionTraceID: connection.connectionTraceID,
    clientSpanID: connection.clientSpanID,
  }))
    assert.equal(row[key], value, `foreign diagnostic prompt ${key}`);
  assert(typeof row.requestId === "string" && row.requestId.length > 0);
  const wire = connection.requests.filter(
    (request) => request.requestId === row.requestId,
  );
  assert.equal(wire.length, 1);
  assert.equal(wire[0].method, row.method);
  assert.equal(wire[0].sessionId, meta.sessionId);
  return row;
}
async function notificationReceipt(connection, meta) {
  const { privateNotificationExpectation } =
    await import("../identity-closeout/private-acp-notification.mjs");
  assert.equal(
    connection.notifications.length,
    1,
    "one original cancel notification required",
  );
  const receipt = connection.notifications[0],
    expected = privateNotificationExpectation(receipt);
  for (const [key, value] of Object.entries({
    protocolVersion: meta.version,
    agentId: meta.agentId,
    sessionId: meta.sessionId,
    connectionTraceID: connection.connectionTraceID,
    clientSpanID: connection.clientSpanID,
  }))
    assert.equal(
      expected[key],
      value,
      `foreign diagnostic notification ${key}`,
    );
  return receipt;
}

// This function only explains an already failed cancellation. Its independent
// budget never grants business admission or rewrites the original ten seconds.
export async function cancelDiagnostics({
  jaeger,
  phase,
  version,
  source,
  agentId,
  sessionId,
  cancelAt,
  cancelStarted,
  client,
  stopped,
  directory,
  flush,
  secrets = [],
  signal,
  lateBudgetMs = 30000,
  budgetMS = 60000,
  pollMs = 250,
  now = () => performance.now(),
  wait = delay,
  request = fetch,
  attempts = 40,
}) {
  assert([1, 2].includes(version));
  assert(["bash", "managed"].includes(source));
  assert.equal(phase, `v${version}-${source}-cancel`);
  assert(typeof agentId === "string" && agentId.length > 0);
  assert(typeof sessionId === "string" && sessionId.length > 0);
  assert(Number.isFinite(cancelAt) && Number.isFinite(cancelStarted));
  assert(
    Number.isSafeInteger(lateBudgetMs) &&
      lateBudgetMs > 0 &&
      lateBudgetMs <= 30000,
  );
  assert(Number.isSafeInteger(budgetMS) && budgetMS > 0 && budgetMS <= 60000);
  assert(Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= 1000);
  directory = evidenceDirectory(directory);
  assert(directory);
  shellStoragePreflight(directory);
  const preservation = new AbortController();
  const bounded = AbortSignal.any([
    AbortSignal.timeout(budgetMS),
    preservation.signal,
    ...(signal ? [signal] : []),
  ]);
  const meta = {
    phase,
    version,
    source,
    ending: "cancel",
    agentId,
    sessionId,
    role: "prompt",
  };
  const record = {
    diagnostic: "cancel_timeout",
    context: meta,
    cancel_at_ms: cancelAt,
    results: [],
    errors: [],
    transport_errors: [],
  };
  const result = {
    phase,
    diagnostic: "cancel_timeout",
    admitted: false,
    stopped_after_ms: null,
    frames: [],
    traces: [],
    errors: [],
  };
  const save = () =>
    writeEvidenceFile(
      directory,
      `cancel-timeout-${phase}.private.json`,
      JSON.stringify(record, null, 2) + "\n",
    );
  save();
  const transportFailure = (stage, address, error) => {
    record.transport_errors.push({
      stage,
      ...(address === undefined ? {} : { url: String(address) }),
      original: inspect(error, {
        depth: null,
        maxArrayLength: null,
        maxStringLength: null,
      }),
    });
    try {
      save();
    } catch (storage) {
      const failure = new AggregateError(
        [error, storage],
        "Progress transport failure evidence could not be saved",
        { cause: storage },
      );
      preservation.abort(failure);
      throw failure;
    }
  };
  // Observe the actual reader rather than inserting a new stream or rebuilding
  // the response. The shared collector still owns bytes, cancellation and join.
  const observedRequest = async (address, options) => {
    const observed = async (stage, action) => {
      try {
        return await action();
      } catch (error) {
        transportFailure(stage, address, error);
        throw error;
      }
    };
    const response = await observed("request", () => request(address, options));
    return {
      status: response.status,
      ok: response.ok,
      body: response.body && {
        getReader() {
          let reader;
          try {
            reader = response.body.getReader();
          } catch (error) {
            transportFailure("reader", address, error);
            throw error;
          }
          return {
            read: () => observed("read", () => reader.read()),
            cancel: (...args) =>
              observed("cancel", () => reader.cancel(...args)),
            releaseLock: () => {
              try {
                return reader.releaseLock();
              } catch (error) {
                transportFailure("release", address, error);
                throw error;
              }
            },
          };
        },
      },
    };
  };
  const attempt = async (step, action) => {
    try {
      return await action();
    } catch (error) {
      record.errors.push({
        step,
        original: inspect(error, {
          depth: null,
          maxArrayLength: null,
          maxStringLength: null,
        }),
      });
      result.errors.push({ step, error: "Error" });
      try {
        save();
      } catch (storage) {
        throw new AggregateError(
          [error, storage],
          "Progress diagnostic evidence preservation failed",
          { cause: storage },
        );
      }
    }
  };
  // Rejoin the original close even when a caller already attempted it. A failed
  // close cannot authorize a stale notification or a partial request inventory.
  const connection = await attempt("connection_close", () =>
    captureProgressConnection({ ...meta, client }),
  );
  record.frames = structuredClone(client.updates);
  result.frames = summarizeFrames(record.frames);
  if (connection) record.connection = connection;
  save();
  await attempt("late_stop", async () => {
    const end = cancelStarted + 10000 + lateBudgetMs;
    for (;;) {
      bounded.throwIfAborted();
      const current = now();
      assert(Number.isFinite(current) && current >= cancelStarted);
      const remaining = end - current;
      if (remaining < 1) return;
      const stoppedNow = await stopped({
        timeoutMS: Math.min(10000, remaining),
      });
      const after = now();
      assert(Number.isFinite(after) && after >= current);
      bounded.throwIfAborted();
      assert(after <= end, "late stop diagnostic deadline exceeded");
      assert.equal(typeof stoppedNow, "boolean");
      if (stoppedNow) {
        result.stopped_after_ms = after - cancelStarted;
        return;
      }
      await wait(Math.min(pollMs, Math.max(1, end - after)), undefined, {
        signal: bounded,
      });
    }
  });
  if (connection)
    for (const kind of ["prompt", "cancel"]) {
      await attempt(`${kind}_trace`, async () => {
        bounded.throwIfAborted();
        const options = {
          directory,
          flush: async () => {
            try {
              await flush();
            } catch (error) {
              transportFailure("CLIENT_export", undefined, error);
              throw error;
            }
          },
          secrets,
          signal: bounded,
          request: observedRequest,
          wait,
          attempts,
          sourceReceipt: true,
          inspect: (trace, bound) => ({
            trace_id: trace.traceID,
            spans: summarizeSpans(trace, cancelAt * 1000),
            connection_spans: summarizeSpans(
              bound.connectionTrace,
              cancelAt * 1000,
            ),
          }),
        };
        const collected =
          kind === "prompt"
            ? await collectPrivateACPTrace(
                jaeger,
                promptExpectation(connection, meta),
                options,
              )
            : await collectPrivateACPNotificationTrace(
                jaeger,
                await notificationReceipt(connection, meta),
                options,
              );
        bounded.throwIfAborted();
        record.results.push({ kind, result: collected });
        result.traces.push({
          kind,
          trace_id: collected.trace_id,
          spans: collected.spans,
          connection_spans: collected.connection_spans,
          warning_count: collected.warning_count,
          error_spans: collected.error_spans,
          strict_trace: collected.strict_trace,
        });
        save();
      });
    }
  record.summary = result;
  save();
  return result;
}
