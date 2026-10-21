import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { runtimeCommandId } from "./contracts.mjs";
import { inspectStage3LogoutBusiness } from "./logout-business.mjs";

const profiles = new Set([
  "base",
  "skill-delivery",
  "restart-rebuild",
  "registry-outage",
  "offline-reuse",
]);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, message) =>
  assert(condition, "Invalid Stage3 business completion: " + message);
const record = (value, message) => {
  check(isRecord(value), message);
  return value;
};
const list = (value, message) => {
  check(Array.isArray(value), message);
  return value;
};
const same = (left, right, message) =>
  check(isDeepStrictEqual(left, right), message);
const identifier = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/\s/u.test(value);
const resource = (kind, value) =>
  typeof value === "string" &&
  new RegExp(`^${kind}_[a-f0-9]{32}$`, "u").test(value);
const finite = (value) => Number.isFinite(value) && value >= 0;
const phaseForKind = {
  create: "initialize",
  disable: "disable",
  enable: "enable",
  rebuild: "update",
  delete: "delete",
};

function planFor(profile) {
  const plan = [];
  const add = (phase, version, transport, mode) =>
    plan.push({ phase, version, transport, mode });
  for (const [phase, version, transport] of [
    ["v1-baseline", 1, "websocket"],
    ["v2-baseline", 2, "websocket"],
    ["http-baseline", 1, "http"],
  ]) {
    add(phase, version, transport, "execute");
    add(phase, version, transport, "replay");
  }
  if (profile === "registry-outage" || profile === "offline-reuse") {
    add(profile, 1, "websocket", "execute");
    add(profile, 1, "websocket", "replay");
  }
  add("v1-baseline", 1, "websocket", "replay");
  add("after-rebuild", 2, "websocket", "execute");
  add("after-rebuild", 2, "websocket", "replay");
  for (const version of [1, 2]) {
    add(`logout-v${version}`, version, "websocket", "new");
    add(`logout-v${version}`, version, "websocket", "replay");
  }
  return plan;
}

function definitions(plan) {
  return plan.mode === "execute"
    ? [
        ["new", "new"],
        ["prompt", "prompt"],
      ]
    : plan.mode === "new"
      ? [["new", "new"]]
      : [
          ["list", "list"],
          [plan.version === 1 ? "load" : "resume", "replay"],
          ["resume", "resume"],
        ];
}

function initialization(result, version) {
  record(result, "original initialization result missing");
  check(result.protocolVersion === version, "initialization protocol changed");
  const meta = record(
    result._meta,
    "original initialization capability missing",
  );
  const errors = record(
    meta["antnest.dev/errors"],
    "original error capability missing",
  );
  check(errors.version === 1, "original error capability changed");
}

function bindRow(flat, original) {
  record(flat, "original request inventory row missing");
  for (const key of [
    "requestId",
    "method",
    "sessionId",
    "inputSessionID",
    "boundary",
    "agentId",
    "version",
    "protocolVersion",
    "transport",
    "kind",
    "label",
    "outcome",
    "phase",
  ])
    check(
      flat[key] === original[key],
      "request inventory differs from its original connection",
    );
  if (original.method === "initialize") {
    initialization(flat.initializationResult, original.version);
    initialization(original.initializationResult, original.version);
  } else {
    const receipt = record(
      flat.requestReceipt,
      "original request receipt missing",
    );
    const source = record(
      original.requestReceipt,
      "connection request receipt missing",
    );
    check(
      receipt.requestId === source.requestId,
      "request receipt identity changed",
    );
    same(
      receipt.params,
      source.params,
      "request input differs from its original connection",
    );
    same(
      receipt.result,
      source.result,
      "request result differs from its original connection",
    );
  }
}

