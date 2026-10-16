import assert from "node:assert/strict";
import { inspectPrivateNotificationReceipt } from "./acp-connection.mjs";
import { assertSecretFree } from "./evidence.mjs";
import {
  inspectPrivateACPUpgrade,
  privateACPProcessIdentity,
} from "../acp-plan/requests.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

export function privateNotificationExpectation(receipt) {
  inspectPrivateNotificationReceipt(receipt);
  assert.equal(
    receipt.method,
    "session/cancel",
    "only cancel notification is supported",
  );
  return Object.freeze({
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: receipt.version,
    agentId: receipt.agentId,
    sessionId: receipt.sessionId,
    method: receipt.method,
    connectionTraceID: receipt.connectionTraceID,
    clientSpanID: receipt.clientSpanID,
    notificationIndex: receipt.index,
  });
}

export function inspectPrivateNotificationConnection(
  receipt,
  raw,
  secrets = [],
) {
  const expected = privateNotificationExpectation(receipt);
  const upgrades = raw?.spans?.filter(
    (span) =>
      raw.processes?.[span.processID]?.serviceName === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.request.method") === "GET" &&
      tag(span, "http.route") === `/v${expected.protocolVersion}/acp`,
  );
  assert.equal(upgrades?.length, 1, "one actual ACP upgrade required");
  const bound = {
    ...expected,
    connectionTrace: raw,
    connectionSpanID: upgrades[0].spanID,
  };
  return { ...inspectPrivateACPUpgrade(bound, secrets), expected: bound };
}

// Match the correlation key before checking kind/operation/request ID. A
// malformed competing candidate on this connection must not disappear.
function linked(span, expected) {
  return span.references?.some(
    (ref) =>
      ref.refType === "FOLLOWS_FROM" &&
      ref.traceID === expected.connectionTraceID &&
      ref.spanID === expected.connectionSpanID,
  );
}

function uniqueAttributes(span) {
  const keys = (span.tags ?? []).map(({ key }) => key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    "duplicate notification span attribute",
  );
}

function matches(trace, span, expected) {
  return (
    trace.processes?.[span.processID]?.serviceName === "agent-acp-service" &&
    tag(span, "rpc.method") === expected.method &&
    tag(span, "antnest.agent.id") === expected.agentId &&
    tag(span, "antnest.session.id") === expected.sessionId &&
    tag(span, "antnest.protocol.version") === `v${expected.protocolVersion}` &&
    linked(span, expected)
  );
}

export function inspectPrivateNotificationTrace(
  trace,
  receipt,
  raw,
  secrets = [],
) {
  const connection = inspectPrivateNotificationConnection(
    receipt,
    raw,
    secrets,
  );
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  for (const span of trace.spans) {
    uniqueAttributes(span);
    const fields = [
      ...(span.tags ?? []),
      ...(span.logs ?? []).flatMap((event) => event.fields ?? []),
    ];
    assert(
      !fields.some(({ key }) =>
        /^(antnest\.payload\.json|rpc\.(request|response)\.(params|body|result))$/u.test(
          key,
        ),
      ),
      "notification content capture is disabled",
    );
  }
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "notification requires one ACP INTERNAL root");
  const notification = roots[0];
  assert(
    matches(trace, notification, connection.expected),
    "wrong private notification boundary",
  );
  assert.equal(notification.operationName, "acp session/cancel");
  assert.equal(tag(notification, "span.kind"), "internal");
  assert(
    !notification.tags.some(({ key }) => key === "antnest.request.id"),
    "notification must have no request ID attribute",
  );
  assert.equal(
    notification.references.length,
    1,
    "notification has ambiguous connection Links",
  );
  assert.deepEqual(
    privateACPProcessIdentity(trace, notification),
    connection.processIdentity,
    "notification process differs from its actual upgrade",
  );
  assert.equal(
    trace.spans.filter((span) => matches(trace, span, connection.expected))
      .length,
    1,
    "duplicate notification boundary",
  );
  return { tree, notification, connection };
}

export function selectPrivateNotificationTrace(
  data,
  receipt,
  raw,
  secrets = [],
) {
  const connection = inspectPrivateNotificationConnection(
    receipt,
    raw,
    secrets,
  );
  assert(
    Array.isArray(data) && data.length < 100,
    "notification query invalid or truncated",
  );
  assert.equal(
    new Set(data.map((trace) => trace.traceID)).size,
    data.length,
    "duplicate notification candidate",
  );
  // A conflicting first tag must not hide an actual-connection competitor
  // before matching reads the Agent/Session/method/version values.
  for (const trace of data)
    for (const span of trace.spans ?? [])
      if (linked(span, connection.expected)) uniqueAttributes(span);
  const selected = data.flatMap((trace) =>
    (trace.spans ?? [])
      .filter((span) => matches(trace, span, connection.expected))
      .map(() => trace),
  );
  assert(selected.length <= 1, "ambiguous notification on actual connection");
  if (!selected.length) return;
  inspectPrivateNotificationTrace(selected[0], receipt, raw, secrets);
  return selected[0].traceID;
}
