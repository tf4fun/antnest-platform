import assert from "node:assert/strict";
import test from "node:test";
import { runtimePhysical, removeTestImages } from "./interruption-support.mjs";
import {
  assertCheckpoint,
  assertRecovery,
  assertKilled,
  assertFrozen,
  assertPublishedRuntime,
} from "./interruption-evidence.mjs";

function checkpoint() {
  return {
    ac: {
      request_id: "parent",
      updated_at: "2026-09-12T00:00:00Z",
      agent_id: "agent",
      state: "running",
      phase: "runtime_update",
      child_request_id: "child",
      runtime_result: null,
      target_spec_revision_id: "spec2",
      source_runtime_revision: "old",
    },
    rc: {
      request_id: "child",
      agent_id: "agent",
      state: "running",
      attempt: 1,
      runtime_revision: "new",
      source_revision: "old",
      target_generation: 2,
      target_spec_digest: "digest",
    },
    physical: {
      id: "new-container",
      agent_id: "agent",
      generation: 2,
      digest: "digest",
      volume: "workspace",
      healthy: false,
      running: true,
      entered: true,
    },
  };
}
const initial = { id: "old-container", volume: "workspace" };
test("published execution identity is checked against Runtime, not a redacted Console field", () => {
  const before = checkpoint();
  const binding = {
    runtime_revision: "new",
    executable_spec_revision_id: "spec2",
    runtime_execution_id: "execution",
  };
  const status = {
    agent_id: "agent",
    generation: 2,
    status: "ready",
    execution_id: "execution",
  };
  assertPublishedRuntime(before, binding, status);
  for (const patch of [
    { execution_id: "old" },
    { generation: 1 },
    { agent_id: "other" },
    { status: "starting" },
  ])
    assert.throws(() =>
      assertPublishedRuntime(before, binding, { ...status, ...patch }),
    );
  assert.throws(() =>
    assertPublishedRuntime(
      before,
      { ...binding, executable_spec_revision_id: "old" },
      status,
    ),
  );
});
test("image cleanup attempts remaining tags after one failure", async () => {
  const removed = [];
  const docker = async (args) => {
    if (args[1] === "ls")
      return args.at(-1).includes("first")
        ? "exists"
        : removed.includes("second")
          ? ""
          : "exists";
    removed.push(args.at(-1));
    if (args.at(-1) === "first") throw new Error("remove failed");
    return "";
  };
  await assert.rejects(
    removeTestImages(docker, ["first", "second"]),
    AggregateError,
  );
  assert.deepEqual(removed, ["first", "second"]);
});
test("checkpoint does not inspect the source while Update removes it", async () => {
  const calls = [];
  const docker = async (args) => {
    calls.push(args[0]);
    if (args[0] === "ps") return "old-container";
    if (args[0] === "volume") return "workspace";
    throw new Error("source inspection races deletion");
  };
  const result = await runtimePhysical(
    docker,
    { project: "scope" },
    "agent",
    "nonce",
    "old-container",
  );
  assert.deepEqual(result, { ids: ["old-container"], volumes: ["workspace"] });
  assert.deepEqual(calls, ["ps", "volume"]);
});
function recovered(before) {
  return {
    ac: {
      ...before.ac,
      state: "completed",
      phase: "completed",
      updated_at: "2026-09-12T00:01:00Z",
    },
    rc: { ...before.rc, state: "completed", attempt: 2 },
    physical: { ...before.physical, healthy: true },
    publications: 2,
    claims: 2,
    updated: 1,
  };
}
test("requires physical effect plus both nonterminal journals", () =>
  assertCheckpoint(checkpoint(), initial));
test("requires exact target recovery and one publication", () => {
  const before = checkpoint();
  assertRecovery(before, recovered(before));
});
test("kill checkpoint preserves the business phase and immutable request identities", () => {
  const before = checkpoint();
  const frozen = structuredClone(before);
  assertFrozen(before, frozen);
  for (const patch of [
    { child_request_id: "" },
    { phase: "publish" },
    { runtime_result: {} },
    { target_spec_revision_id: "other" },
  ]) {
    const after = structuredClone(frozen);
    Object.assign(after.ac, patch);
    assert.throws(() => assertFrozen(before, after));
  }
  frozen.rc.state = "completed";
  assert.throws(() => assertFrozen(before, frozen));
});
for (const [name, change] of [
  [
    "result already saved",
    (s) => {
      s.ac.runtime_result = {};
    },
  ],
  [
    "wrong phase",
    (s) => {
      s.ac.phase = "publish";
    },
  ],
  [
    "missing request",
    (s) => {
      s.ac.request_id = "";
    },
  ],
  [
    "missing Agent",
    (s) => {
      s.ac.agent_id = "";
    },
  ],
  [
    "unknown mutation",
    (s) => {
      s.rc.state = "unknown";
    },
  ],
  [
    "wrong child",
    (s) => {
      s.rc.request_id = "other";
    },
  ],
  [
    "foreign container",
    (s) => {
      s.physical.agent_id = "other";
    },
  ],
  [
    "new workspace",
    (s) => {
      s.physical.volume = "new";
    },
  ],
  [
    "old container",
    (s) => {
      s.physical.id = initial.id;
    },
  ],
  [
    "already ready",
    (s) => {
      s.physical.healthy = true;
    },
  ],
  [
    "no gate",
    (s) => {
      s.physical.entered = false;
    },
  ],
  [
    "wrong digest",
    (s) => {
      s.physical.digest = "other";
    },
  ],
  [
    "missing child identity",
    (s) => {
      s.ac.child_request_id = "";
    },
  ],
])
  test(`rejects checkpoint: ${name}`, () => {
    const s = checkpoint();
    change(s);
    assert.throws(() => assertCheckpoint(s, initial));
  });
for (const [name, change] of [
  [
    "new target",
    (s) => {
      s.rc.runtime_revision = "other";
    },
  ],
  [
    "new child",
    (s) => {
      s.rc.request_id = "other";
    },
  ],
  [
    "new generation",
    (s) => {
      s.rc.target_generation = 3;
    },
  ],
  [
    "new digest",
    (s) => {
      s.rc.target_spec_digest = "other";
    },
  ],
  [
    "new compute",
    (s) => {
      s.physical.id = "other";
    },
  ],
  [
    "no retry",
    (s) => {
      s.rc.attempt = 1;
    },
  ],
  [
    "extra publication",
    (s) => {
      s.publications = 3;
    },
  ],
  [
    "extra claim",
    (s) => {
      s.claims = 3;
    },
  ],
  [
    "extra update",
    (s) => {
      s.updated = 2;
    },
  ],
  [
    "wrong desired spec",
    (s) => {
      s.ac.target_spec_revision_id = "other";
    },
  ],
])
  test(`rejects recovery: ${name}`, () => {
    const before = checkpoint();
    const after = recovered(before);
    change(after);
    assert.throws(() => assertRecovery(before, after));
  });
test("requires actual killed Controller exit, not merely a kill command", () => {
  const stopped = {
    Id: "container",
    State: { Status: "exited", ExitCode: 137, OOMKilled: false, Error: "" },
  };
  assertKilled(stopped, "container");
  for (const patch of [
    { ExitCode: 0 },
    { OOMKilled: true },
    { Status: "running" },
    { Error: "bad" },
  ])
    assert.throws(() =>
      assertKilled(
        { ...stopped, State: { ...stopped.State, ...patch } },
        "container",
      ),
    );
  assert.throws(() => assertKilled(stopped, "different-container"));
});
