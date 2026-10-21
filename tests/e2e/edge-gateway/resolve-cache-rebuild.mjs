import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { agentReady } from "../../support/verification/agent-state.mjs";
import {
  assertCancelledRun,
  assertUnchangedAudit,
} from "../workspace-closeout/current-evidence.mjs";
import { pollOutageObservation } from "./resolve-cache-runtime-work.mjs";
import { inspectRebuildPreparationBusiness } from "./resolve-cache-rebuild-business.mjs";

export function inspectRecoveryRebuild(evidence) {
  const { p } = inspectRebuildPreparationBusiness(evidence, {
    requireTrace: false,
  });
  const original = evidence.runtime,
    accepted = evidence.audit.body;
  const text = (value) => assert(typeof value === "string" && value.length > 0);
  for (const value of [
    evidence.agent_id,
    evidence.session_id,
    evidence.run_id,
    accepted.principal_id,
  ])
    text(value);
  assert.equal(accepted.run_id, evidence.run_id);
  assert.equal(evidence.identity.healthy.running, true);
  assert.equal(evidence.identity.healthy.health, "healthy");
  assertCancelledRun(
    accepted,
    evidence.agent_id,
    evidence.session_id,
    original.execution_revision,
  );
  assert.equal(evidence.run_storage.after.record.state, "unresolved");
  assert(original.quiescent?.work.effects);
  assert(
    Number.isFinite(p.started_at) &&
      Number.isFinite(p.at) &&
      p.at >= p.started_at &&
      p.at - p.started_at <= 120000,
    "complete bounded Rebuild observation required",
  );
  return p;
}

