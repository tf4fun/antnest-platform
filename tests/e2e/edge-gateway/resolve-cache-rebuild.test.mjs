import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { rebuildRecoveryAgent } from "./resolve-cache-rebuild.mjs";
import * as rebuild from "./resolve-cache-rebuild.mjs";

const requestID =
  "lifecycle-" +
  createHash("sha256").update("org\0one-command-key").digest("hex");

for (const status of [202, 503])
  test(`effectful Rebuild HTTP ${status} completes without Trace headers in auxiliary mode`, async () => {
    const f = fixture();
    f.controls.postStatus = status;
    const original = f.options.http;
    f.options.http = async (...args) => {
      const row = await original(...args);
      delete row.trace_id;
      return row;
    };
    const result = await rebuildRecoveryAgent({
      ...f.options,
      requireTrace: false,
    });
    assert.equal(result.status, "passed");
    assert.equal(
      f.calls.filter((row) => row.path?.endsWith("/rebuild")).length,
      1,
    );
    assert.equal(f.reads(), 2);
  });

for (const mutation of ["missing", "duplicate", "changed-body"])
  test(`auxiliary Rebuild rejects ${mutation} real HTTP receipt`, async () => {
    const f = fixture();
    const original = f.options.http;
    f.options.http = async (...args) => {
      const row = await original(...args);
      delete row.trace_id;
      if (mutation === "missing") f.evidence.http.pop();
      if (mutation === "duplicate") f.evidence.http.push(structuredClone(row));
      if (mutation === "changed-body")
        return { ...row, body: { foreign: true } };
      return row;
    };
    await assert.rejects(
      rebuildRecoveryAgent({ ...f.options, requireTrace: false }),
    );
    assert.equal(f.evidence.recovery_preparation.status, "failed");
  });

test("pure Rebuild business admission validates recorded replacement without Trace evidence", async () => {
  assert.equal(typeof rebuild.inspectRecoveryRebuild, "function");
  const f = fixture();
  await rebuildRecoveryAgent(f.options);
  const raw = structuredClone(f.evidence);
  const strip = (value) => {
    if (!value || typeof value !== "object") return;
    delete value.trace_id;
    for (const child of Object.values(value)) strip(child);
  };
  strip(raw);
  const before = structuredClone(raw);
  assert.equal(rebuild.inspectRecoveryRebuild(raw), raw.recovery_preparation);
  assert.deepEqual(raw, before);
  for (const change of [
    (p) => delete p.receipt,
    (p) => (p.operation.body.request_id = "other"),
    (p) => (p.runtime.container.id = raw.runtime.container.id),
    (p) => (p.runtime.observation.work.effects = "lost"),
    (p) => (p.after.events.body.next_cursor = "truncated"),
    (p) => (p.after.stored.record.state = "completed"),
    (p) => (p.at = p.started_at + 120001),
  ]) {
    const altered = structuredClone(raw);
    change(altered.recovery_preparation);
    assert.throws(() => rebuild.inspectRecoveryRebuild(altered));
  }
});

