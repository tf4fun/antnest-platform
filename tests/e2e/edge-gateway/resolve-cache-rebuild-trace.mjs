import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { agentReady } from "../../support/verification/agent-state.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import {
  lifecyclePlans,
  assertRPCParent,
} from "../observability/lifecycle-workflow.mjs";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";
import { assertDockerProbe } from "../stage3-base/trace.mjs";
import {
  assertCancelledRun,
  assertUnchangedAudit,
} from "../workspace-closeout/current-evidence.mjs";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";

const one = (items, message) => {
  assert.equal(items.length, 1, message);
  return items[0];
};
const fields = (items = []) => {
  const result = Object.fromEntries(
    items.map(({ key, value }) => [key, value]),
  );
  assert.equal(
    Object.keys(result).length,
    items.length,
    "duplicate Rebuild diagnostic field",
  );
  return result;
};
const end = (span) => span.startTime + span.duration;
const query = (span) =>
  (tag(span, "db.query.text") ?? "").replace(/\s+/gu, " ").trim();
const text = (value) =>
  assert(
    typeof value === "string" && value.length > 0,
    "missing Rebuild identity",
  );
const diagnosticKey =
  /^(error($|\.)|exception\.|antnest\.error\.|otel\.status_)/u;
const claimedDiagnosticKey = (key) =>
  diagnosticKey.test(key) ||
  /^antnest\.(result$|outcome$|cancellation(?:\.|$)|stream\.termination$)/u.test(
    key,
  );
const operationRead =
  "SELECT request_id, request_fingerprint, agent_id, kind, phase, state, source_spec_revision_id, source_execution_revision_id, source_runtime_revision, source_runtime_absent, target_spec_revision_id, child_request_id, network_attachment, source_runtime_inspection, source_runtime_absence_proof, runtime_result, network_release_outcome, error_code, error_detail, retryable, created_at, updated_at, owner_revocation_sequence, drain_deadline_at, settlement_outcome FROM agent_controller.agent_lifecycle_operations WHERE request_id = $1";
const preparationRead =
  "SELECT request_id, request_fingerprint, kind, agent_id, organization_id, target_spec, target_spec_digest, expected_aggregate_sequence, expected_spec_revision_id, expected_execution_revision_id, expected_runtime_revision, state, preparation_attempt, prepared_reference_id, created_at, updated_at FROM agent_controller.agent_skill_preparation_intents WHERE request_id=$1";
const advance =
  "UPDATE agent_controller.agent_lifecycle_operations AS operation SET phase = $2, child_request_id = $3, network_attachment = COALESCE($4, network_attachment), runtime_result = COALESCE($5, runtime_result), updated_at = $6 WHERE request_id = $1 AND state = 'running' AND phase = $7 AND EXISTS ( SELECT 1 FROM agent_controller.agents AS agent WHERE agent.id = operation.agent_id AND agent.active_operation_request_id = operation.request_id )";
const drain =
  "UPDATE agent_controller.agent_lifecycle_operations AS operation SET phase = 'network_fence', child_request_id = $2, settlement_outcome = $3, updated_at = $4 WHERE request_id = $1 AND state = 'running' AND phase = 'drain' AND drain_deadline_at > clock_timestamp() AND EXISTS (SELECT 1 FROM agent_controller.agents AS agent WHERE agent.id = operation.agent_id AND agent.active_operation_request_id = operation.request_id)";
const completed =
  "UPDATE agent_controller.agent_lifecycle_operations SET phase = 'completed', state = 'completed', child_request_id = '', error_code = '', error_detail = '', retryable = FALSE, updated_at = $2 WHERE request_id = $1";

function processIdentity(trace, span) {
  const process = trace.processes[span.processID];
  const resource = fields(process.tags);
  text(resource["host.name"]);
  text(resource["service.instance.id"]);
  assert(
    Number.isSafeInteger(resource["process.pid"]) &&
      resource["process.pid"] > 0,
  );
  return {
    service: process.serviceName,
    host: resource["host.name"],
    instance: resource["service.instance.id"],
    pid: resource["process.pid"],
  };
}

function diagnostic(span, expected, events = []) {
  const actual = Object.fromEntries(
    Object.entries(fields(span.tags)).filter(([key]) =>
      claimedDiagnosticKey(key),
    ),
  );
  assert.deepEqual(actual, expected, "unexpected Rebuild diagnostic tags");
  assert.deepEqual(
    (span.logs ?? []).map((event) => fields(event.fields)),
    events,
    "unexpected Rebuild diagnostic events",
  );
  let previous = span.startTime;
  for (const event of span.logs ?? []) {
    assert(
      Number.isFinite(event.timestamp) &&
        previous <= event.timestamp &&
        event.timestamp <= end(span),
      "Rebuild event outside owning span",
    );
    previous = event.timestamp;
  }
}
const errorEvent = (type, stage, message, causeTypes, causes, extra = {}) => ({
  event: "antnest.error",
  "error.type": type,
  "antnest.error.stage": stage,
  "antnest.error.message": message,
  "antnest.error.cause_types": JSON.stringify(causeTypes),
  ...(causes ? { "antnest.error.causes": JSON.stringify(causes) } : {}),
  ...extra,
});
const statusError = (status, description) => ({
  error: true,
  "error.type": String(status),
  "otel.status_code": "ERROR",
  "otel.status_description": description,
});

