import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDrain,
  assertRebuildDenial,
  assertControllerStopped,
  heldProcessCommand,
} from "./drain-evidence.mjs";

function fixture() {
  const initial = {
    agent: {
      runtime: { runtime_revision: "r1" },
      executable_execution_revision: "e1",
      configuration: { template: { revision: 1 } },
    },
    container: { Id: "container" },
  };
  return {
    initial,
    requestID: "rebuild",
    operation: {
      kind: "rebuild",
      state: "running",
      phase: "drain",
      request_id: "rebuild",
    },
    agent: { ...initial.agent, active_operation_request_id: "rebuild" },
    containers: [{ Id: "container" }],
    effects: "held\n",
    attachment: "open",
    settled: false,
  };
}
test("drain preserves the active Run and old executable Runtime", () =>
  assertDrain(fixture()));
for (const [name, mutate] of [
  [
    "replacement too early",
    (f) => {
      f.containers[0].Id = "new";
    },
  ],
  [
    "ended tool",
    (f) => {
      f.effects = "held\nfinished\n";
    },
  ],
  [
    "prompt ended",
    (f) => {
      f.settled = true;
    },
  ],
  [
    "network closed",
    (f) => {
      f.attachment = "closed";
    },
  ],
  [
    "barrier disappeared",
    (f) => {
      f.agent.active_operation_request_id = "";
    },
  ],
  [
    "new binding too early",
    (f) => {
      f.agent.runtime = { runtime_revision: "r2" };
    },
  ],
])
  test(`rejects invalid drain: ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertDrain(f));
  });
test("blocked new Session prompt is a rebuilding denial, not a generic transport failure", () => {
  assertRebuildDenial({
    code: -32021,
    data: { code: "agent_rebuilding", retryable: true },
  });
  for (const error of [
    new Error("disconnected"),
    { code: -32021, data: { code: "agent_busy", retryable: true } },
    { code: -32021, data: { code: "agent_rebuilding", retryable: false } },
  ])
    assert.throws(() => assertRebuildDenial(error));
});

function stoppedFixture() {
  return {
    Id: "controller",
    Config: { Labels: { "com.docker.compose.project": "project" } },
    State: {
      Running: false,
      Status: "exited",
      ExitCode: 0,
      OOMKilled: false,
      Error: "",
      FinishedAt: "2026-09-10T02:00:10Z",
    },
  };
}
const before = {
  ...stoppedFixture(),
  State: { Running: true, StartedAt: "2026-09-10T02:00:00Z" },
};
test("Controller restart evidence requires observed clean shutdown", () => {
  assertControllerStopped(before, stoppedFixture(), "project");
});
for (const [name, mutate] of [
  [
    "forced kill",
    (s) => {
      s.State.ExitCode = 137;
    },
  ],
  [
    "still running",
    (s) => {
      s.State.Running = true;
    },
  ],
  [
    "OOM",
    (s) => {
      s.State.OOMKilled = true;
    },
  ],
  [
    "runtime error",
    (s) => {
      s.State.Error = "failure";
    },
  ],
  [
    "stale exit",
    (s) => {
      s.State.FinishedAt = before.State.StartedAt;
    },
  ],
  [
    "foreign container",
    (s) => {
      s.Id = "other";
    },
  ],
  [
    "foreign project",
    (s) => {
      s.Config.Labels["com.docker.compose.project"] = "other";
    },
  ],
])
  test(`rejects invalid shutdown: ${name}`, () => {
    const stopped = stoppedFixture();
    mutate(stopped);
    assert.throws(() => assertControllerStopped(before, stopped, "project"));
  });
test("held process checks cannot release a dead process or accept unsafe PIDs", () => {
  const check = heldProcessCommand("42");
  assert.equal(
    check,
    'test "$(cat /workspace/.c3-run-started)" = "42" && test ! -e /workspace/.c3-run-release && kill -0 42',
  );
  assert.equal(
    heldProcessCommand("42", true),
    `${check} && touch /workspace/.c3-run-release`,
  );
  for (const pid of ["0", "-1", "", "42;true", "01", "1.1"])
    assert.throws(() => heldProcessCommand(pid));
});
