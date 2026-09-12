import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { assertMessageReplay } from "./replay.mjs";
import {
  assertCaptureDisabled,
  owningServer,
  traceTree,
  tag,
} from "../observability/trace-tree.mjs";

export function assertConfiguredReplay(
  frames,
  persisted,
  version,
  configuration,
  loaded,
) {
  const events = persisted.filter((event) => event.kind === "configuration");
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].payload.configurationJson).modeId, "auto");
  assert(configuration.configOptions.length > 0);
  assert.deepEqual(
    loaded.configOptions,
    configuration.configOptions,
    "current configuration changed during recovery",
  );
  if (version === 1) assert.equal(loaded.modes.currentModeId, "auto");
  assertMessageReplay(
    frames,
    persisted.filter((event) => event.kind !== "configuration"),
    version,
  );
}

export function assertReceipts(kind, held, records) {
  assert.equal(held.delivery, "held");
  assert.equal(held.status, 200);
  assert.equal(held.method, `${kind}-run`);
  assert(held.admission_id && held.semantic_hash && held.response_hash);
  const retried = records.filter((record) => record.method === held.method);
  const other = records.filter((record) => record.method !== held.method);
  assert.equal(retried.length, 2, "missing or repeated recovery RPC");
  assert.equal(other.length, 1, "unexpected companion RPC count");
  assert.equal(
    other[0].method,
    kind === "acquire" ? "finish-run" : "acquire-run",
  );
  assert.equal(other[0].delivery, "delivered");
  for (const record of records) {
    assert.equal(record.status, 200);
    for (const key of ["agent_id", "session_id", "admission_id"])
      assert.equal(record[key], held[key], `changed RPC ${key}`);
  }
  assert.deepEqual(
    retried.map((record) => record.delivery),
    ["dropped", "delivered"],
  );
  assert.notEqual(
    retried[0].traceparent.split("-")[1],
    retried[1].traceparent.split("-")[1],
    "recovery reused the original request trace",
  );
  for (const record of retried) {
    assert.equal(
      record.semantic_hash,
      held.semantic_hash,
      "changed recovery intent",
    );
    if (kind === "acquire") {
      assert.equal(record.request_id, held.request_id);
      assert.equal(
        record.response_hash,
        held.response_hash,
        "changed admitted snapshot",
      );
      assert.equal(record.execution_revision, held.execution_revision);
    }
  }
  const finishes = records.filter((record) => record.method === "finish-run");
  assert(finishes.every((record) => record.admission_state === "released"));
  assert.deepEqual(
    finishes.map((record) => record.finish_status),
    kind === "acquire" ? ["finished"] : ["finished", "already_finished"],
  );
}

export function assertTerminal(records, run) {
  const finishes = records.filter((record) => record.method === "finish-run");
  assert(finishes.length > 0, "missing Finish report");
  for (const finish of finishes)
    for (const key of [
      "terminal_class",
      "tool_effect_state",
      "unknown_effect_source",
      "stop_reason",
      "error_class",
    ])
      assert.equal(finish[key], run[key], `Finish differs from durable ${key}`);
}

export function inspectRpcTrace(
  trace,
  receipt,
  replay,
  secrets = [],
  original,
) {
  const [, traceID, spanID] = receipt.traceparent.split("-");
  assert.equal(trace?.traceID, traceID, "wrong RPC trace");
  const { spans, service, parent, chain: ancestors } = traceTree(trace);
  assertCaptureDisabled(trace);
  const client = spans.get(spanID),
    kind = receipt.method.replace("-", "_");
  assert(client, "receipt HTTP CLIENT missing");
  const rpc = parent(client);
  assert(rpc && service(rpc) === "agent-acp-service", "missing ACP RPC span");
  assert.equal(rpc.operationName, `agent_controller.${kind}`);
  assert.equal(
    trace.spans.filter(
      (span) =>
        service(span) === "agent-acp-service" &&
        span.operationName === rpc.operationName,
    ).length,
    1,
    "duplicate ACP business request",
  );
  assert.equal(tag(rpc, "request.id"), receipt.request_id);
  const gatewayAncestry = ancestors(rpc).some(
    (span) => service(span) === "edge-gateway",
  );
  assert.equal(
    gatewayAncestry,
    !replay,
    "incorrect Gateway/startup trace boundary",
  );
  assert(["acquire-run", "finish-run"].includes(receipt.method));
  const route = `/rpc/agent-controller/${receipt.method}`;
  const { server, database } = owningServer(trace, {
    service: "agent-controller",
    method: "POST",
    route,
    rpcMethod: `POST ${route}`,
    clientService: "agent-acp-service",
    clientSpanID: spanID,
    status: 200,
  });
  assert.notEqual(tag(server, "error"), true);
  assert(original, "original committed RPC receipt required");
  assert.equal(original.delivery, "held");
  assert.equal(original.status, 200);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.delivery, replay ? "delivered" : "dropped");
  for (const key of [
    "method",
    "agent_id",
    "session_id",
    "admission_id",
    "semantic_hash",
  ])
    assert(
      receipt[key] && receipt[key] === original[key],
      `changed RPC receipt ${key}`,
    );
  assert.equal(
    receipt.traceparent === original.traceparent,
    !replay,
    "wrong recovery receipt identity",
  );
  if (kind === "acquire_run") {
    for (const key of [
      "request_id",
      "execution_revision",
      "response_hash",
      "snapshot_hash",
    ])
      assert(
        receipt[key] && receipt[key] === original[key],
        `changed admitted ${key}`,
      );
  } else {
    assert.equal(original.finish_status, "finished");
    assert.equal(original.admission_state, "released");
    assert.equal(
      receipt.finish_status,
      replay ? "already_finished" : "finished",
    );
    assert.equal(receipt.admission_state, "released");
  }
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: traceID,
    spans: trace.spans.length,
    method: receipt.method,
    replay,
    replay_evidence: "committed_rpc_receipts",
    database_spans: database.length,
    capture_rpc_content: false,
    gateway_ancestry: gatewayAncestry,
    request_id: receipt.request_id,
    admission_id: receipt.admission_id,
  };
}