function cancelledCommand(part) {
  const {
    root,
    consoleClient,
    consoleServer,
    controllerClient,
    controllerServer,
    update,
  } = part;
  diagnostic(root, statusError(503, "503"));
  diagnostic(
    consoleClient,
    { ...statusError("deadline_exceeded", "Request deadline exceeded") },
    [
      errorEvent("deadline_exceeded", "send", "Request deadline exceeded", [
        "context.deadlineExceededError",
      ]),
    ],
  );
  for (const [span, type, stage, message, types, causes] of [
    [
      consoleServer,
      "dependency_unavailable",
      "handle",
      "A platform service is unavailable",
      [
        "*server.adapterFailure",
        "*server.bufferedFetchError",
        "*fmt.wrapError",
        "*url.Error",
      ],
      [
        "A platform service is unavailable",
        "Request was cancelled",
        "Request was cancelled",
        "Request was cancelled",
      ],
    ],
    [
      controllerClient,
      "cancelled",
      "send",
      "Request was cancelled",
      ["*errors.errorString"],
      ["Request was cancelled"],
    ],
  ]) {
    assert.equal(tag(span, "antnest.outcome"), "cancelled");
    diagnostic(span, { "error.type": type, "antnest.outcome": "cancelled" }, [
      errorEvent(type, stage, message, types, causes, {
        "antnest.error.code": type,
        "antnest.error.type": type,
      }),
    ]);
  }
  assert.equal(tag(controllerServer, "antnest.outcome"), "canceled");
  assert.equal(tag(controllerServer, "antnest.result"), "error");
  diagnostic(
    controllerServer,
    {
      ...statusError("canceled", "503"),
      "antnest.error.code": "canceled",
      "antnest.error.stage": "request",
      "antnest.error.type": "canceled",
      "antnest.outcome": "canceled",
      "antnest.result": "error",
    },
    [
      errorEvent(
        "boundary_error",
        "dispatch",
        "dependency is unavailable",
        ["*fmt.wrapError", "*errors.errorString"],
        [
          "*fmt.wrapError: boundary_error: boundary failed; unregistered error message omitted",
          "*errors.errorString: boundary_error: boundary failed; unregistered error message omitted",
        ],
        {
          "antnest.error.code": "dependency_unavailable",
          "antnest.error.type": "boundary_error",
          "antnest.outcome": "error",
        },
      ),
      errorEvent(
        "canceled",
        "request",
        "operation canceled",
        ["*errors.errorString"],
        ["*errors.errorString: canceled: operation canceled"],
        {
          "antnest.error.code": "canceled",
          "antnest.error.type": "canceled",
          "antnest.outcome": "canceled",
        },
      ),
    ],
  );
  const message =
    "Timeout or cancellation waiting for update: context canceled";
  diagnostic(
    update,
    {
      error: true,
      "otel.status_code": "ERROR",
      "otel.status_description": message,
    },
    [
      {
        event: "exception",
        "exception.message": message,
        "exception.type":
          "*internal.WorkflowUpdateServiceTimeoutOrCanceledError",
      },
    ],
  );
  for (const s of [root, consoleServer, controllerServer])
    assert.equal(tag(s, "http.response.status_code"), 503);
  for (const s of [consoleClient, controllerClient])
    assert.equal(
      tag(s, "http.response.status_code"),
      undefined,
      "cancelled send has an unexpected response",
    );
  assert.equal(tag(controllerClient, "antnest.request.dispatched"), true);
  return [
    root,
    consoleClient,
    consoleServer,
    controllerClient,
    controllerServer,
    update,
  ];
}

function runtimeStatusCompletion(span, trace, event) {
  const f = fields(event.fields),
    resource = trace.processes[span.processID];
  assert.equal(resource.serviceName, "antnest-runtime");
  assert.equal(span.operationName, "HTTP GET /status");
  assert.equal(tag(span, "span.kind"), "server");
  assert.equal(span.logs.length, 1, "ambiguous Runtime status completion");
  for (const [key, value] of Object.entries({
    "service.name": "antnest-runtime",
    "http.request.method": "GET",
    "url.path": "/status",
    "http.transport.outcome": "success",
    trace_id: trace.traceID,
    span_id: span.spanID,
  })) {
    assert.equal(tag(span, key), value);
    assert.equal(f[key], value);
  }
  assert.equal(tag(span, "http.route"), "/status");
  assert.equal(f.level, "INFO");
  const status = tag(span, "http.response.status_code");
  assert([200, "200"].includes(status));
  assert.equal(
    tag({ tags: event.fields }, "http.response.status_code"),
    status,
  );
  text(tag(span, "antnest.runtime.execution.id"));
  const agent = tag(span, "antnest.agent.id"),
    generation = tag(span, "antnest.runtime.generation");
  text(agent);
  assert(
    (Number.isSafeInteger(generation) && generation > 0) ||
      (typeof generation === "string" && /^[1-9][0-9]*$/u.test(generation)),
    "invalid Runtime generation",
  );
  for (const [key, value] of Object.entries({
    "antnest.agent.id": agent,
    "antnest.runtime.generation": generation,
  })) {
    assert.equal(f[key], value);
    assert.equal(fields(resource.tags)[key], value);
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(f).filter(([key]) => claimedDiagnosticKey(key)),
    ),
    { "error.type": "" },
    "unexpected Runtime status completion diagnostic",
  );
  assert(
    ![...Object.keys(f), ...Object.keys(fields(span.tags))].some((key) =>
      /^http\.transport\.error(?:\.|$)/u.test(key),
    ),
    "successful Runtime status has a transport error",
  );
  assert(
    !Object.keys(fields(span.tags)).some(
      (key) => claimedDiagnosticKey(key) && !diagnosticKey.test(key),
    ),
    "unexpected Runtime status outcome",
  );
  assert(
    Number.isFinite(event.timestamp) &&
      span.startTime <= event.timestamp &&
      event.timestamp <= end(span),
    "Runtime completion outside its status span",
  );
}