function fixture() {
  const controller = new AbortController(),
    calls = [];
  let clock = 0,
    reads = 0;
  const run = {
    run_id: "run",
    session_id: "session",
    agent_id: "agent",
    principal_id: "owner",
    state: "unresolved",
    terminal_class: "unresolved",
    executor_state: "quiescent",
    tool_effect_state: "unknown",
    error_class: "cancelled_tool_outcome_unknown",
    unknown_effect_source: "runtime_mcp",
    stop_reason: null,
    execution_snapshot: { executionRevision: "execution-old" },
    input: [{ type: "text", text: "held work" }],
    created_at: "2026-10-15T00:00:00Z",
  };
  const stored = {
    run_id: "run",
    state: "unresolved",
    snapshot_sha256: "a".repeat(64),
    runtime_revision: "runtime-old",
    runtime_execution_id: "runtime-execution-old",
  };
  const container = {
    id: "container-old",
    agent_id: "agent",
    image: "image",
    project: "project",
    volume: "workspace-volume",
    generation: 1,
    running: true,
    health: "healthy",
  };
  const original = {
    organization_id: "org",
    runtime_revision: "runtime-old",
    runtime_execution_id: "runtime-execution-old",
    execution_revision: "execution-old",
    container,
    quiescent: { work: { effects: "started\\nemitted\\n" } },
  };
  const evidence = {
    project: "project",
    agent_id: "agent",
    session_id: "session",
    run_id: "run",
    http: [
      {
        label: "audit-login",
        path: "/api/session/login",
        method: "POST",
        status: 200,
        started_at: -1,
        at: 0,
        issued_credential_scope: "admin-scope",
        body: {
          principal: {
            user_id: "administrator",
            membership_id: "membership",
            organization_id: "org",
            organization_role: "admin",
            active: true,
          },
        },
      },
    ],
    identity: { healthy: { running: true, health: "healthy", at: 0 } },
    audit: { body: structuredClone(run) },
    runtime: original,
    run_storage: { after: { record: structuredClone(stored) } },
  };
  const operation = {
    request_id: requestID,
    agent_id: "agent",
    kind: "rebuild",
    state: "completed",
    phase: "completed",
  };
  const agent = {
    agent_id: "agent",
    owner_user_id: "owner",
    lifecycle_state: "created",
    activation_state: "enabled",
    desired_state: "enabled",
    runtime_state: "available",
    executable_execution_revision: "execution-new",
    runtime: { runtime_revision: "runtime-new" },
    configuration: { template: { template_id: "template", revision: 3 } },
  };
  const observed = {
    organization_id: "org",
    runtime_revision: "runtime-new",
    runtime_execution_id: "runtime-execution-new",
    execution_revision: "execution-new",
    container: { ...container, id: "container-new", generation: 2 },
    observation: {
      status: {
        agent_id: "agent",
        generation: 2,
        status: "ready",
        execution_id: "runtime-execution-new",
      },
      work: { effects: original.quiescent.work.effects },
    },
  };
  const controls = {
    postStatus: 202,
    receiptStatus: 200,
    operationStatus: 200,
    receipt: { ...operation, state: "ready" },
    operation,
    agent,
    run,
    stored,
    observed,
    events: {
      stream: "execution",
      items: [{ event_id: "original-event", run_id: "run" }],
      next_cursor: null,
    },
    mutate: () => {},
  };
  const options = {
    fixture: {
      agentID: "agent",
      ownerID: "owner",
      template: { template_id: "template", revision: 3 },
    },
    administrator: {},
    evidence,
    signal: controller.signal,
    key: "one-command-key",
    now: () => clock,
    timeoutMS: 1000,
    async http(client, path, options = {}) {
      assert.equal(client, optionsForTest.administrator);
      calls.push({ path, ...options });
      controls.mutate(path, options);
      let status = 200,
        body;
      if (path.endsWith("/rebuild")) {
        status = controls.postStatus;
        body =
          status === 202
            ? structuredClone(operation)
            : {
                code: "console_unavailable",
                message: "Admin Console is unavailable",
              };
      } else if (path.endsWith("/by-idempotency-key")) {
        status = controls.receiptStatus;
        body = structuredClone(controls.receipt);
      } else if (path.startsWith("/api/admin/operations/")) {
        assert.equal(path, `/api/admin/operations/${requestID}`);
        status = controls.operationStatus;
        body =
          status === 404
            ? {
                code: "operation_not_found",
                message: "lifecycle operation was not found",
                retryable: false,
              }
            : structuredClone(controls.operation);
      } else if (path === "/api/admin/agents/agent")
        body = structuredClone(controls.agent);
      else if (path.endsWith("/events?stream=execution&limit=100"))
        body = structuredClone(controls.events);
      else if (path.includes("?agent_id="))
        body = structuredClone(
          controls.inventory ?? { items: [controls.run], next_cursor: null },
        );
      else {
        assert.equal(path, "/api/admin/execution-audits/run");
        body = structuredClone(controls.run);
      }
      const row = {
        label: options.label,
        credential_scope: "admin-scope",
        set_cookie_count: 0,
        cache_control: "no-store, no-store",
        path,
        method: options.body ? "POST" : "GET",
        status,
        body,
        started_at: clock,
        at: ++clock,
        trace_id: calls.length.toString(16).padStart(32, "0"),
      };
      evidence.http.push(row);
      return row;
    },
    async poll(check, label, signal) {
      for (let i = 0; i < 3; i++) {
        signal.throwIfAborted();
        const value = await check(signal);
        if (value) return value;
      }
      throw new Error(label + " timed out");
    },
    async readStoredRun(label, options) {
      calls.push({ stored: label });
      options.signal.throwIfAborted();
      reads++;
      return { record: structuredClone(controls.stored) };
    },
    async observeRuntime(ready, options) {
      assert.deepEqual(ready, controls.agent);
      options.signal.throwIfAborted();
      calls.push({ observed: true });
      const value = structuredClone(controls.observed);
      value.observation.container = structuredClone(value.container);
      value.observation.started_at = clock++;
      value.observation.at = clock++;
      value.observations = [value.observation];
      return value;
    },
  };
  const optionsForTest = options;
  return {
    options,
    evidence,
    controls,
    calls,
    controller,
    advance: (n) => {
      clock += n;
    },
    reads: () => reads,
  };
}

