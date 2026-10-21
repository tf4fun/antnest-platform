import assert from "node:assert/strict";
import test from "node:test";
import { inspectRecoveryRebuild } from "./resolve-cache-rebuild.mjs";
import { rebuildTraceFixture } from "./resolve-cache-rebuild-trace-fixtures.mjs";

function fixture() {
  const { evidence } = rebuildTraceFixture();
  evidence.identity = { healthy: { running: true, health: "healthy" } };
  const strip = (value) => {
    if (!value || typeof value !== "object") return;
    delete value.trace_id;
    for (const child of Object.values(value)) strip(child);
  };
  strip(evidence);
  return evidence;
}

test("complete original Rebuild business inventory is accepted without collecting Trace", () => {
  const evidence = fixture();
  evidence.recovery_preparation.status = "failed";
  const before = structuredClone(evidence);
  assert.equal(inspectRecoveryRebuild(evidence), evidence.recovery_preparation);
  assert.deepEqual(evidence, before);
});

for (const [name, change] of [
  [
    "non-array audit events",
    (e, p) => {
      p.before.events.body.items = "not-event-rows";
      p.after.events.body.items = "not-event-rows";
    },
  ],
  [
    "foreign idempotency key",
    (e, p) => {
      p.request.idempotency_key = "another-key";
    },
  ],
  [
    "inactive administrator",
    (e) => {
      e.http.find((r) => r.label === "audit-login").body.principal.active =
        false;
    },
  ],
  [
    "member instead of administrator",
    (e) => {
      e.http.find(
        (r) => r.label === "audit-login",
      ).body.principal.organization_role = "member";
    },
  ],
  [
    "foreign administrator organization",
    (e) => {
      e.http.find(
        (r) => r.label === "audit-login",
      ).body.principal.organization_id = "foreign";
    },
  ],
  [
    "foreign Rebuild credential",
    (e, p) => {
      p.command.credential_scope = "foreign";
    },
  ],
  [
    "renewed credential",
    (e, p) => {
      p.receipt.set_cookie_count = 1;
    },
  ],
  [
    "cacheable Rebuild response",
    (e, p) => {
      p.receipt.cache_control = "public";
    },
  ],
  [
    "foreign template",
    (e, p) => {
      p.ready.body.configuration.template.template_id = "foreign";
    },
  ],
  [
    "foreign template revision",
    (e, p) => {
      p.ready.body.configuration.template.revision++;
    },
  ],
  [
    "extra actual Rebuild command",
    (e, p) => {
      e.http.push({
        ...p.command,
        label: "recovery-rebuild-extra-command",
        started_at: p.at + 1,
        at: p.at + 2,
      });
    },
  ],
  [
    "before observations reused as after",
    (e, p) => {
      p.after = p.before;
    },
  ],
  [
    "missing actual Runtime observation",
    (e, p) => {
      p.runtime.observations = [];
    },
  ],
  [
    "foreign physical observation",
    (e, p) => {
      p.runtime.observation.container = {
        ...p.runtime.container,
        id: "foreign",
      };
    },
  ],
  [
    "skipped Runtime generation",
    (e, p) => {
      p.runtime.container.generation += 1;
      p.runtime.observation.status.generation += 1;
    },
  ],
  [
    "incomplete operation phase",
    (e, p) => {
      p.operation.body.phase = "publish";
    },
  ],
  [
    "unexpected command refusal",
    (e, p) => {
      p.command.body.code = "unknown_refusal";
    },
  ],
  [
    "failed receipt detail",
    (e, p) => {
      p.receipt.body.error_detail = "failed";
    },
  ],
]) {
  test(`Rebuild business gate retains ${name} rejection without Trace`, () => {
    const evidence = fixture();
    inspectRecoveryRebuild(evidence);
    change(evidence, evidence.recovery_preparation);
    assert.throws(() => inspectRecoveryRebuild(evidence));
  });
}
