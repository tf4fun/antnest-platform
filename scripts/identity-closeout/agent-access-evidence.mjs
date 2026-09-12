import assert from "node:assert/strict";
import { collectTrace } from "../observability/collect.mjs";
import {
  assertCaptureDisabled,
  owningServer,
  traceTree,
} from "../observability/trace-tree.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { assertMessageReplay } from "../acp-closeout/replay.mjs";

export function assertUnchanged(before, after) {
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    `denied operation or replay changed durable state/model activity: ${differencePath(before, after)}`,
  );
}

function differencePath(before, after, path = []) {
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        return differencePath(before[key], after[key], [
          ...path,
          /^[a-zA-Z_0-9]+$/.test(key) ? key : "field",
        ]);
      }
    }
  }
  return path.join(".") || "root";
}

export function assertPrivateReplay(
  updates,
  session,
  phase,
  version,
  persisted,
) {
  assert(version === 1 || version === 2, "unsupported replay version");
  assert(
    updates.every((item) => item.sessionId === session),
    "foreign Session notification in replay",
  );
  const history = persisted
    .filter((item) => item.session_id === session)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  assertMessageReplay(
    updates.filter(
      (item) => version !== 2 || item.update.sessionUpdate !== "state_update",
    ),
    history,
    version,
  );
  const messageType = version === 1 ? "agent_message_chunk" : "agent_message";
  const messages = updates.filter((item) =>
    ["agent_message_chunk", "agent_message"].includes(
      item.update.sessionUpdate,
    ),
  );
  assert(
    messages.every((item) => item.update.sessionUpdate === messageType),
    "wrong replay message type for protocol version",
  );
  const blocks = messages.flatMap(({ update }) => {
    assert(
      Array.isArray(update.content) === (version === 2),
      "wrong replay content shape for protocol version",
    );
    return version === 1 ? [update.content] : update.content;
  });
  assert(
    blocks.every(
      (block) => block?.type === "text" && typeof block.text === "string",
    ),
    "fixture reply must contain only text",
  );
  const answer = blocks.map((block) => block.text).join("");
  assert(
    answer === `Private history ${phase}`,
    "replay answer contains missing or foreign history",
  );
  for (const candidate of ["v1-a", "v2-a", "v1-b", "v2-b"].filter(
    (p) => p !== phase,
  ))
    assert(
      !JSON.stringify(updates).includes(`Private history ${candidate}`),
      "foreign history in replay metadata",
    );
}

export function assertDeniedSessionError(error) {
  assert(
    error?.code === -32020 &&
      error.message === "Session belongs to another Agent",
    "foreign Session must return only the generic access error",
  );
  assert(
    error.data?.code === "session_access_denied" &&
      error.data.retryable === false &&
      Object.keys(error.data).sort().join(",") === "code,retryable",
    "Session denial must not carry additional data",
  );
}

export function assertNoNotifications(updates, offset) {
  assert(
    updates.length === offset,
    "denied request emitted Session notifications",
  );
}

export function assertReplayIsolation(before, after, session) {
  const original = before.acp_sessions.find((item) => item.id === session);
  const resumed = after.acp_sessions.find((item) => item.id === session);
  assert(original && resumed, "replayed Session missing");
  const priorIDs = new Set(before.client_mcp_revisions.map((item) => item.id));
  const added = after.client_mcp_revisions.filter(
    (item) => !priorIDs.has(item.id),
  );
  assert(
    added.length === 1 && added[0].session_id === session,
    "resume must create exactly one target MCP revision",
  );
  const nextRevision =
    1 +
    Math.max(
      0,
      ...before.client_mcp_revisions
        .filter((item) => item.session_id === session)
        .map((item) => Number(item.revision)),
    );
  assert(
    Number(added[0].revision) === nextRevision &&
      resumed.client_mcp_revision_id === added[0].id,
    "resume revision or pointer is incorrect",
  );
  // Resume replaces client MCP configuration; every other persisted byte remains authoritative.
  assertUnchanged(before, {
    ...after,
    acp_sessions: after.acp_sessions.map((item) =>
      item.id === session
        ? {
            ...item,
            updated_at: original.updated_at,
            client_mcp_revision_id: original.client_mcp_revision_id,
          }
        : item,
    ),
    client_mcp_revisions: after.client_mcp_revisions.filter(
      (item) => item.id !== added[0].id,
    ),
  });
}

export function inspectAccessTrace(trace, expected, secrets) {
  assert(
    trace?.traceID === expected.traceID && trace.spans?.length,
    "wrong or missing access trace",
  );
  const { service, chain: ancestors } = traceTree(trace);
  assertCaptureDisabled(trace);
  assert(
    !expected.operation?.includes(".repository."),
    "Repository selectors are no longer supported",
  );
  const matches = expected.route
    ? [owningServer(trace, expected).server]
    : trace.spans.filter(
        (span) =>
          service(span) === expected.service &&
          span.operationName === expected.operation &&
          (!expected.spanID || span.spanID === expected.spanID),
      );
  assert.equal(matches.length, 1, "missing/duplicate owning-service span");
  const chain = ancestors(matches[0]).map(service);
  const gateway = chain.indexOf("edge-gateway");
  assert(gateway > 0, "missing Gateway ancestry");
  for (const via of expected.via ?? [])
    assert(
      chain.slice(1, gateway).includes(via),
      "required intermediate service missing",
    );
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    operation: expected.route ?? expected.operation,
    capture_rpc_content: false,
    services: [...new Set(chain)],
    gateway_ancestry: true,
  };
}

export async function verifyAccessTraces(base, expectations, secrets, options) {
  const results = [];
  for (const traceID of new Set(expectations.map((item) => item.traceID))) {
    assert.match(traceID ?? "", /^[a-f0-9]{32}$/);
    results.push(
      ...(await collectTrace(
        base,
        traceID,
        (trace) =>
          expectations
            .filter((item) => item.traceID === traceID)
            .map((item) => inspectAccessTrace(trace, item, secrets)),
        undefined,
        options,
      )),
    );
  }
  return results;
}