// One command, then read-only receipt queries. A Gateway 503 is retained as a
// failure response; only the same command's completed operation and physical
// replacement prove that this fixture prerequisite actually finished.
export async function rebuildRecoveryAgent({
  fixture,
  administrator,
  evidence,
  signal,
  http,
  readStoredRun,
  observeRuntime,
  requireTrace = true,
  poll = pollOutageObservation,
  key = randomUUID(),
  timeoutMS = 120000,
  now = () => performance.now(),
}) {
  signal?.throwIfAborted();
  assert(Number.isFinite(timeoutMS) && timeoutMS > 0 && timeoutMS <= 120000);
  assert.equal(evidence.agent_id, fixture.agentID);
  assert.equal(evidence.audit.body.run_id, evidence.run_id);
  assert.equal(evidence.audit.body.principal_id, fixture.ownerID);
  assert.equal(evidence.identity.healthy.running, true);
  assert.equal(evidence.identity.healthy.health, "healthy");
  const original = evidence.runtime;
  assertCancelledRun(
    evidence.audit.body,
    evidence.agent_id,
    evidence.session_id,
    original.execution_revision,
  );
  assert.equal(evidence.run_storage.after.record.state, "unresolved");
  assert(original.quiescent?.work.effects);
  assert(typeof key === "string" && key.trim() === key && key.length > 0);
  const deadline = now() + timeoutMS;
  const bounded = AbortSignal.any(
    [signal, AbortSignal.timeout(Math.ceil(timeoutMS))].filter(Boolean),
  );
  const remaining = () => {
    bounded.throwIfAborted();
    const value = deadline - now();
    assert(value > 0, "recovery Rebuild timed out");
    return value;
  };
  const agentPath = `/api/admin/agents/${encodeURIComponent(fixture.agentID)}`;
  const auditPath = `/api/admin/execution-audits/${encodeURIComponent(evidence.run_id)}`;
  const p = (evidence.recovery_preparation = {
    status: "preparing",
    started_at: now(),
    request: {
      path: `${agentPath}/rebuild`,
      idempotency_key: key,
      body: {
        template_id: fixture.template.template_id,
        template_revision: fixture.template.revision,
      },
    },
    responses: [],
  });
  const read = async (label, path, options = {}) => {
    remaining();
    const row = await http(administrator, path, {
      ...options,
      requestSignal: bounded,
      label: `recovery-rebuild-${label}`,
    });
    p.responses.push(row);
    if (label === "command") p.command = row;
    remaining();
    const actual = evidence.http.filter((r) =>
      requireTrace
        ? r.trace_id === row.trace_id
        : ["label", "method", "path", "started_at", "at"].every(
            (key) => r[key] === row[key],
          ),
    );
    assert.equal(
      actual.length,
      1,
      "actual Rebuild response missing or duplicate",
    );
    assert.deepEqual(actual[0], row);
    if (requireTrace) assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
    assert.equal(row.path, path);
    assert.equal(row.method, options.body ? "POST" : "GET");
    assert(
      [options.status ?? 200].flat().includes(row.status),
      "unexpected Rebuild HTTP status",
    );
    return row;
  };
  const wait = (check, label) => poll(check, label, bounded, remaining(), 250);
  const audit = async (label) => {
    const run = await read(`${label}-run`, auditPath);
    const events = await read(
      `${label}-events`,
      `${auditPath}/events?stream=execution&limit=100`,
    );
    const inventory = await read(
      `${label}-inventory`,
      `/api/admin/execution-audits?agent_id=${encodeURIComponent(fixture.agentID)}&limit=100`,
    );
    assert.equal(
      events.body.next_cursor,
      null,
      "original audit events truncated",
    );
    assert.equal(
      inventory.body.next_cursor,
      null,
      "original audit inventory truncated",
    );
    assert.equal(events.body.stream, "execution");
    assert(
      Array.isArray(events.body.items) && events.body.items.length > 0,
      "original execution events missing",
    );
    assert(
      Array.isArray(inventory.body.items),
      "original Run inventory missing",
    );
    const runs = inventory.body.items.filter(
      (r) => r.run_id === evidence.run_id,
    );
    assert.equal(
      runs.length,
      1,
      "original Run absent or duplicated in inventory",
    );
    for (const field of [
      "run_id",
      "agent_id",
      "session_id",
      "principal_id",
      "state",
    ])
      assert.equal(
        runs[0][field],
        evidence.audit.body[field],
        "foreign original Run inventory",
      );
    const stored = await readStoredRun(`rebuild-${label}`, {
      signal: bounded,
      timeoutMS: remaining(),
    });
    remaining();
    assert.deepEqual(
      run.body,
      evidence.audit.body,
      "original cancelled Run changed",
    );
    assert.deepEqual(
      stored.record,
      evidence.run_storage.after.record,
      "original stored Run changed",
    );
    return { run, events, inventory, stored };
  };
  const identity = (body, requestID) => {
    assert.equal(body.agent_id, fixture.agentID, "foreign Rebuild Agent");
    assert.equal(body.kind, "rebuild", "foreign lifecycle kind");
    assert(typeof body.request_id === "string" && body.request_id.length > 0);
    if (requestID)
      assert.equal(body.request_id, requestID, "foreign lifecycle request");
  };
  try {
    p.before = await audit("before");
    p.command = await read("command", p.request.path, {
      body: p.request.body,
      headers: { "Idempotency-Key": key },
      status: [202, 503],
    });
    let requestID;
    if (p.command.status === 202) {
      identity(p.command.body);
      requestID = p.command.body.request_id;
    }
    p.receipt = await wait(async () => {
      const row = await read(
        "preparation",
        "/api/admin/agent-skill-preparations/by-idempotency-key",
        {
          headers: { "Idempotency-Key": key },
          status: [200, 404],
        },
      );
      if (row.status === 404) return false;
      identity(row.body, requestID);
      requestID ??= row.body.request_id;
      if (
        [
          "queued",
          "preparing",
          "retry_wait",
          "paused",
          "invalidated",
          "cleanup_pending",
        ].includes(row.body.state)
      )
        return false;
      assert(
        ["ready", "released"].includes(row.body.state),
        "Rebuild preparation failed",
      );
      assert(
        !row.body.error_code,
        "successful Rebuild preparation has an error",
      );
      return row;
    }, "same-key Rebuild preparation");
    requestID = p.receipt.body.request_id;
    p.operation = await wait(async () => {
      const row = await read(
        "operation",
        `/api/admin/operations/${encodeURIComponent(requestID)}`,
        { status: [200, 404] },
      );
      if (row.status === 404) return false;
      identity(row.body, requestID);
      assert(
        ["running", "completed"].includes(row.body.state),
        "Rebuild operation failed",
      );
      assert(!row.body.error_code, "completed Rebuild has an error");
      return row.body.state === "completed" && row;
    }, "same Rebuild operation completed");
    p.ready = await wait(async () => {
      const row = await read("ready", agentPath);
      assert.equal(row.body.agent_id, fixture.agentID);
      assert.equal(row.body.owner_user_id, fixture.ownerID);
      return agentReady(row.body) && row;
    }, "rebuilt Agent ready");
    assert.notEqual(
      p.ready.body.runtime.runtime_revision,
      original.runtime_revision,
    );
    assert.notEqual(
      p.ready.body.executable_execution_revision,
      original.execution_revision,
    );
    p.runtime = await observeRuntime(p.ready.body, {
      signal: bounded,
      timeoutMS: remaining(),
    });
    remaining();
    const fresh = p.runtime;
    assert.equal(fresh.organization_id, original.organization_id);
    assert.equal(fresh.runtime_revision, p.ready.body.runtime.runtime_revision);
    assert.equal(
      fresh.execution_revision,
      p.ready.body.executable_execution_revision,
    );
    assert(
      fresh.runtime_execution_id &&
        fresh.runtime_execution_id !== original.runtime_execution_id,
    );
    assert(fresh.container.id && fresh.container.id !== original.container.id);
    for (const field of ["project", "agent_id", "image", "volume"])
      assert.equal(
        fresh.container[field],
        original.container[field],
        `rebuilt Runtime ${field} changed`,
      );
    assert.equal(fresh.container.running, true);
    assert.equal(fresh.container.health, "healthy");
    assert(fresh.container.generation > original.container.generation);
    for (const [field, value] of Object.entries({
      agent_id: fixture.agentID,
      generation: fresh.container.generation,
      status: "ready",
      execution_id: fresh.runtime_execution_id,
    }))
      assert.equal(
        fresh.observation.status[field],
        value,
        `rebuilt Runtime status ${field}`,
      );
    // A retained PID marker belongs to the old container's PID namespace.
    // Only its effects are compared here; it cannot identify a new process.
    assert.equal(
      fresh.observation.work.effects,
      original.quiescent.work.effects,
      "Rebuild lost original workspace effects",
    );
    p.after = await audit("after");
    assertUnchangedAudit(
      { run: p.before.run.body, events: p.before.events.body },
      { run: p.after.run.body, events: p.after.events.body },
    );
    assert.deepEqual(
      p.after.inventory.body,
      p.before.inventory.body,
      "Rebuild changed accepted Run inventory",
    );
    remaining();
    p.at = now();
    inspectRecoveryRebuild(evidence);
    p.status = "passed";
    return p;
  } catch (error) {
    p.status = "failed";
    p.failure = error.message;
    throw error;
  }
}