function successful(span, trace, expected) {
  const tree = traceTopology(trace),
    service = tree.service(span);
  assert(!hasError(span), "unexpected Rebuild error");
  assert(
    !["ERROR", 2].includes(tag(span, "otel.status_code")),
    "unexpected Rebuild ERROR",
  );
  const status = tag(span, "http.response.status_code");
  if (status !== undefined) {
    assert(
      (Number.isInteger(status) && status >= 100 && status <= 599) ||
        (typeof status === "string" && /^[1-5][0-9]{2}$/u.test(status)),
      "invalid Rebuild HTTP status",
    );
    if (Number(status) >= 400) assertDockerProbe(trace, tree, span, expected);
  }
  for (const [key, value] of Object.entries(fields(span.tags))) {
    if (!diagnosticKey.test(key)) continue;
    if (key === "error" && value === false) continue;
    if (key === "otel.status_code" && ["UNSET", "OK"].includes(value)) continue;
    if (
      key === "antnest.error.class" &&
      value === "none" &&
      service === "runtime-controller"
    )
      continue;
    if (
      key === "antnest.error.code" &&
      value === "" &&
      service === "runtime-controller" &&
      tag(span, "antnest.outcome") === "completed"
    )
      continue;
    if (
      key === "error.type" &&
      value === "" &&
      service === "antnest-runtime-egress" &&
      tag(span, "antnest.outcome") === "success" &&
      status === 200
    ) {
      assert(
        (span.logs ?? []).some((log) => {
          const f = fields(log.fields);
          return (
            f.event === "antnest.complete" &&
            f["antnest.outcome"] === "success" &&
            f["antnest.response.termination"] === "eof"
          );
        }),
        "missing Egress successful completion",
      );
      continue;
    }
    assert.fail("unexpected Rebuild error metadata");
  }
  for (const event of span.logs ?? []) {
    const f = fields(event.fields);
    if (
      f.event === "Runtime HTTP request completed" &&
      f["error.type"] === ""
    ) {
      runtimeStatusCompletion(span, trace, event);
      continue;
    }
    assert(
      !["exception", "error", "antnest.error"].includes(f.event) &&
        !Object.keys(f).some((key) => diagnosticKey.test(key)),
      "unexpected Rebuild error event",
    );
  }
}