function rpcResponses(connection, rows) {
  const frames = list(connection.raw_frames, "original RPC wire missing");
  const responses = frames.filter(
    (frame) =>
      isRecord(frame) &&
      Object.hasOwn(frame, "id") &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
  );
  check(
    responses.length === rows.length,
    "original RPC response inventory changed",
  );
  const ids = new Set();
  for (const row of rows) {
    check(
      identifier(row.requestId) && !ids.has(row.requestId),
      "duplicate original request identity",
    );
    ids.add(row.requestId);
    const matches = responses.filter(
      (frame) =>
        (typeof frame.id === "string" ||
          (typeof frame.id === "number" && Number.isSafeInteger(frame.id))) &&
        String(frame.id) === row.requestId,
    );
    check(matches.length === 1, "original RPC reply missing or duplicated");
    const reply = matches[0];
    check(
      reply.jsonrpc === "2.0" &&
        Object.hasOwn(reply, "result") &&
        !Object.hasOwn(reply, "error"),
      "original RPC did not succeed",
    );
    record(reply.result, "original RPC result missing");
    if (row.method === "initialize")
      initialization(reply.result, connection.version);
    else
      same(
        reply.result,
        row.requestReceipt.result,
        "RPC result differs from the original reply",
      );
  }
  if (connection.transport === "websocket") {
    const requests = list(
      connection.requests,
      "original socket request inventory missing",
    );
    check(requests.length === rows.length, "socket request inventory changed");
    for (const [index, row] of rows.entries()) {
      const request = record(
        requests[index],
        "original socket request missing",
      );
      check(
        request.requestId === row.requestId &&
          request.method === row.method &&
          (request.sessionId ?? null) === row.inputSessionID,
        "socket request identity or Session changed",
      );
    }
  }
}

function clock(value) {
  record(value, "HTTP observation clock missing");
  check(
    finite(value.monotonicMs) && finite(value.unixMs),
    "invalid HTTP observation clock",
  );
  return { monotonicMs: value.monotonicMs, unixMs: value.unixMs };
}

// Select only owned HTTP business fields. In particular, neither connection
// grouping nor response comparison consults diagnostic correlation fields.
function httpBusiness(snapshot) {
  record(snapshot, "original HTTP connection missing");
  check(
    snapshot.initialized === true &&
      snapshot.closing === true &&
      snapshot.streamJoined === true &&
      snapshot.pendingRequests === 0,
    "actual HTTP connection has not joined",
  );
  check(
    Array.isArray(snapshot.failures) && snapshot.failures.length === 0,
    "actual HTTP cleanup failed",
  );
  const receipts = list(snapshot.requests, "original HTTP wire missing");
  check(receipts.length > 0, "empty original HTTP wire");
  const initializations = receipts.filter(
    (row) =>
      isRecord(row) && row.method === "POST" && row.rpcMethod === "initialize",
  );
  const deletions = receipts.filter(
    (row) => isRecord(row) && row.method === "DELETE",
  );
  check(
    initializations.length === 1 && deletions.length === 1,
    "actual HTTP initialize or DELETE missing",
  );
  const initial = initializations[0],
    connectionID = initial.responseConnectionID;
  check(
    identifier(connectionID) &&
      initial.connectionID === null &&
      initial.bodyOutcome === "eof" &&
      deletions[0].bodyOutcome === "eof",
    "HTTP initialization or DELETE body did not complete",
  );
  const indices = new Set();
  const result = receipts.map((row) => {
    record(row, "original HTTP receipt missing");
    check(
      Number.isSafeInteger(row.index) &&
        row.index >= 0 &&
        !indices.has(row.index),
      "duplicate HTTP request index",
    );
    indices.add(row.index);
    check(
      ["POST", "GET", "DELETE"].includes(row.method) &&
        row.failed === false &&
        ["eof", "cancelled"].includes(row.bodyOutcome) &&
        Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0,
      "HTTP request or body did not complete",
    );
    const started = clock(row.started),
      ended = clock(row.ended);
    check(
      ended.monotonicMs >= started.monotonicMs,
      "HTTP completion preceded dispatch",
    );
    if (row !== initial)
      check(row.connectionID === connectionID, "foreign HTTP connection");
    if (row.wireStarted === false) {
      check(
        row.method === "GET" &&
          row.bodyOutcome === "cancelled" &&
          row.status === null,
        "only a pending Session GET may close before dispatch",
      );
    } else {
      check(
        row.wireStarted === true &&
          row.status === (row === initial || row.method === "GET" ? 200 : 202),
        "actual HTTP response status changed",
      );
    }
    const events = list(row.events, "HTTP body lifecycle missing").map(
      (event) => {
        record(event, "HTTP lifecycle receipt missing");
        return { kind: event.kind, ...clock(event) };
      },
    );
    if (row.wireStarted)
      check(
        events.some((event) => event.kind === "body_closed"),
        "HTTP body did not join",
      );
    return {
      index: row.index,
      method: row.method,
      connectionID: row.connectionID,
      sessionID: row.sessionID ?? null,
      status: row.status,
      bodyOutcome: row.bodyOutcome,
      bytes: row.bytes,
      failed: row.failed,
      wireStarted: row.wireStarted,
      started,
      ended,
      events,
      rpcMethod: row.rpcMethod ?? null,
      requestID: row.requestID ?? null,
      rpcSessionID: row.rpcSessionID ?? null,
      responseConnectionID: row.responseConnectionID ?? null,
    };
  });
  return { connectionID, receipts: result };
}

