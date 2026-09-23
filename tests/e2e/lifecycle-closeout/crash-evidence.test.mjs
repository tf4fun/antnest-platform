import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCrashCheckpoint,
  assertCrashRecovery,
} from "./crash-evidence.mjs";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";
function fixture(phase) {
  const child = runtimeCommandId("parent", "runtime_update");
  const ac = {
    request_id: "parent",
    agent_id: "agent",
    state: "running",
    phase: "runtime_update",
    child_request_id: child,
    runtime_result: null,
    source_runtime_revision: "source",
    target_spec_revision_id: "spec",
  };
  const rc = {
    request_id: child,
    agent_id: "agent",
    state: "running",
    effect: "pending",
    kind: "update_runtime",
    source_revision: "source",
    source_generation: 1,
    source_spec_digest: "old",
    runtime_revision: "target",
    target_generation: 2,
    target_spec_digest: "new",
    request_digest: "digest",
    attempt: 1,
  };
  const physical = {
    id: "target-container",
    agent_id: "agent",
    generation: 2,
    digest: "new",
    volume: "workspace",
    running: true,
    started_at: "now",
    restarts: 0,
  };
  const before = {
    ac,
    rc,
    physical:
      phase === "before-create"
        ? { ids: [], volumes: ["workspace"] }
        : physical,
    claims: 2,
    updated: 0,
    publications: 1,
    gate: {
      phase,
      delivery: "held",
      target_id: phase === "after-start" ? physical.id : null,
    },
  };
  const after = {
    ac: { ...ac, state: "completed", phase: "completed" },
    rc: { ...rc, state: "completed", effect: "completed", attempt: 2 },
    physical,
    claims: 2,
    updated: 1,
    publications: 2,
  };
  return {
    before,
    after,
    initial: { id: "source-container", volume: "workspace" },
  };
}
for (const phase of ["before-create", "after-start"]) {
  test(`${phase}: requires actual uncommitted checkpoint and immutable retry identity`, () => {
    const f = fixture(phase);
    assertCrashCheckpoint(f.before, f.initial, phase);
    assertCrashRecovery(f.before, f.after);
    for (const key of [
      "request_id",
      "request_digest",
      "runtime_revision",
      "target_generation",
      "target_spec_digest",
      "source_revision",
      "source_generation",
      "source_spec_digest",
    ]) {
      const after = structuredClone(f.after);
      after.rc[key] = "different";
      assert.throws(() => assertCrashRecovery(f.before, after));
    }
    for (const [key, value] of [
      ["claims", 3],
      ["publications", 3],
      ["updated", 2],
    ]) {
      assert.throws(() =>
        assertCrashRecovery(f.before, { ...f.after, [key]: value }),
      );
    }
    const committed = structuredClone(f.before);
    committed.rc.state = "completed";
    assert.throws(() => assertCrashCheckpoint(committed, f.initial, phase));
    const expired = structuredClone(f.before);
    expired.gate.delivery = "expired";
    assert.throws(() => assertCrashCheckpoint(expired, f.initial, phase));
    if (phase === "after-start") {
      const replaced = structuredClone(f.after);
      replaced.physical.id = "replacement";
      assert.throws(() => assertCrashRecovery(f.before, replaced));
    }
  });
}