function preparationBusiness(evidence) {
  const p = evidence.recovery_preparation;
  assert(
    p?.request && Array.isArray(p.responses) && p.responses.length > 0,
    "Rebuild preparation raw evidence required",
  );
  const login = one(
    evidence.http.filter((r) => r.label === "audit-login"),
    "Rebuild preparation administrator login required",
  );
  assert.equal(login.status, 200);
  assert.equal(login.method, "POST");
  assert.equal(login.path, "/api/session/login");
  const principal = login.body.principal;
  for (const key of ["user_id", "membership_id", "organization_id"])
    text(principal[key]);
  assert.equal(principal.active, true);
  assert.equal(principal.organization_role, "admin");
  assert.equal(principal.organization_id, evidence.runtime.organization_id);
  text(login.issued_credential_scope);
  const request = p.request,
    agentPath = `/api/admin/agents/${encodeURIComponent(evidence.agent_id)}`;
  assert.equal(request.path, `${agentPath}/rebuild`);
  text(request.idempotency_key);
  assert.equal(request.idempotency_key.trim(), request.idempotency_key);
  const requestID =
    "lifecycle-" +
    createHash("sha256")
      .update(`${principal.organization_id}\0${request.idempotency_key}`)
      .digest("hex");
  text(request.body.template_id);
  assert(
    Number.isSafeInteger(request.body.template_revision) &&
      request.body.template_revision > 0,
  );
  const actual = evidence.http.filter((r) =>
    r.label?.startsWith("recovery-rebuild-"),
  );
  assert.deepEqual(actual, p.responses, "Rebuild HTTP inventory differs");
  assert.equal(
    new Set(actual.map((r) => r.trace_id)).size,
    actual.length,
    "duplicate Rebuild HTTP trace",
  );
  let previous = p.started_at;
  assert(Number.isFinite(previous) && login.at <= previous);
  for (const row of actual) {
    assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
    assert.deepEqual(
      one(
        evidence.http.filter((r) => r.trace_id === row.trace_id),
        "ambiguous actual Rebuild HTTP response",
      ),
      row,
    );
    assert.equal(
      row.credential_scope,
      login.issued_credential_scope,
      "foreign Rebuild credential",
    );
    assert.equal(
      row.set_cookie_count,
      0,
      "Rebuild response changed credential",
    );
    assert(
      typeof row.cache_control === "string" &&
        row.cache_control.split(",").every((v) => v.trim() === "no-store"),
      "Rebuild response is cacheable",
    );
    assert(
      Number.isFinite(row.started_at) &&
        Number.isFinite(row.at) &&
        previous <= row.started_at &&
        row.started_at <= row.at,
      "Rebuild HTTP observations reordered",
    );
    previous = row.at;
  }
  assert(Number.isFinite(p.at) && previous <= p.at);
  const recorded = (row) =>
    assert.deepEqual(
      one(
        actual.filter((r) => r.trace_id === row?.trace_id),
        "Rebuild final response missing",
      ),
      row,
    );
  for (const key of ["command", "receipt", "operation", "ready"])
    recorded(p[key]);
  assert.deepEqual(
    one(
      actual.filter((r) => r.method !== "GET"),
      "one Rebuild POST required",
    ),
    p.command,
  );
  assert.equal(p.command.method, "POST");
  assert.equal(p.command.path, request.path);
  assert([202, 503].includes(p.command.status));
  const identity = (body) => {
    assert.equal(body.request_id, requestID, "foreign Rebuild request/key");
    assert.equal(body.agent_id, evidence.agent_id, "foreign Rebuild Agent");
    assert.equal(body.kind, "rebuild");
    assert(!body.error_code && !body.error_detail, "failed Rebuild receipt");
  };
  if (p.command.status === 202) identity(p.command.body);
  else
    assert.deepEqual(p.command.body, {
      code: "console_unavailable",
      message: "Admin Console is unavailable",
    });
  for (const row of actual) {
    if (row.label === "recovery-rebuild-preparation") {
      assert.equal(
        row.path,
        "/api/admin/agent-skill-preparations/by-idempotency-key",
      );
      // A missing preparation intent has no safe ownership proof here. Keep it
      // rejected until its own durable-intent ordering can be established.
      assert.equal(row.status, 200, "unproved Rebuild preparation refusal");
      identity(row.body);
      assert(
        [
          "queued",
          "preparing",
          "retry_wait",
          "paused",
          "invalidated",
          "cleanup_pending",
          "ready",
          "released",
        ].includes(row.body.state),
      );
    }
    if (row.label === "recovery-rebuild-operation") {
      assert.equal(row.path, `/api/admin/operations/${requestID}`);
      assert([200, 404].includes(row.status));
      if (row.status === 200) {
        identity(row.body);
        assert(["running", "completed"].includes(row.body.state));
      } else
        assert.deepEqual(row.body, {
          code: "operation_not_found",
          message: "lifecycle operation was not found",
          retryable: false,
        });
    }
  }
  assert.equal(p.receipt.label, "recovery-rebuild-preparation");
  assert(["ready", "released"].includes(p.receipt.body.state));
  assert.equal(p.operation.label, "recovery-rebuild-operation");
  assert.equal(p.operation.status, 200);
  assert.equal(p.operation.body.state, "completed");
  assert.equal(p.operation.body.phase, "completed");
  assert(
    p.command.at <= p.receipt.started_at &&
      p.receipt.at <= p.operation.started_at &&
      p.operation.at <= p.ready.started_at,
  );
  assert.equal(p.ready.path, agentPath);
  assert.equal(p.ready.label, "recovery-rebuild-ready");
  assert.equal(p.ready.status, 200);
  assert.equal(p.ready.body.agent_id, evidence.agent_id);
  assert.equal(p.ready.body.owner_user_id, evidence.audit.body.principal_id);
  assert(agentReady(p.ready.body), "rebuilt Agent is not executable");
  assert.equal(
    p.ready.body.configuration.template.template_id,
    request.body.template_id,
  );
  assert.equal(
    p.ready.body.configuration.template.revision,
    request.body.template_revision,
  );
  const old = evidence.runtime,
    fresh = p.runtime;
  assertCancelledRun(
    evidence.audit.body,
    evidence.agent_id,
    evidence.session_id,
    old.execution_revision,
  );
  assert.equal(evidence.audit.body.run_id, evidence.run_id);
  assert.equal(fresh.organization_id, old.organization_id);
  for (const key of [
    "runtime_revision",
    "runtime_execution_id",
    "execution_revision",
  ]) {
    text(fresh[key]);
    assert.notEqual(
      fresh[key],
      old[key],
      "Rebuild did not replace Runtime identity",
    );
  }
  assert.equal(fresh.runtime_revision, p.ready.body.runtime.runtime_revision);
  assert.equal(
    fresh.execution_revision,
    p.ready.body.executable_execution_revision,
  );
  text(fresh.container.id);
  assert.notEqual(fresh.container.id, old.container.id);
  for (const key of ["project", "agent_id", "image", "volume"])
    assert.equal(
      fresh.container[key],
      old.container[key],
      "foreign physical Runtime",
    );
  assert.equal(fresh.container.agent_id, evidence.agent_id);
  assert.equal(fresh.container.project, evidence.project);
  assert.equal(fresh.container.running, true);
  assert.equal(fresh.container.health, "healthy");
  assert.equal(fresh.container.generation, old.container.generation + 1);
  assert.deepEqual(fresh.observation.container, fresh.container);
  assert(
    fresh.observations.some(
      (r) => JSON.stringify(r) === JSON.stringify(fresh.observation),
    ),
    "physical Runtime observation missing",
  );
  for (const [key, value] of Object.entries({
    agent_id: evidence.agent_id,
    generation: fresh.container.generation,
    execution_id: fresh.runtime_execution_id,
    status: "ready",
  }))
    assert.equal(fresh.observation.status[key], value);
  assert.equal(fresh.observation.work.effects, old.quiescent.work.effects);
  assert(
    p.ready.at <= fresh.observation.started_at &&
      fresh.observation.started_at <= fresh.observation.at &&
      fresh.observation.at <= p.after.run.started_at,
  );
  const auditPath = `/api/admin/execution-audits/${encodeURIComponent(evidence.run_id)}`;
  for (const phase of ["before", "after"]) {
    const a = p[phase];
    for (const [key, path] of Object.entries({
      run: auditPath,
      events: `${auditPath}/events?stream=execution&limit=100`,
      inventory: `/api/admin/execution-audits?agent_id=${encodeURIComponent(evidence.agent_id)}&limit=100`,
    })) {
      recorded(a[key]);
      assert.equal(a[key].label, `recovery-rebuild-${phase}-${key}`);
      assert.equal(a[key].path, path);
      assert.equal(a[key].status, 200);
    }
    assert.deepEqual(
      a.run.body,
      evidence.audit.body,
      "original Run changed during Rebuild",
    );
    assert.deepEqual(
      a.stored.record,
      evidence.run_storage.after.record,
      "original stored Run changed during Rebuild",
    );
    assert.equal(a.events.body.stream, "execution");
    assert.equal(a.events.body.next_cursor, null);
    assert.equal(a.inventory.body.next_cursor, null);
    assert(a.events.body.items.length > 0);
    const run = one(
      a.inventory.body.items.filter((r) => r.run_id === evidence.run_id),
      "original Run inventory missing",
    );
    for (const key of [
      "run_id",
      "agent_id",
      "session_id",
      "principal_id",
      "state",
    ])
      assert.equal(run[key], evidence.audit.body[key]);
  }
  assertUnchangedAudit(
    { run: p.before.run.body, events: p.before.events.body },
    { run: p.after.run.body, events: p.after.events.body },
  );
  assert.deepEqual(p.before.inventory.body, p.after.inventory.body);
  assert(p.before.inventory.at <= p.command.started_at);
  return { p, requestID, agentID: evidence.agent_id };
}