function httpConnection(connection, rows, sessionId) {
  const original = httpBusiness(connection.http_connection);
  const posts = original.receipts.filter((row) => row.method === "POST");
  check(posts.length === rows.length, "HTTP RPC request inventory changed");
  for (const row of rows) {
    same(
      httpBusiness(row.httpConnection),
      original,
      "request HTTP receipt differs from its owned connection",
    );
    const matches = posts.filter((wire) => wire.index === row.httpRequestIndex);
    check(matches.length === 1, "original HTTP RPC receipt missing");
    const wire = matches[0];
    check(
      wire.wireStarted === true &&
        wire.rpcMethod === row.method &&
        wire.requestID !== null &&
        String(wire.requestID) === row.requestId &&
        wire.rpcSessionID === row.inputSessionID &&
        wire.connectionID === row.connectionID,
      "HTTP RPC identity or input Session changed",
    );
  }
  for (const wire of original.receipts)
    check(
      wire.sessionID === null || wire.sessionID === sessionId,
      "foreign HTTP Session stream",
    );
}

function requestsFor(inventory, plan, agentId) {
  const requests = list(
    inventory.requests,
    "original request inventory missing",
  );
  const connections = list(
    inventory.connections,
    "original connection inventory missing",
  );
  check(
    connections.length === plan.length,
    "original connection inventory changed",
  );
  check(
    requests.length === (plan.length === 15 ? 51 : 44),
    "original request inventory changed",
  );
  const sessions = new Map(),
    createdSessions = new Set(),
    prompts = [],
    rowsByPhase = new Map();
  let offset = 0;
  for (const [index, expected] of plan.entries()) {
    const connection = record(
      connections[index],
      "original connection missing",
    );
    check(
      connection.agent_id === agentId &&
        connection.version === expected.version &&
        connection.transport === expected.transport &&
        connection.closed === true,
      "connection scope changed or actual close did not join",
    );
    const first = record(
      connection.initialization,
      "original initialize missing",
    );
    const evidence = list(
      connection.evidence,
      "original connection requests missing",
    );
    const required = definitions(expected);
    check(
      evidence.length === required.length,
      "connection request count changed",
    );
    const rows = [first, ...evidence];
    for (const row of rows) {
      record(row, "original connection request missing");
      check(
        row.boundary === "private-acp" &&
          row.agentId === agentId &&
          row.version === expected.version &&
          row.protocolVersion === expected.version &&
          row.transport === expected.transport &&
          row.outcome === "succeeded",
        "private request scope or outcome changed",
      );
      bindRow(requests[offset++], row);
    }
    const prefix =
      expected.version === 2
        ? "v2-ws"
        : expected.transport === "http"
          ? "v1-http"
          : "v1-ws";
    check(
      first.method === "initialize" &&
        first.kind === "request" &&
        first.inputSessionID === null &&
        first.label === prefix + ":initialize",
      "original initialization identity changed",
    );
    initialization(first.initializationResult, expected.version);
    for (const [position, [name, label]] of required.entries()) {
      const row = evidence[position];
      check(
        row.method === "session/" + name &&
          row.label === expected.phase + ":" + label &&
          row.kind === (name === "prompt" ? "ordinary" : "request"),
        "original request method or scenario changed",
      );
      const receipt = record(
        row.requestReceipt,
        "original request result missing",
      );
      check(
        receipt.requestId === row.requestId,
        "original request receipt identity changed",
      );
      const params = record(receipt.params, "original request input missing");
      const result = record(receipt.result, "original request output missing");
      if (name === "new") {
        check(
          row.inputSessionID === null &&
            resource("session", result.sessionId) &&
            row.sessionId === result.sessionId &&
            !sessions.has(expected.phase) &&
            !createdSessions.has(result.sessionId),
          "original Session creation identity changed",
        );
        check(params.cwd === "/workspace", "Session workspace changed");
        same(params.mcpServers, [], "Session MCP input changed");
        sessions.set(expected.phase, result.sessionId);
        createdSessions.add(result.sessionId);
      } else {
        const sessionId = sessions.get(expected.phase);
        check(
          resource("session", sessionId),
          "scenario has no original Session creation",
        );
        if (name === "list") {
          check(
            row.inputSessionID === null,
            "Session list gained an input Session",
          );
          same(params, {}, "Session list input changed");
          const listed = list(result.sessions, "original Session list missing");
          check(
            listed.filter(
              (item) => isRecord(item) && item.sessionId === sessionId,
            ).length === 1,
            "original Session missing or duplicated in list",
          );
        } else {
          check(
            row.inputSessionID === sessionId &&
              row.sessionId === sessionId &&
              params.sessionId === sessionId,
            "original request Session changed",
          );
          if (name === "prompt") {
            check(
              row.phase === expected.phase,
              "ordinary Prompt phase changed",
            );
            same(
              params.prompt,
              [{ type: "text", text: expected.phase }],
              "original Prompt input changed",
            );
            if (expected.version === 1)
              check(
                result.stopReason === "end_turn",
                "original Prompt did not complete",
              );
            else
              check(
                resource("message", result.messageId),
                "original v2 Prompt ACK missing",
              );
            prompts.push(row);
          } else {
            check(params.cwd === "/workspace", "replay workspace changed");
            same(params.mcpServers, [], "replay MCP input changed");
            same(
              params.replayFrom,
              expected.version === 2 && label === "replay"
                ? { type: "start" }
                : undefined,
              "original replay mode changed",
            );
          }
        }
      }
      const phaseRows = rowsByPhase.get(row.label) ?? [];
      phaseRows.push(row);
      rowsByPhase.set(row.label, phaseRows);
    }
    rpcResponses(connection, rows);
    if (expected.transport === "http") {
      httpConnection(connection, rows, sessions.get(expected.phase));
      for (let position = offset - rows.length; position < offset; position++)
        same(
          httpBusiness(requests[position].httpConnection),
          httpBusiness(connection.http_connection),
          "flat request HTTP closure differs from its connection",
        );
    }
  }
  check(offset === requests.length, "unowned original requests remain");
  return { requests, connections, sessions, prompts, rowsByPhase };
}