for (const status of [202, 503])
  test(`recovery Rebuild binds a single HTTP ${status} command to its exact completed receipt`, async () => {
    const f = fixture();
    f.controls.postStatus = status;
    const result = await rebuildRecoveryAgent(f.options);
    assert.equal(result.status, "passed");
    assert.equal(result.command.status, status);
    assert.equal(f.evidence.recovery_preparation, result);
    assert.equal(result.operation.body.request_id, requestID);
    const commands = f.calls.filter((c) => c.path?.endsWith("/rebuild"));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].headers["Idempotency-Key"], "one-command-key");
    assert.deepEqual(commands[0].body, {
      template_id: "template",
      template_revision: 3,
    });
    assert(
      f.calls
        .filter((c) => c.path?.endsWith("/by-idempotency-key"))
        .every((c) => c.headers["Idempotency-Key"] === "one-command-key"),
    );
    assert.equal(f.reads(), 2);
    assert.deepEqual(result.before.run.body, result.after.run.body);
  });

test("known operation 404 is bounded pending, followed by that same completed operation", async () => {
  const f = fixture();
  let attempts = 0;
  f.controls.mutate = (path) => {
    if (path.startsWith("/api/admin/operations/"))
      f.controls.operationStatus = ++attempts === 1 ? 404 : 200;
  };
  await rebuildRecoveryAgent(f.options);
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter((c) => c.path?.endsWith("/rebuild")).length, 1);
  assert(
    f.evidence.http.some(
      (r) => r.path.startsWith("/api/admin/operations/") && r.status === 404,
    ),
  );
});