function workflowProof(part, business) {
  const { trace, tree, controllerServer, update } = part;
  const { p, requestID, agentID } = business;
  const workflowID = `agent-rebuild/${requestID}`;
  const workflow = one(
    trace.spans.filter(
      (s) => s.operationName === "RunWorkflow:LifecycleWorkflow",
    ),
    "one Rebuild workflow required",
  );
  assert.equal(tree.parent(workflow), update);
  assert.equal(tree.parent(update), controllerServer);
  assert.equal(tag(workflow, "temporalWorkflowID"), workflowID);
  assert.equal(
    tag(workflow, "antnest.temporal.workflow.span_end"),
    "workflow_return",
  );
  text(tag(workflow, "temporalRunID"));
  assert.equal(tree.service(workflow), "agent-controller");
  const all = (scope) =>
    trace.spans.filter((s) => tree.chain(s).includes(scope));
  const transaction = (scope, patterns) => {
    const tx = one(
      all(scope).filter(
        (s) =>
          s.operationName === "postgresql transaction" &&
          tree.service(s) === tree.service(scope) &&
          patterns.every((pattern) =>
            trace.spans.some((q) => tree.parent(q) === s && pattern(query(q))),
          ),
      ),
      "Rebuild phase committed writes missing or duplicate",
    );
    assert.equal(tag(tx, "antnest.transaction.outcome"), "committed");
    assert.equal(tag(tx, "span.kind"), "internal");
    assert.equal(
      tree.parent(tx),
      scope,
      "Rebuild transaction has a foreign owner",
    );
    assert.equal(tx.processID, scope.processID);
    const sql = trace.spans
      .filter(
        (s) => tree.parent(s) === tx && tag(s, "db.query.text") !== undefined,
      )
      .sort((a, b) => a.startTime - b.startTime);
    assert.equal(
      query(sql[0]),
      tree.service(scope) === "runtime-controller"
        ? "begin isolation level serializable"
        : "begin",
    );
    assert.equal(query(sql.at(-1)), "commit");
    let previous = tx.startTime;
    assert(scope.startTime <= tx.startTime && end(tx) <= end(scope));
    for (const s of sql) {
      assert.equal(s.processID, scope.processID);
      assert.equal(tag(s, "span.kind"), "client");
      assert.equal(tag(s, "db.system.name"), "postgresql");
      assert(
        Number.isSafeInteger(tag(s, "pgx.rows_affected")) &&
          tag(s, "pgx.rows_affected") >= 0,
      );
      assert(
        previous <= s.startTime && end(s) <= end(tx),
        "Rebuild SQL outside serial transaction",
      );
      previous = end(s);
    }
    const writes = patterns.map((pattern) =>
      one(
        sql.filter((s) => pattern(query(s))),
        "Rebuild phase write missing or duplicate",
      ),
    );
    for (const s of writes)
      assert.equal(
        tag(s, "pgx.rows_affected"),
        1,
        "Rebuild write did not affect one row",
      );
    return { tx, writes, commit: sql.at(-1) };
  };
  const equals = (value) => (q) => q === value;
  const prefix = (value) => (q) => q.startsWith(value);
  const event = prefix("INSERT INTO agent_controller.agent_events (");
  const publish = prefix(
    "INSERT INTO agent_controller.execution_configuration_sync (organization_id, revision) VALUES ($1, 1) ON CONFLICT (organization_id) DO UPDATE SET revision=execution_configuration_sync.revision+1",
  );
  const requirements = {
    admit_lifecycle: [
      prefix("INSERT INTO agent_controller.agent_spec_revisions ("),
      prefix(
        "INSERT INTO agent_controller.agent_lifecycle_operations ( request_id, request_fingerprint, agent_id, kind, phase, state,",
      ),
      (q) =>
        q.startsWith(
          "UPDATE agent_controller.agents SET active_operation_request_id = $2,",
        ) &&
        q.endsWith("AND last_successful_execution_revision_id = $10") &&
        q.includes(
          "WHERE id = $1 AND active_operation_request_id = '' AND aggregate_sequence = $5",
        ),
      event,
      publish,
    ],
    drain: [equals(drain)],
    network_fence: [equals(advance)],
    runtime_update: [equals(advance)],
    network_ensure: [equals(advance)],
    publish: [
      (q) =>
        q.startsWith(
          "UPDATE agent_controller.agents SET lifecycle_state = 'created', activation_state = 'enabled',",
        ) &&
        q.includes(
          "runtime_revision = $3, runtime_execution_id = '', runtime_mcp_endpoint = ''",
        ) &&
        q.endsWith(
          "WHERE id = $1 AND active_operation_request_id = $6 AND aggregate_sequence = $7",
        ),
      equals(
        "UPDATE agent_controller.agents SET access_revision = $2 WHERE id = $1",
      ),
      event,
      equals(completed),
      publish,
    ],
  };
  const phases = ["admit_lifecycle", ...lifecyclePlans.rebuild];
  const activitySpans = trace.spans.filter(
    (s) =>
      s.operationName.startsWith("RunActivity:") &&
      tree.chain(s).includes(workflow),
  );
  assert.equal(
    activitySpans.length,
    phases.length,
    "unexpected Rebuild activity/retry",
  );
  let previous;
  const activities = phases.map((phase) => {
    const activity = one(
      activitySpans.filter(
        (s) =>
          s.operationName ===
          `RunActivity:${phase === "admit_lifecycle" ? phase : `lifecycle.${phase}`}`,
      ),
      "missing Rebuild phase",
    );
    assert.equal(activity.processID, workflow.processID);
    assert.equal(tag(activity, "span.kind"), "server");
    assert.equal(tag(activity, "temporalWorkflowID"), workflowID);
    assert.equal(
      tag(activity, "temporalRunID"),
      tag(workflow, "temporalRunID"),
    );
    assert(
      workflow.startTime <= activity.startTime &&
        end(activity) <= end(workflow),
    );
    if (previous)
      assert(end(previous) <= activity.startTime, "Rebuild phases reordered");
    previous = activity;
    // A phase may also publish configuration through a nested business span.
    // Its required transition is the direct, committed transaction below;
    // the HTTP-only direct-SERVER SQL oracle does not describe that hierarchy.
    return { phase, activity, ...transaction(activity, requirements[phase]) };
  });
  const rpc = (scope, service, method, route) => {
    const server = one(
      all(scope).filter(
        (s) =>
          tree.service(s) === service &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === route,
      ),
      "Rebuild dependency missing or duplicate",
    );
    assertRPCParent(tree, server, "agent-controller");
    const client = tree.parent(server);
    for (const s of [client, server]) {
      assert.equal(tag(s, "http.request.method"), method);
      assert.equal(tag(s, "http.response.status_code"), 200);
    }
    return { client, server };
  };
  const phase = (name) => activities.find((a) => a.phase === name);
  const draining = phase("drain");
  const applied = rpc(
    draining.activity,
    "agent-acp-service",
    "POST",
    "/rpc/agent-acp/apply-execution-snapshot",
  );
  const settled = rpc(
    draining.activity,
    "agent-acp-service",
    "POST",
    "/rpc/agent-acp/settle-agent",
  );
  const revision = tag(
    applied.client,
    "antnest.configuration.applied_revision",
  );
  assert(Number.isSafeInteger(revision) && revision > 0);
  for (const s of [settled.client, settled.server]) {
    for (const [key, value] of Object.entries({
      "antnest.operation.id": requestID,
      "antnest.agent.id": agentID,
      "antnest.configuration.revision": revision,
      "antnest.settlement.outcome": "runtime_barrier_required",
    }))
      assert.equal(tag(s, key), value, "unbound Rebuild settlement");
  }
  assert(
    tag(settled.client, "antnest.configuration.applied_revision") >= revision,
  );
  assert(
    end(applied.client) <= settled.client.startTime &&
      end(settled.client) <= draining.writes[0].startTime,
  );
  for (const [name, calls] of [
    [
      "network_fence",
      [
        ["GET", "/internal/agent-networks/{agent_id}"],
        ["PUT", "/internal/agent-network-attachments/{agent_id}"],
      ],
    ],
    [
      "network_ensure",
      [["PUT", "/internal/agent-network-attachments/{agent_id}"]],
    ],
  ]) {
    let prior;
    const a = phase(name);
    for (const [method, route] of calls) {
      const r = rpc(a.activity, "antnest-runtime-egress", method, route);
      if (prior) assert(end(prior) <= r.client.startTime);
      assert(end(r.client) <= a.writes[0].startTime);
      prior = r.client;
    }
  }
  const runtimePhase = phase("runtime_update");
  const runtime = rpc(
    runtimePhase.activity,
    "runtime-controller",
    "POST",
    "/internal/runtimes/{agent_id}/update",
  );
  const childID = runtimeCommandId(requestID, "runtime_update");
  assert.equal(tag(runtime.client, "antnest.operation.request_id"), childID);
  assert.equal(tag(runtime.client, "antnest.agent.id"), agentID);
  const execution = one(
    all(runtime.server).filter(
      (s) => s.operationName === "runtime.lifecycle.update_runtime",
    ),
    "Runtime update result missing",
  );
  for (const [key, value] of Object.entries({
    "antnest.agent.id": agentID,
    "antnest.operation.id": childID,
    "antnest.operation.kind": "update_runtime",
    "antnest.result": "completed",
    "antnest.runtime.revision": p.runtime.runtime_revision,
    "antnest.runtime.target_revision": p.runtime.runtime_revision,
  }))
    assert.equal(tag(execution, key), value, "unbound Runtime replacement");
  assert(end(runtime.client) <= runtimePhase.writes[0].startTime);
  assert.equal(tree.parent(execution), runtime.server);
  assert.equal(execution.processID, runtime.server.processID);
  // Runtime SQL namespaces differ from Controller's. Inspect the authoritative
  // operation/environments writes and their actual committed transactions.
  const runtimeTransactions = [
    transaction(execution, [
      (q) => /^INSERT INTO runtime_controller\.operations /u.test(q),
    ]),
    transaction(execution, [
      (q) =>
        /^UPDATE runtime_controller\.operations SET state = \$1, effect = \$2, inspection = \$3, error_code = \$4, error_detail = \$5, updated_at = \$6 WHERE request_id = \$7 AND attempt = \$8 AND state IN \('running', 'unknown'\)$/u.test(
          q,
        ),
      (q) =>
        /^UPDATE runtime_controller\.runtime_environments SET runtime_revision = \$1, lifecycle_state = \$2, generation = \$3, spec_digest = \$4, operation_id = NULL, updated_at = \$5 WHERE agent_id = \$6 AND operation_id = \$7$/u.test(
          q,
        ),
    ]),
  ];
  assert(
    end(runtimeTransactions[0].commit) <= runtimeTransactions[1].tx.startTime,
    "Runtime completion preceded admission commit",
  );
  const admitted = phase("admit_lifecycle"),
    published = phase("publish");
  return {
    workflow,
    activities,
    operationInsert: admitted.writes[1],
    operationInsertCommit: admitted.commit,
    completedWrite: published.writes[3],
    completedCommit: published.commit,
    runtime: execution,
    runtimeTransactions,
    report: {
      workflow_span_id: workflow.spanID,
      workflow_id: workflowID,
      settlement: "runtime_barrier_required",
      activities: activities.map(({ phase, activity, tx, commit, writes }) => ({
        phase,
        span_id: activity.spanID,
        transaction_span_id: tx.spanID,
        commit_span_id: commit.spanID,
        write_span_ids: writes.map((s) => s.spanID),
      })),
      runtime_span_id: execution.spanID,
      runtime_target_revision: p.runtime.runtime_revision,
      runtime_transactions: runtimeTransactions.map(
        ({ tx, commit, writes }) => ({
          transaction_span_id: tx.spanID,
          commit_span_id: commit.spanID,
          write_span_ids: writes.map((s) => s.spanID),
        }),
      ),
    },
  };
}