function lifecycleFor(business, inventory, profile, agentId) {
  const kinds = [
    "create",
    "disable",
    "enable",
    ...(profile === "offline-reuse" ? ["rebuild"] : []),
    "rebuild",
    "delete",
  ];
  same(business.lifecycle_kinds, kinds, "business lifecycle order changed");
  const lifecycle = list(
    inventory.lifecycle,
    "original lifecycle inventory missing",
  );
  const operations = list(
    business.runtime_operations,
    "original Runtime completions missing",
  );
  check(
    lifecycle.length === kinds.length && operations.length === kinds.length,
    "lifecycle completion inventory changed",
  );
  const ids = new Set(),
    revisions = new Set();
  for (const [index, kind] of kinds.entries()) {
    const row = record(lifecycle[index], "original lifecycle receipt missing");
    const operation = record(
      operations[index],
      "original Runtime completion missing",
    );
    check(
      row.kind === kind &&
        row.agentId === agentId &&
        identifier(row.requestId) &&
        !ids.has(row.requestId),
      "original lifecycle identity or order changed",
    );
    ids.add(row.requestId);
    check(
      operation.kind === kind &&
        operation.completed === true &&
        operation.request_id ===
          runtimeCommandId(row.requestId, "runtime_" + phaseForKind[kind]) &&
        resource("rtv", operation.target_revision) &&
        !revisions.has(operation.target_revision),
      "Runtime completion differs from the original lifecycle command",
    );
    revisions.add(operation.target_revision);
  }
  if (profile !== "base") {
    same(
      business.immutable_skill_versions,
      [1, 2],
      "immutable Skill versions changed",
    );
    check(
      business.registry_network_denial?.service_name === true &&
        business.registry_network_denial?.actual_ipv4_via_antnest0 === true,
      "actual Runtime Registry denial missing",
    );
  }
  if (profile === "restart-rebuild") {
    const recovery = record(
      business.fenced_rebuild_restart,
      "fenced restart recovery missing",
    );
    check(
      recovery.status === "fenced_rebuild_restart_recovered" &&
        recovery.request_id === lifecycle[3].requestId &&
        recovery.controller_restarted === true &&
        recovery.runtime_controller_restarted === true &&
        recovery.admission_closed_during_restart === true,
      "original fenced restart business did not complete",
    );
  } else if (profile === "registry-outage") {
    const recovery = record(
      business.registry_outage,
      "Registry outage recovery missing",
    );
    check(
      recovery.status === "registry_outage_recovered" &&
        recovery.source_run_completed === true &&
        recovery.preparation_state_while_offline === "retry_wait" &&
        [202, 503].includes(recovery.first_http_status) &&
        recovery.source_runtime_revision === operations[2].target_revision,
      "original Registry outage business did not complete",
    );
  } else if (profile === "offline-reuse") {
    const recovery = record(
      business.offline_skill_reuse,
      "offline reuse recovery missing",
    );
    check(
      recovery.status === "offline_skill_reuse_passed" &&
        recovery.source_runtime_revision === operations[2].target_revision &&
        recovery.rebuilt_runtime_revision === operations[3].target_revision &&
        identifier(recovery.skill_set_digest),
      "original offline Skill reuse did not complete",
    );
  }
  return lifecycle;
}