for (const [name, change] of [
  [
    "missing preparation",
    (f) => {
      f.controls.receiptStatus = 404;
    },
  ],
  [
    "foreign receipt Agent",
    (f) => {
      f.controls.receipt.agent_id = "other";
    },
  ],
  [
    "foreign receipt kind",
    (f) => {
      f.controls.receipt.kind = "enable";
    },
  ],
  [
    "receipt disagrees with ACK",
    (f) => {
      f.controls.receipt.request_id = "unrelated";
    },
  ],
  [
    "failed preparation",
    (f) => {
      f.controls.receipt.state = "failed";
    },
  ],
  [
    "missing operation",
    (f) => {
      f.controls.operationStatus = 404;
    },
  ],
  [
    "failed operation",
    (f) => {
      f.controls.operation.state = "failed";
    },
  ],
  [
    "foreign completed operation",
    (f) => {
      f.controls.operation.agent_id = "other";
    },
  ],
  [
    "unready Agent",
    (f) => {
      f.controls.agent.runtime_state = "unavailable";
    },
  ],
  [
    "foreign ready owner",
    (f) => {
      f.controls.agent.owner_user_id = "other";
    },
  ],
  [
    "same Runtime revision",
    (f) => {
      f.controls.agent.runtime.runtime_revision = "runtime-old";
    },
  ],
  [
    "same physical container",
    (f) => {
      f.controls.observed.container.id = "container-old";
    },
  ],
  [
    "same Runtime execution",
    (f) => {
      f.controls.observed.runtime_execution_id = "runtime-execution-old";
    },
  ],
  [
    "foreign Runtime organization",
    (f) => {
      f.controls.observed.organization_id = "other";
    },
  ],
  [
    "foreign Runtime image",
    (f) => {
      f.controls.observed.container.image = "other";
    },
  ],
  [
    "foreign workspace",
    (f) => {
      f.controls.observed.container.volume = "other";
    },
  ],
  [
    "lost original tool effects",
    (f) => {
      f.controls.observed.observation.work.effects = "";
    },
  ],
  [
    "unmatched live status",
    (f) => {
      f.controls.observed.observation.status.execution_id = "other";
    },
  ],
  [
    "truncated audit history",
    (f) => {
      f.controls.events.next_cursor = "more";
    },
  ],
])
  test(`recovery Rebuild rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(rebuildRecoveryAgent(f.options));
    assert(f.calls.filter((c) => c.path?.endsWith("/rebuild")).length <= 1);
    assert.notEqual(f.evidence.recovery_preparation?.status, "passed");
  });

for (const field of ["events", "run", "stored"])
  test(`recovery Rebuild rejects changed original ${field} after replacing Runtime`, async () => {
    const f = fixture(),
      observe = f.options.observeRuntime;
    f.options.observeRuntime = async (...args) => {
      const result = await observe(...args);
      if (field === "events")
        f.controls.events.items.push({ event_id: "rewritten" });
      if (field === "run")
        f.controls.run.input = [{ type: "text", text: "rewritten" }];
      if (field === "stored")
        f.controls.stored.snapshot_sha256 = "b".repeat(64);
      return result;
    };
    await assert.rejects(rebuildRecoveryAgent(f.options));
    assert.notEqual(f.evidence.recovery_preparation.status, "passed");
  });

test("aborted recovery sends no mutation", async () => {
  const f = fixture();
  f.controller.abort();
  await assert.rejects(rebuildRecoveryAgent(f.options), { name: "AbortError" });
  assert.equal(f.calls.length, 0);
});

for (const state of ["rejected", "invalidated", "abandoned", "unknown"])
  test(`Rebuild cannot accept actual failed preparation state ${state}`, async () => {
    const f = fixture();
    f.controls.receipt.state = state;
    await assert.rejects(rebuildRecoveryAgent(f.options));
  });

for (const [name, change] of [
  [
    "preparation error code",
    (f) => {
      f.controls.receipt.error_code = "package_invalid";
    },
  ],
  [
    "missing events",
    (f) => {
      delete f.controls.events.items;
    },
  ],
  [
    "empty events",
    (f) => {
      f.controls.events.items = [];
    },
  ],
  [
    "wrong audit stream",
    (f) => {
      f.controls.events.stream = "messages";
    },
  ],
  [
    "missing Run inventory",
    (f) => {
      f.controls.inventory = { next_cursor: null };
    },
  ],
  [
    "empty Run inventory",
    (f) => {
      f.controls.inventory = { items: [], next_cursor: null };
    },
  ],
  [
    "foreign Run inventory",
    (f) => {
      f.controls.inventory = {
        items: [{ ...f.controls.run, run_id: "foreign" }],
        next_cursor: null,
      };
    },
  ],
])
  test(`Rebuild cannot accept ${name}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(rebuildRecoveryAgent(f.options));
  });

test("released Skill preparation still requires the original completed Rebuild", async () => {
  const f = fixture();
  f.controls.receipt.state = "released";
  assert.equal((await rebuildRecoveryAgent(f.options)).status, "passed");
});

for (const state of [
  "queued",
  "preparing",
  "retry_wait",
  "paused",
  "invalidated",
  "cleanup_pending",
])
  test(`Rebuild waits for ${state} preparation before accepting its ready receipt`, async () => {
    const f = fixture();
    let reads = 0;
    f.controls.mutate = (path) => {
      if (path.endsWith("/by-idempotency-key"))
        f.controls.receipt.state = ++reads === 1 ? state : "ready";
    };
    assert.equal((await rebuildRecoveryAgent(f.options)).status, "passed");
    assert.equal(
      reads,
      2,
      "pending receipt cannot substitute for preparation completion",
    );
    assert.equal(f.calls.filter((c) => c.path?.endsWith("/rebuild")).length, 1);
  });

for (const action of ["abort", "late"])
  test(`recovery rejects ${action} completion without issuing subsequent reads`, async () => {
    const f = fixture();
    f.controls.mutate = (path) => {
      if (path.endsWith("/rebuild")) {
        if (action === "abort") f.controller.abort();
        else f.advance(1001);
      }
    };
    await assert.rejects(rebuildRecoveryAgent(f.options));
    assert.equal(f.calls.at(-1).path, "/api/admin/agents/agent/rebuild");
    assert.equal(
      f.evidence.recovery_preparation.command.status,
      202,
      "late actual response must remain evidence",
    );
  });