export function inspectRebuildPreparation(evidence, collection, secrets = []) {
  const business = preparationBusiness(evidence),
    { p, requestID, agentID } = business;
  const traces = [],
    owned = [],
    parts = [],
    neutral = new Set();
  const expected = {
    kind: "rebuild",
    requestId: requestID,
    agentId: agentID,
    skillPreparation: true,
  };
  const raw = (row) => {
    assert(
      collection.archivedTraceIDs.has(row.trace_id),
      "Rebuild trace not archived",
    );
    const trace = collection.traces.get(row.trace_id);
    assert(trace, "Rebuild trace missing");
    resolveTraceSources(trace, secrets, collection);
    assert(!traces.includes(trace), "Rebuild trace reused");
    traces.push(trace);
    const tree = traceTopology(trace);
    for (const s of trace.spans) {
      fields(s.tags);
      for (const { key } of [
        ...s.tags,
        ...(s.logs ?? []).flatMap((event) => event.fields ?? []),
      ])
        assert(
          !["pgx.query.parameters", "db.connection_string"].includes(key) &&
            !/^db\.(query\.parameters?|query\.results?|statement\.parameters)(\.|$)/u.test(
              key,
            ),
          "Rebuild SQL arguments or results captured",
        );
      assert(
        Number.isFinite(s.startTime) &&
          Number.isFinite(s.duration) &&
          s.duration >= 0,
        "unfinished Rebuild span",
      );
    }
    const root = one(
      trace.spans.filter((s) => !tree.parent(s)),
      "one Rebuild Gateway root required",
    );
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    assert.equal(tag(root, "http.route"), "/api/admin/{path...}");
    assert.equal(tag(root, "http.request.method"), row.method);
    assert.equal(tag(root, "http.response.status_code"), row.status);
    const consoleServer = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === "admin-console" &&
          tag(s, "span.kind") === "server",
      ),
      "one Rebuild Console server required",
    );
    const consoleClient = tree.parent(consoleServer);
    assertRPCParent(tree, consoleServer, "edge-gateway");
    assert.equal(tree.parent(consoleClient), root);
    assert.equal(tag(consoleServer, "http.request.method"), row.method);
    assert.equal(tag(consoleServer, "http.response.status_code"), row.status);
    const routes = {
      command: "/api/admin/agents/{agent_id}/rebuild",
      preparation: "/api/admin/agent-skill-preparations/by-idempotency-key",
      operation: "/api/admin/operations/{request_id}",
      ready: "/api/admin/agents/{agent_id}",
      "before-run": "/api/admin/execution-audits/{run_id}",
      "after-run": "/api/admin/execution-audits/{run_id}",
      "before-events": "/api/admin/execution-audits/{run_id}/events",
      "after-events": "/api/admin/execution-audits/{run_id}/events",
      "before-inventory": "/api/admin/execution-audits",
      "after-inventory": "/api/admin/execution-audits",
    };
    const route = routes[row.label.replace(/^recovery-rebuild-/u, "")];
    assert(route, "unknown Rebuild HTTP observation");
    assert.equal(
      tag(consoleServer, "http.route"),
      route,
      "unbound Rebuild Console route",
    );
    assertGatewayResolutionAttributes(trace);
    const decision = one(
      trace.spans.filter((s) => s.operationName === "gateway.identity.resolve"),
      "one Rebuild Resolve decision required",
    );
    inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        decisionSpanID: decision.spanID,
        upstreamSpanID: consoleClient.spanID,
        profile: "console",
        ttlMs: evidence.settings.resolveTTLMS,
      },
      collection,
    );
    const part = { row, trace, tree, root, consoleClient, consoleServer };
    parts.push(part);
    return part;
  };
  const controller = (part, route) => {
    const { tree, trace, consoleServer, row } = part;
    const server = one(
      trace.spans.filter(
        (s) =>
          tree.service(s) === "agent-controller" &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === route,
      ),
      "one Rebuild Controller request required",
    );
    const client = tree.parent(server);
    assertRPCParent(tree, server, "admin-console");
    assert.equal(tree.parent(client), consoleServer);
    assert.equal(tag(server, "http.request.method"), row.method);
    assert.equal(tag(server, "http.response.status_code"), row.status);
    part.controllerClient = client;
    part.controllerServer = server;
    return server;
  };
  const command = raw(p.command);
  assert.equal(
    tag(command.consoleServer, "http.route"),
    "/api/admin/agents/{agent_id}/rebuild",
  );
  controller(command, "/internal/agents/{agent_id}/rebuild");
  command.update = one(
    command.trace.spans.filter(
      (s) => s.operationName === "UpdateWithStartWorkflow:admission",
    ),
    "one Temporal update request required",
  );
  assert.equal(tag(command.update, "span.kind"), "client");
  assert.equal(command.update.processID, command.controllerServer.processID);
  const proof = workflowProof(command, business);
  const claim = (part, span, reason) => {
    assert(hasError(span), "claimed Rebuild span has no error");
    owned.push({ trace_id: part.trace.traceID, span_id: span.spanID, reason });
  };
  if (p.command.status === 503)
    for (const span of cancelledCommand(command))
      claim(
        command,
        span,
        "rebuild-command-wait-cancelled-after-durable-completion",
      );
  else {
    assert.equal(tag(command.controllerServer, "antnest.agent.id"), agentID);
    for (const span of [command.consoleClient, command.controllerClient])
      assert.equal(tag(span, "http.response.status_code"), 202);
    assert.deepEqual(
      processIdentity(command.trace, proof.operationInsertCommit),
      processIdentity(command.trace, command.update),
      "202 admission crossed Controller instance",
    );
    assert(
      end(proof.operationInsertCommit) <= end(command.update) &&
        end(command.update) <= end(command.controllerServer),
      "202 precedes committed admission",
    );
  }
  const requests = [],
    early = [];
  for (const row of p.responses.filter(
    (r) => r !== p.command && r.trace_id !== p.command.trace_id,
  )) {
    const part = raw(row);
    if (
      ["recovery-rebuild-operation", "recovery-rebuild-preparation"].includes(
        row.label,
      )
    ) {
      const operation = row.label === "recovery-rebuild-operation";
      assert.equal(
        tag(part.consoleServer, "http.route"),
        operation
          ? "/api/admin/operations/{request_id}"
          : "/api/admin/agent-skill-preparations/by-idempotency-key",
      );
      const server = controller(
        part,
        operation
          ? "/internal/agent-operations/{request_id}"
          : "/internal/agent-skill-preparations/{request_id}",
      );
      assert.deepEqual(
        processIdentity(part.trace, server),
        processIdentity(command.trace, proof.operationInsert),
        "Rebuild query crossed Controller instance",
      );
      const db = databaseChildrenTopology(part.trace, server);
      const sql = one(
        db.filter(
          (s) => query(s) === (operation ? operationRead : preparationRead),
        ),
        "exact Rebuild receipt SQL missing",
      );
      assert.equal(part.tree.parent(sql), server);
      assert.equal(tag(sql, "pgx.rows_affected"), row.status === 404 ? 0 : 1);
      if (row.status === 404) {
        assert(operation);
        assert.equal(
          p.command.status,
          503,
          "admitted 202 cannot lose its operation",
        );
        assert.equal(db.length, 1, "404 executed unrelated SQL");
        assert(
          end(sql) <= proof.operationInsert.startTime,
          "operation 404 follows durable insertion",
        );
        assert.equal(tag(part.consoleServer, "antnest.outcome"), "rejected");
        assert.equal(tag(server, "antnest.outcome"), "rejected");
        assert.equal(tag(server, "antnest.result"), "error");
        diagnostic(part.root, {});
        neutral.add(part.root);
        diagnostic(part.consoleServer, { "antnest.outcome": "rejected" });
        diagnostic(server, {
          "antnest.error.code": "operation_not_found",
          "antnest.outcome": "rejected",
          "antnest.result": "error",
        });
        for (const s of [part.consoleClient, part.controllerClient]) {
          assert.equal(tag(s, "http.response.status_code"), 404);
          diagnostic(s, {
            ...statusError(404, "HTTP status 404"),
            ...(s === part.controllerClient
              ? { "antnest.outcome": "failure" }
              : {}),
          });
        }
        for (const s of [
          part.consoleClient,
          part.consoleServer,
          part.controllerClient,
          server,
        ])
          claim(part, s, "rebuild-operation-not-yet-inserted");
        early.push({
          trace_id: row.trace_id,
          sql_span_id: sql.spanID,
          server_span_id: server.spanID,
        });
      } else if (operation) {
        assert.equal(tag(server, "antnest.operation.id"), requestID);
        assert.equal(tag(server, "antnest.operation.phase"), row.body.phase);
        assert.equal(tag(server, "antnest.outcome"), row.body.state);
        if (row.trace_id === p.operation.trace_id)
          assert(
            end(proof.completedCommit) <= sql.startTime,
            "completed operation read preceded COMMIT",
          );
        for (const s of db)
          assert(
            /^SELECT /u.test(query(s)) && tag(s, "pgx.rows_affected") === 1,
            "operation query changed business state",
          );
      } else assert.equal(db.length, 1);
      requests.push({
        trace_id: row.trace_id,
        server_span_id: server.spanID,
        sql_span_id: sql.spanID,
        status: row.status,
      });
    } else
      assert.equal(row.status, 200, "unowned Rebuild prerequisite refusal");
  }
  const keys = new Set(owned.map((r) => `${r.trace_id}:${r.span_id}`));
  for (const { trace } of parts)
    for (const span of trace.spans)
      if (!keys.has(`${trace.traceID}:${span.spanID}`) && !neutral.has(span))
        successful(span, trace, expected);
  return {
    status: "passed",
    request_id: requestID,
    agent_id: agentID,
    original_run_id: evidence.run_id,
    original_runtime_execution_id: evidence.runtime.runtime_execution_id,
    runtime_execution_id: p.runtime.runtime_execution_id,
    command_trace_id: p.command.trace_id,
    command_status: p.command.status,
    operation_trace_id: p.operation.trace_id,
    receipt_trace_id: p.receipt.trace_id,
    ready_trace_id: p.ready.trace_id,
    trace_ids: traces.map((t) => t.traceID),
    ...proof.report,
    operation_insert_span_id: proof.operationInsert.spanID,
    operation_insert_commit_span_id: proof.operationInsertCommit.spanID,
    completed_commit_span_id: proof.completedCommit.spanID,
    requests,
    early_operation_queries: early,
    owned_error_spans: owned,
    ...resolveTraceDiagnostics(traces[0], traces),
  };
}