function providersFor(inventory, business, prompts, profile) {
  const providers = list(
    inventory.provider_requests,
    "original Provider inventory missing",
  );
  check(
    providers.length === prompts.length * 2 &&
      business.model_requests === providers.length,
    "original model completion count changed",
  );
  for (const [index, prompt] of prompts.entries()) {
    for (const [step, stage] of ["tool", "reply"].entries()) {
      const row = record(
        providers[index * 2 + step],
        "original Provider request missing",
      );
      check(
        row.phase === prompt.phase && row.stage === stage,
        "Provider phase or Tool/reply inventory changed",
      );
      if (
        profile !== "base" &&
        prompt.phase === "v1-baseline" &&
        stage === "reply"
      )
        check(
          row.registry_network_denied === true,
          "actual model-observed Registry denial missing",
        );
    }
  }
  return providers;
}

function logoutsFor(logouts, business, lifecycle, originals) {
  list(logouts, "original Logout observations missing");
  check(logouts.length === 2, "original Logout inventory changed");
  const revocations = list(
    business.revocations,
    "original Logout recovery inventory missing",
  );
  check(revocations.length === 2, "original Logout recovery inventory changed");
  for (const [index, version] of [1, 2].entries()) {
    const row = record(logouts[index], "original Logout observation missing");
    check(
      row.protocolVersion === version &&
        row.agentId === business.agent_id &&
        row.sessionId === originals.sessions.get(`logout-v${version}`),
      "Logout belongs to another Agent, Session or protocol",
    );
    inspectStage3LogoutBusiness(row);
    const creations = originals.rowsByPhase.get(`logout-v${version}:new`);
    check(
      creations?.length === 1 &&
        creations[0].version === version &&
        creations[0].requestReceipt.result.sessionId === row.sessionId,
      "Logout has no matching original Session creation",
    );
    const closing = record(
      row.closingLifecycle,
      "original closing lifecycle missing",
    );
    const deletion = lifecycle.at(-1);
    check(
      closing.kind === "delete" &&
        closing.agentId === deletion.agentId &&
        closing.requestId === deletion.requestId,
      "Logout closing lifecycle changed",
    );
    const recovery = record(
      revocations[index],
      "original Logout recovery receipt missing",
    );
    check(
      recovery.version === version &&
        recovery.rejected === true &&
        recovery.transport === "http-sse" &&
        recovery.denial_status === 401 &&
        recovery.recovered_empty === true,
      "actual Logout and empty recovery did not complete",
    );
  }
}

