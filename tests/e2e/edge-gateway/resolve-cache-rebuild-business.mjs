import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { agentReady } from "../../support/verification/agent-state.mjs";
import {
  assertCancelledRun,
  assertUnchangedAudit,
} from "../workspace-closeout/current-evidence.mjs";

const one = (items, message) => {
  assert.equal(items.length, 1, message);
  return items[0];
};
const text = (value) =>
  assert(
    typeof value === "string" && value.length > 0,
    "missing Rebuild identity",
  );

export function inspectRebuildPreparationBusiness(
  evidence,
  { requireTrace = true } = {},
) {
  const requestFields = ["label", "method", "path", "started_at", "at"];
  const requestKey = (row) =>
    requireTrace
      ? row.trace_id
      : JSON.stringify(requestFields.map((field) => row[field]));
  const sameRequest = (left, right) =>
    requireTrace
      ? left.trace_id === right?.trace_id
      : requestFields.every((field) => left[field] === right?.[field]);
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
    new Set(actual.map(requestKey)).size,
    actual.length,
    requireTrace
      ? "duplicate Rebuild HTTP trace"
      : "duplicate Rebuild HTTP response",
  );
  let previous = p.started_at;
  assert(Number.isFinite(previous) && login.at <= previous);
  for (const row of actual) {
    if (requireTrace) assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
    assert.deepEqual(
      one(
        evidence.http.filter((r) => sameRequest(r, row)),
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
        actual.filter((r) => sameRequest(r, row)),
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
    assert(
      Array.isArray(a.events.body.items) && a.events.body.items.length > 0,
    );
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
