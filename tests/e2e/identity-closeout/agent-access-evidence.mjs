import assert from "node:assert/strict";
import { collectTrace } from "../observability/collect.mjs";
import {
  assertCaptureDisabled,
  owningServerTopology,
  traceTopology,
  traceTree,
} from "../observability/trace-tree.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { collectTrace as collectCompleteTrace } from "../managed-mcp/trace.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { saveSessionTrace } from "./session-trace.mjs";
import { assertMessageReplay } from "../acp-closeout/replay.mjs";

export function assertUnchanged(before, after) {
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    `denied operation or replay changed durable state/model activity: ${differencePath(before, after)}`,
  );
}

// A Runtime observation that finds the same condition refreshes only
// runtime_observed_at: no aggregate sequence, update time or event changes
// (docs/agent-lifecycle-state-model.md). Only that forward refresh is excused.
export function assertAgentsUnchanged(before, after) {
  assert(
    Array.isArray(before) && Array.isArray(after),
    "Agent evidence must be a list",
  );
  assertUnchanged(
    before,
    after.map((current, index) => {
      const previous = before[index]?.agent?.runtime_observed_at;
      const next = current?.agent?.runtime_observed_at;
      if (previous === next || previous === undefined) return current;
      assert(
        Date.parse(next) > Date.parse(previous),
        "Runtime observation time must not regress or disappear",
      );
      return {
        ...current,
        agent: { ...current.agent, runtime_observed_at: previous },
      };
    }),
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
  metadata,
  { alreadyAttached = false } = {},
) {
  assert(version === 1 || version === 2, "unsupported replay version");
  assert(
    updates.every((item) => item.sessionId === session),
    "foreign Session notification in replay",
  );
  assert(metadata?.id === session, "authoritative Session metadata missing");
  const infos = updates.filter(
    ({ update }) => update.sessionUpdate === "session_info_update",
  );
  assert(
    infos.length === 1 || (alreadyAttached && infos.length === 0),
    "missing or duplicate Session metadata",
  );
  if (infos.length)
    assert.deepEqual(infos[0].update, {
      sessionUpdate: "session_info_update",
      title: metadata.title,
      updatedAt: new Date(metadata.updated_at).toISOString(),
    });
  const history = persisted
    .filter((item) => item.session_id === session)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  assertMessageReplay(
    updates.filter(
      (item) =>
        item.update.sessionUpdate !== "session_info_update" &&
        (version !== 2 || item.update.sessionUpdate !== "state_update"),
    ),
    history.map((item) => ({
      ...item,
      payload: {
        ...item.payload,
        messageId:
          version === 1
            ? (item.payload.responseId ?? item.payload.messageId)
            : item.payload.messageId,
      },
    })),
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

export function assertDeniedSessionError(error, boundary = "organization") {
  assert(
    ["organization", "Agent"].includes(boundary),
    "unknown Session boundary",
  );
  assert(
    error?.code === -32020 &&
      error.message === `Session belongs to another ${boundary}`,
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
  assert.equal(
    original.state,
    "active",
    "replay fixture requires an active Session",
  );
  // Current identical client MCP configuration is idempotent; no revision,
  // pointer, timestamp, history or foreign-row mutation is permitted.
  assertUnchanged(before, after);
}

export function inspectAccessTrace(trace, expected, secrets) {
  traceTree(trace);
  return inspectAccessTraceTopology(trace, expected, secrets);
}

export function inspectAccessTraceTopology(trace, expected, secrets) {
  assert(
    trace?.traceID === expected.traceID && trace.spans?.length,
    "wrong or missing access trace",
  );
  const { service, chain: ancestors } = traceTopology(trace);
  assertCaptureDisabled(trace);
  assert(
    !expected.operation?.includes(".repository."),
    "Repository selectors are no longer supported",
  );
  const matches = expected.route
    ? [owningServerTopology(trace, expected).server]
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

export async function verifyAccessEvidence(base, expectations, secrets) {
  const results = [];
  for (const id of new Set(expectations.map((e) => e.traceID))) {
    assert.match(id ?? "", /^[a-f0-9]{32}$/);
    results.push(
      ...(await collectCompleteTrace(base, id, (trace) => {
        saveSessionTrace(trace);
        const checks = expectations
          .filter((e) => e.traceID === id)
          .map((e) => inspectAccessTraceTopology(trace, e, secrets));
        const warnings = [
          ...(trace.warnings ?? []),
          ...trace.spans.flatMap((s) => s.warnings ?? []),
        ];
        const errors = trace.spans.filter(hasError).length;
        return checks.map((c) => ({
          ...c,
          warning_count: warnings.length,
          warnings: [...new Set(warnings)],
          error_spans: errors,
          strict_trace: warnings.length || errors ? "failed" : "passed",
        }));
      })),
    );
  }
  return results;
}