// These original SDK/model/lifecycle receipts complement the effectful flow's
// existing Tool, filesystem and replay assertions. They do not recreate an
// independent persisted Run audit or claim feed/SQL causality from diagnostics.
export function completeStage3Business(input, options) {
  record(input, "original completion evidence missing");
  record(options, "completion options missing");
  check(
    options.status === 0 && profiles.has(options.profile),
    "outer business runner did not complete",
  );
  const business = record(input.business, "original business result missing");
  const cleanup = record(input.cleanup, "actual cleanup receipt missing");
  for (const key of [
    "entry_status",
    "client_status",
    "archive_status",
    "cleanup_status",
  ])
    check(
      cleanup[key] === 0,
      "client, archive or actual resource cleanup failed",
    );
  check(
    business.status === "business_passed" &&
      business.resource_id_contract === "passed" &&
      resource("agent", business.agent_id) &&
      business.deleted === true &&
      business.resources_joined === true,
    "business or actual resource join did not complete",
  );
  check(
    business.provider_rotated === true &&
      business.build_snapshot_preserved === true &&
      business.rebuilt_workspace_preserved === true,
    "original configuration or workspace business did not complete",
  );
  same(
    business.transports,
    ["v1-ws", "v2-ws", "v1-http"],
    "original transport inventory changed",
  );
  const inventory = record(
    input.inventory,
    "original business inventory missing",
  );
  const originals = requestsFor(
    inventory,
    planFor(options.profile),
    business.agent_id,
  );
  const lifecycle = lifecycleFor(
    business,
    inventory,
    options.profile,
    business.agent_id,
  );
  const providers = providersFor(
    inventory,
    business,
    originals.prompts,
    options.profile,
  );
  logoutsFor(input.logouts, business, lifecycle, originals);
  return {
    status: "business_passed",
    policy_revision: 1,
    suite: "stage3-" + options.profile,
    agent_id: business.agent_id,
    cleanup: "verified",
    private_requests: originals.requests.length,
    connections: originals.connections.length,
    initializations: originals.connections.length,
    ordinary_prompts: originals.prompts.length,
    model_requests: providers.length,
    lifecycle_operations: lifecycle.length,
    logout_observations: 2,
  };
}
