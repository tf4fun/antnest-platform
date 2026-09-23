import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUpdateReceiptCheckpoint,
  assertUpdateReceiptRecovery,
} from "./interrupted-current.mjs";

function fixture() {
  const ac = {
    request_id: "parent",
    agent_id: "agent",
    state: "running",
    phase: "runtime_update",
    child_request_id: "child",
    runtime_result: null,
    source_runtime_revision: "old",
    target_spec_revision_id: "spec2",
    updated_at: "before",
  };
  const rc = {
    request_id: "child",
    agent_id: "agent",
    state: "completed",
    effect: "completed",
    runtime_revision: "new",
    source_revision: "old",
    target_generation: 2,
    target_spec_digest: "digest",
    attempt: 1,
  };
  const physical = {
    id: "target",
    agent_id: "agent",
    generation: 2,
    digest: "digest",
    volume: "workspace",
    running: true,
    started_at: "start",
    restarts: 0,
  };
  const receipt = {
    request_id: "child",
    agent_id: "agent",
    target_revision: "new",
    delivery: "held",
    status: 200,
  };
  return { ac, rc, physical, receipt, publications: 1, claims: 2, updated: 1 };
}
test("receipt checkpoint proves committed child while caller has not recorded it", () => {
  const f = fixture();
  assertUpdateReceiptCheckpoint(f, { id: "source", volume: "workspace" });
  for (const change of [
    (x) => (x.rc.state = "running"),
    (x) => (x.receipt.delivery = "expired"),
    (x) => (x.ac.runtime_result = {}),
    (x) => (x.physical.generation = 1),
    (x) => (x.receipt.request_id = "foreign"),
    (x) => (x.rc.effect = "unknown"),
  ]) {
    const x = structuredClone(f);
    change(x);
    assert.throws(() =>
      assertUpdateReceiptCheckpoint(x, { id: "source", volume: "workspace" }),
    );
  }
});
test("terminal child replay must not retry mutation, replace compute or duplicate publication", () => {
  const before = fixture();
  const after = structuredClone(before);
  Object.assign(after.ac, {
    state: "completed",
    phase: "completed",
    updated_at: "after",
    child_request_id: "",
    runtime_result: {},
  });
  after.publications = 2;
  assertUpdateReceiptRecovery(before, after);
  for (const change of [
    (x) => x.rc.attempt++,
    (x) => (x.physical.id = "replacement"),
    (x) => (x.physical.started_at = "restart"),
    (x) => x.claims++,
    (x) => x.updated++,
    (x) => x.publications++,
    (x) => (x.ac.target_spec_revision_id = "foreign"),
  ]) {
    const x = structuredClone(after);
    change(x);
    assert.throws(() => assertUpdateReceiptRecovery(before, x));
  }
});

test("recovered configuration uses the explicitly selected new Template revision", async () => {
  const { assertUpdateTemplate } = await import("./interrupted-current.mjs");
  const initial = {
    configuration: {
      template: { template_id: "template", revision: 1 },
      max_model_requests: 8,
      runtime: { image_ref: "image" },
    },
  };
  const final = {
    configuration: {
      template: { template_id: "template", revision: 2 },
      max_model_requests: 9,
      runtime: { image_ref: "image" },
    },
  };
  assertUpdateTemplate(initial, final, {
    template_id: "template",
    revision: 2,
    max_model_requests: 9,
  });
  for (const change of [
    (x) => (x.configuration.template.revision = 1),
    (x) => (x.configuration.max_model_requests = 8),
    (x) => (x.configuration.runtime.image_ref = "other"),
  ]) {
    const x = structuredClone(final);
    change(x);
    assert.throws(() =>
      assertUpdateTemplate(initial, x, {
        template_id: "template",
        revision: 2,
        max_model_requests: 9,
      }),
    );
  }
});
