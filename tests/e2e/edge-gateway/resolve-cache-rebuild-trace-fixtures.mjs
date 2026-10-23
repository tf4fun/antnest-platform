import { createHash } from "node:crypto";
import {
  resolutionFixture,
  setTag,
  resolvePrefix,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

// Small, hand-authored causal histories. These are not sanitized Docker dumps.
const operationRead =
  "SELECT request_id, request_fingerprint, agent_id, kind, phase, state, source_spec_revision_id, source_execution_revision_id, source_runtime_revision, source_runtime_absent, target_spec_revision_id, child_request_id, network_attachment, source_runtime_inspection, source_runtime_absence_proof, runtime_result, network_release_outcome, error_code, error_detail, retryable, created_at, updated_at, owner_revocation_sequence, drain_deadline_at, settlement_outcome FROM agent_controller.agent_lifecycle_operations WHERE request_id = $1";
const preparationRead =
  "SELECT request_id, request_fingerprint, kind, agent_id, organization_id, target_spec, target_spec_digest, expected_aggregate_sequence, expected_spec_revision_id, expected_execution_revision_id, expected_runtime_revision, state, preparation_attempt, prepared_reference_id, created_at, updated_at FROM agent_controller.agent_skill_preparation_intents WHERE request_id=$1";
const advance =
  "UPDATE agent_controller.agent_lifecycle_operations AS operation SET phase = $2, child_request_id = $3, network_attachment = COALESCE($4, network_attachment), runtime_result = COALESCE($5, runtime_result), updated_at = $6 WHERE request_id = $1 AND state = 'running' AND phase = $7 AND EXISTS ( SELECT 1 FROM agent_controller.agents AS agent WHERE agent.id = operation.agent_id AND agent.active_operation_request_id = operation.request_id )";

export function rebuildTraceFixture({ status = 503, early = true } = {}) {
  const run = {
    run_id: "run",
    agent_id: "agent",
    session_id: "session",
    principal_id: "owner",
    state: "unresolved",
    terminal_class: "unresolved",
    executor_state: "quiescent",
    tool_effect_state: "unknown",
    error_class: "cancelled_tool_outcome_unknown",
    unknown_effect_source: "runtime_mcp",
    stop_reason: null,
    execution_snapshot: { executionRevision: "execution-old" },
  };
  const container = {
    id: "container-old",
    agent_id: "agent",
    project: "project",
    image: "image-sha",
    volume: "workspace",
    generation: 1,
    running: true,
    health: "healthy",
  };
  const evidence = {
    policy_revision: 4,
    transport: "http-sse",
    project: "project",
    agent_id: "agent",
    run_id: "run",
    session_id: "session",
    settings: { resolveTTLMS: 10000 },
    http: [],
    audit: { body: run },
    runtime: {
      organization_id: "org",
      runtime_revision: "runtime-old",
      execution_revision: "execution-old",
      runtime_execution_id: "execution-id-old",
      container,
      quiescent: { work: { effects: "started\nemitted\n" } },
    },
    run_storage: {
      after: {
        record: {
          run_id: "run",
          state: "unresolved",
          snapshot_sha256: "a".repeat(64),
        },
      },
    },
  };
  let sequence = 10000,
    clock = 10;
  const row = (
    label,
    path,
    body,
    { method = "GET", code = 200, scope = "admin-scope" } = {},
  ) => {
    const r = {
      label,
      path,
      method,
      status: code,
      credential_scope: scope,
      cache_control: "no-store, no-store",
      set_cookie_count: 0,
      trace_id: (++sequence).toString(16).padStart(32, "0"),
      started_at: clock++,
      at: clock++,
      body,
    };
    evidence.http.push(r);
    return r;
  };
  const admin = row(
    "audit-login",
    "/api/session/login",
    {
      principal: {
        user_id: "administrator",
        membership_id: "admin-membership",
        organization_id: "org",
        organization_role: "admin",
        active: true,
      },
    },
    { method: "POST" },
  );
  admin.issued_credential_scope = "admin-scope";
  const p = (evidence.recovery_preparation = {
    started_at: clock++,
    request: {
      path: "/api/admin/agents/agent/rebuild",
      idempotency_key: "one-command",
      body: { template_id: "template", template_revision: 1 },
    },
    responses: [],
  });
  const requestID =
    "lifecycle-" +
    createHash("sha256").update("org\0one-command").digest("hex");
  const identity = {
    request_id: requestID,
    agent_id: "agent",
    kind: "rebuild",
  };
  const audit = (phase) => ({
    run: row(
      `recovery-rebuild-${phase}-run`,
      "/api/admin/execution-audits/run",
      structuredClone(run),
    ),
    events: row(
      `recovery-rebuild-${phase}-events`,
      "/api/admin/execution-audits/run/events?stream=execution&limit=100",
      {
        stream: "execution",
        items: [{ event_id: "event", run_id: "run" }],
        next_cursor: null,
      },
    ),
    inventory: row(
      `recovery-rebuild-${phase}-inventory`,
      "/api/admin/execution-audits?agent_id=agent&limit=100",
      { items: [structuredClone(run)], next_cursor: null },
    ),
    stored: { record: structuredClone(evidence.run_storage.after.record) },
  });
  p.before = audit("before");
  p.command = row(
    "recovery-rebuild-command",
    p.request.path,
    status === 202
      ? { ...identity, state: "running" }
      : {
          code: "console_unavailable",
          message: "Admin Console is unavailable",
        },
    { method: "POST", code: status },
  );
  p.receipt = row(
    "recovery-rebuild-preparation",
    "/api/admin/agent-skill-preparations/by-idempotency-key",
    { ...identity, state: "ready" },
  );
  const absent = early
    ? row(
        "recovery-rebuild-operation",
        `/api/admin/operations/${requestID}`,
        {
          code: "operation_not_found",
          message: "lifecycle operation was not found",
          retryable: false,
        },
        { code: 404 },
      )
    : undefined;
  p.operation = row(
    "recovery-rebuild-operation",
    `/api/admin/operations/${requestID}`,
    { ...identity, state: "completed", phase: "completed" },
  );
  p.ready = row("recovery-rebuild-ready", "/api/admin/agents/agent", {
    agent_id: "agent",
    owner_user_id: "owner",
    desired_state: "enabled",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    readiness: "ready",
    executable_execution_revision: "execution-new",
    runtime: { runtime_revision: "runtime-new" },
    configuration: { template: { template_id: "template", revision: 1 } },
  });
  const freshContainer = { ...container, id: "container-new", generation: 2 };
  const observation = {
    started_at: clock++,
    at: clock++,
    container: freshContainer,
    status: {
      agent_id: "agent",
      generation: 2,
      execution_id: "execution-id-new",
      status: "ready",
    },
    work: { effects: evidence.runtime.quiescent.work.effects },
  };
  p.runtime = {
    organization_id: "org",
    runtime_revision: "runtime-new",
    runtime_execution_id: "execution-id-new",
    execution_revision: "execution-new",
    container: freshContainer,
    observations: [observation],
    observation,
  };
  p.after = audit("after");
  p.at = clock++;
  p.responses = evidence.http.filter((r) =>
    r.label.startsWith("recovery-rebuild-"),
  );
  const traces = new Map(),
    archivedTraceIDs = new Set(),
    parts = [];
  function raw(r) {
    const f = resolutionFixture("cache"),
      t = f.trace;
    t.traceID = r.trace_id;
    for (const s of t.spans) {
      s.traceID = r.trace_id;
      for (const ref of s.references) ref.traceID = r.trace_id;
    }
    for (const [id, service] of Object.entries({
      console: "admin-console",
      controller: "agent-controller",
      runtime: "runtime-controller",
      egress: "antnest-runtime-egress",
      acp: "agent-acp-service",
    }))
      t.processes[id] = {
        serviceName: service,
        tags: fields({
          "host.name": `${id}-host`,
          "process.pid": 1,
          "service.instance.id": `${id}-instance`,
        }),
      };
    setTag(f.root, "http.route", "/api/admin/{path...}");
    setTag(f.root, "http.request.method", r.method);
    setTag(f.root, "http.response.status_code", r.status);
    setTag(f.decision, resolvePrefix + "profile", "console");
    f.upstream.operationName = `HTTP ${r.method} admin-console`;
    setTag(f.upstream, "http.request.method", r.method);
    setTag(f.upstream, "http.response.status_code", r.status);
    let n = 0;
    const add = (
      name,
      process,
      parent,
      attrs = {},
      start = 1021000,
      duration = 100,
    ) => {
      const s = {
        traceID: t.traceID,
        spanID: `part-${++n}`,
        processID: process,
        operationName: name,
        startTime: start,
        duration,
        references: [
          { refType: "CHILD_OF", traceID: t.traceID, spanID: parent.spanID },
        ],
        tags: fields(attrs),
        logs: [],
      };
      t.spans.push(s);
      return s;
    };
    const rpc = (parent, service, method, route, start, code = 200) => {
      const client = add(
        `HTTP ${method} ${t.processes[service].serviceName}`,
        parent.processID,
        parent,
        {
          "span.kind": "client",
          "http.request.method": method,
          "http.response.status_code": code,
        },
        start,
        2000,
      );
      const server = add(
        `HTTP ${method} ${route}`,
        service,
        client,
        {
          "span.kind": "server",
          "http.request.method": method,
          "http.route": route,
          "http.response.status_code": code,
        },
        start + 100,
        1800,
      );
      return { client, server };
    };
    const sql = (parent, q, rows, start) =>
      add(
        q.split(" ")[0].toUpperCase(),
        parent.processID,
        parent,
        {
          "span.kind": "client",
          "db.system.name": "postgresql",
          "db.operation.name": q.split(" ")[0].toUpperCase(),
          "db.query.text": q,
          "pgx.rows_affected": rows,
        },
        start,
        50,
      );
    const tx = (parent, queries, start) => {
      const transaction = add(
        "postgresql transaction",
        parent.processID,
        parent,
        {
          "span.kind": "internal",
          "db.system.name": "postgresql",
          "antnest.transaction.outcome": "committed",
        },
        start,
        5000,
      );
      const begin = sql(
        transaction,
        parent.processID === "runtime"
          ? "begin isolation level serializable"
          : "begin",
        0,
        start + 100,
      );
      const writes = queries.map((q, i) =>
        sql(transaction, q, 1, start + 300 + i * 100),
      );
      const commit = sql(transaction, "commit", 0, start + 4000);
      return { transaction, begin, writes, commit };
    };
    const consoleServer = add(
      `HTTP ${r.method} Console`,
      "console",
      f.upstream,
      {
        "span.kind": "server",
        "http.request.method": r.method,
        "http.route":
          r.label === "recovery-rebuild-ready"
            ? "/api/admin/agents/{agent_id}"
            : r.label.endsWith("-events")
              ? "/api/admin/execution-audits/{run_id}/events"
              : r.label.endsWith("-inventory")
                ? "/api/admin/execution-audits"
                : "/api/admin/execution-audits/{run_id}",
        "http.response.status_code": r.status,
      },
      1020100,
      8000,
    );
    const part = {
      ...f,
      row: r,
      add,
      rpc,
      sql,
      tx,
      consoleServer,
      consoleClient: f.upstream,
    };
    traces.set(t.traceID, t);
    archivedTraceIDs.add(t.traceID);
    parts.push(part);
    return part;
  }
  for (const r of p.responses) raw(r);
  const command = parts.find((f) => f.row === p.command);
  const controller = (f, route) => {
    const { client, server } = f.rpc(
      f.consoleServer,
      "controller",
      f.row.method,
      route,
      1020400,
      f.row.status,
    );
    f.controllerClient = client;
    f.controllerServer = server;
    return server;
  };
  setTag(
    command.consoleServer,
    "http.route",
    "/api/admin/agents/{agent_id}/rebuild",
  );
  controller(command, "/internal/agents/{agent_id}/rebuild");
  setTag(command.controllerServer, "antnest.agent.id", "agent");
  const update = (command.update = command.add(
    "UpdateWithStartWorkflow:admission",
    "controller",
    command.controllerServer,
    { "span.kind": "client" },
    1020600,
    1000,
  ));
  const workflowID = `agent-rebuild/${requestID}`;
  const workflow = (command.workflow = command.add(
    "RunWorkflow:LifecycleWorkflow",
    "controller",
    update,
    {
      "span.kind": "server",
      temporalWorkflowID: workflowID,
      temporalRunID: "temporal-run",
      "antnest.temporal.workflow.span_end": "workflow_return",
    },
    1020700,
    900000,
  ));
  const eventSQL =
    "INSERT INTO agent_controller.agent_events ( event_id ) VALUES ($1)";
  const configurationSQL =
    "INSERT INTO agent_controller.execution_configuration_sync (organization_id, revision) VALUES ($1, 1) ON CONFLICT (organization_id) DO UPDATE SET revision=execution_configuration_sync.revision+1, updated_at=NOW()";
  const phaseSQL = {
    admit_lifecycle: [
      "INSERT INTO agent_controller.agent_spec_revisions ( id, agent_id ) VALUES ($1, $2)",
      "INSERT INTO agent_controller.agent_lifecycle_operations ( request_id, request_fingerprint, agent_id, kind, phase, state, source_runtime_revision ) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      "UPDATE agent_controller.agents SET active_operation_request_id = $2, aggregate_sequence = $3, updated_at = $4 WHERE id = $1 AND active_operation_request_id = '' AND aggregate_sequence = $5 AND desired_state = 'enabled' AND lifecycle_state = $9 AND executable_spec_revision_id = $6 AND executable_execution_revision_id = $7 AND runtime_revision = $8 AND last_successful_execution_revision_id = $10",
      eventSQL,
      configurationSQL,
    ],
    drain: [
      "UPDATE agent_controller.agent_lifecycle_operations AS operation SET phase = 'network_fence', child_request_id = $2, settlement_outcome = $3, updated_at = $4 WHERE request_id = $1 AND state = 'running' AND phase = 'drain' AND drain_deadline_at > clock_timestamp() AND EXISTS (SELECT 1 FROM agent_controller.agents AS agent WHERE agent.id = operation.agent_id AND agent.active_operation_request_id = operation.request_id)",
    ],
    network_fence: [advance],
    runtime_update: [advance],
    network_ensure: [advance],
    publish: [
      "UPDATE agent_controller.agents SET lifecycle_state = 'created', activation_state = 'enabled', runtime_revision = $3, runtime_execution_id = '', runtime_mcp_endpoint = '' WHERE id = $1 AND active_operation_request_id = $6 AND aggregate_sequence = $7",
      "UPDATE agent_controller.agents SET access_revision = $2 WHERE id = $1",
      eventSQL,
      "UPDATE agent_controller.agent_lifecycle_operations SET phase = 'completed', state = 'completed', child_request_id = '', error_code = '', error_detail = '', retryable = FALSE, updated_at = $2 WHERE request_id = $1",
      configurationSQL,
    ],
  };
  const activities = (command.activities = {});
  for (const [i, [name, queries]] of Object.entries(phaseSQL).entries()) {
    const start = 1100000 + i * 100000;
    const activity = command.add(
      `RunActivity:${name === "admit_lifecycle" ? name : `lifecycle.${name}`}`,
      "controller",
      workflow,
      {
        "span.kind": "server",
        temporalWorkflowID: workflowID,
        temporalRunID: "temporal-run",
      },
      start,
      90000,
    );
    activities[name] = {
      activity,
      ...command.tx(activity, queries, start + 80000),
    };
  }
  if (status === 202) {
    // A successful admission waits for the operation INSERT/COMMIT. Later
    // Runtime phases remain asynchronous and may outlive this HTTP response.
    for (const [i, s] of [
      command.root,
      command.consoleClient,
      command.consoleServer,
      command.controllerClient,
      command.controllerServer,
      update,
    ].entries())
      s.duration = 1190000 - i * 1000 - s.startTime;
  }
  const d = activities.drain;
  d.applied = command.rpc(
    d.activity,
    "acp",
    "POST",
    "/rpc/agent-acp/apply-execution-snapshot",
    d.activity.startTime + 1000,
  );
  setTag(d.applied.client, "antnest.configuration.applied_revision", 8);
  d.settled = command.rpc(
    d.activity,
    "acp",
    "POST",
    "/rpc/agent-acp/settle-agent",
    d.activity.startTime + 4000,
  );
  for (const s of [d.settled.client, d.settled.server])
    for (const [key, value] of Object.entries({
      "antnest.operation.id": requestID,
      "antnest.agent.id": "agent",
      "antnest.configuration.revision": 8,
      "antnest.configuration.applied_revision": 8,
      "antnest.settlement.outcome": "runtime_barrier_required",
    }))
      setTag(s, key, value);
  for (const [name, methods] of [
    ["network_fence", ["GET", "PUT"]],
    ["network_ensure", ["PUT"]],
  ])
    for (const [i, method] of methods.entries())
      command.rpc(
        activities[name].activity,
        "egress",
        method,
        method === "GET"
          ? "/internal/agent-networks/{agent_id}"
          : "/internal/agent-network-attachments/{agent_id}",
        activities[name].activity.startTime + 1000 + i * 3000,
      );
  const a = activities.runtime_update;
  const childID =
    "acr_" +
    createHash("sha256")
      .update(`${requestID}\0runtime_update`)
      .digest("hex")
      .slice(0, 32);
  a.rpc = command.rpc(
    a.activity,
    "runtime",
    "POST",
    "/internal/runtimes/{agent_id}/update",
    a.activity.startTime + 1000,
  );
  a.rpc.client.duration = 70000;
  a.rpc.server.duration = 69000;
  setTag(a.rpc.client, "antnest.operation.request_id", childID);
  setTag(a.rpc.client, "antnest.agent.id", "agent");
  a.execution = command.add(
    "runtime.lifecycle.update_runtime",
    "runtime",
    a.rpc.server,
    {
      "span.kind": "internal",
      "antnest.operation.id": childID,
      "antnest.operation.kind": "update_runtime",
      "antnest.agent.id": "agent",
      "antnest.result": "completed",
      "antnest.runtime.revision": "runtime-new",
      "antnest.runtime.target_revision": "runtime-new",
    },
    a.activity.startTime + 2000,
    66000,
  );
  a.started = command.tx(
    a.execution,
    [
      "INSERT INTO runtime_controller.operations ( request_id, kind, state ) VALUES ($1,$2,$3)",
    ],
    a.activity.startTime + 3000,
  );
  a.completed = command.tx(
    a.execution,
    [
      "UPDATE runtime_controller.operations SET state = $1, effect = $2, inspection = $3, error_code = $4, error_detail = $5, updated_at = $6 WHERE request_id = $7 AND attempt = $8 AND state IN ('running', 'unknown')",
      "UPDATE runtime_controller.runtime_environments SET runtime_revision = $1, lifecycle_state = $2, generation = $3, spec_digest = $4, operation_id = NULL, updated_at = $5 WHERE agent_id = $6 AND operation_id = $7",
    ],
    a.activity.startTime + 10000,
  );
  const err = (span, tags, events = []) => {
    for (const [key, value] of Object.entries(tags)) setTag(span, key, value);
    span.logs = events.map((e, i) => ({
      timestamp: span.startTime + span.duration - events.length + i,
      fields: fields(e),
    }));
  };
  const event = (type, stage, message, types, causes, extra = {}) => ({
    event: "antnest.error",
    "error.type": type,
    "antnest.error.stage": stage,
    "antnest.error.message": message,
    "antnest.error.cause_types": JSON.stringify(types),
    ...(causes ? { "antnest.error.causes": JSON.stringify(causes) } : {}),
    ...extra,
  });
  const errorStatus = (type, description) => ({
    error: true,
    "error.type": type,
    "otel.status_code": "ERROR",
    "otel.status_description": description,
  });
  if (status === 503) {
    err(command.root, errorStatus("503", "503"));
    err(
      command.consoleClient,
      errorStatus("deadline_exceeded", "Request deadline exceeded"),
      [
        event("deadline_exceeded", "send", "Request deadline exceeded", [
          "context.deadlineExceededError",
        ]),
      ],
    );
    setTag(command.consoleClient, "http.response.status_code", undefined);
    for (const [s, type, stage, message, types, causes] of [
      [
        command.consoleServer,
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
        command.controllerClient,
        "cancelled",
        "send",
        "Request was cancelled",
        ["*errors.errorString"],
        ["Request was cancelled"],
      ],
    ])
      err(s, { "error.type": type, "antnest.outcome": "cancelled" }, [
        event(type, stage, message, types, causes, {
          "antnest.error.type": type,
          "antnest.error.code": type,
        }),
      ]);
    setTag(command.controllerClient, "http.response.status_code", undefined);
    setTag(command.controllerClient, "antnest.request.dispatched", true);
    err(
      command.controllerServer,
      {
        ...errorStatus("canceled", "503"),
        "antnest.error.code": "canceled",
        "antnest.error.type": "canceled",
        "antnest.error.stage": "request",
        "antnest.outcome": "canceled",
        "antnest.result": "error",
      },
      [
        event(
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
        event(
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
    err(
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
  }
  for (const f of parts.filter((f) =>
    ["recovery-rebuild-operation", "recovery-rebuild-preparation"].includes(
      f.row.label,
    ),
  )) {
    const operation = f.row.label.endsWith("-operation");
    setTag(
      f.consoleServer,
      "http.route",
      operation
        ? "/api/admin/operations/{request_id}"
        : "/api/admin/agent-skill-preparations/by-idempotency-key",
    );
    controller(
      f,
      operation
        ? "/internal/agent-operations/{request_id}"
        : "/internal/agent-skill-preparations/{request_id}",
    );
    f.read = f.sql(
      f.controllerServer,
      operation ? operationRead : preparationRead,
      f.row.status === 404 ? 0 : 1,
      1021000,
    );
    if (f.row.status === 404) {
      for (const s of f.trace.spans) s.startTime += 100000;
      err(f.consoleClient, errorStatus("404", "HTTP status 404"));
      err(f.controllerClient, errorStatus("404", "HTTP status 404"));
      setTag(f.controllerClient, "antnest.outcome", "failure");
      setTag(f.consoleServer, "antnest.outcome", "rejected");
      setTag(f.controllerServer, "antnest.outcome", "rejected");
      setTag(f.controllerServer, "antnest.result", "error");
      setTag(f.controllerServer, "antnest.error.code", "operation_not_found");
    } else if (operation) {
      for (const [key, value] of Object.entries({
        "antnest.operation.id": requestID,
        "antnest.operation.phase": "completed",
        "antnest.outcome": "completed",
      }))
        setTag(f.controllerServer, key, value);
      for (const s of f.trace.spans) s.startTime += 1000000;
    }
  }
  return {
    evidence,
    traces,
    archivedTraceIDs,
    parts,
    command,
    admin,
    requestID,
    absent: parts.find((f) => f.row === absent),
    final: parts.find((f) => f.row === p.operation),
    receipt: parts.find((f) => f.row === p.receipt),
  };
}
