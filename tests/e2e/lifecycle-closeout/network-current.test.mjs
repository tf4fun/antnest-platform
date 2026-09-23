import assert from "node:assert/strict";
import test from "node:test";
import { assertNetworkRun, inspectNetworkTarget } from "./network-current.mjs";

const agent = {
  agent_id: "agent-a",
  executable_execution_revision: "execution-a",
};
const run = {
  run_id: "run-a",
  agent_id: "agent-a",
  session_id: "session-a",
  state: "completed",
  terminal_class: "completed",
  executor_state: "quiescent",
  tool_effect_state: "settled",
  execution_snapshot: { executionRevision: "execution-a" },
};
test("network Run uses one completed public audit for the exact Agent, Session and execution", () => {
  assert.equal(assertNetworkRun([run], agent, "session-a").run_id, "run-a");
  for (const changed of [
    [],
    [run, run],
    [{ ...run, session_id: "foreign" }],
    [{ ...run, agent_id: "foreign" }],
    [{ ...run, state: "running" }],
    [{ ...run, executor_state: "running" }],
    [{ ...run, tool_effect_state: "unknown" }],
    [{ ...run, execution_snapshot: { executionRevision: "old" } }],
  ])
    assert.throws(() => assertNetworkRun(changed, agent, "session-a"));
});
const config = { project: "antnest-lifecycle-01234567" };
function target() {
  return {
    Config: {
      Labels: {
        "com.docker.compose.project": config.project,
        "com.docker.compose.service": "network-target",
      },
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: {} },
    NetworkSettings: {
      Networks: { [config.project + "_egress"]: { IPAddress: "172.20.0.2" } },
      Ports: { "8080/tcp": null },
    },
  };
}
test("network target is a healthy unexposed fixture on only its own Egress network", () => {
  inspectNetworkTarget([target()], config);
  for (const mutate of [
    (rows) => rows.splice(0),
    (rows) => rows.push(target()),
    (rows) => (rows[0].State.Running = false),
    (rows) => (rows[0].State.Health.Status = "unhealthy"),
    (rows) => (rows[0].Config.Labels["com.docker.compose.project"] = "foreign"),
    (rows) =>
      (rows[0].HostConfig.PortBindings = {
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "1234" }],
      }),
    (rows) => (rows[0].NetworkSettings.Networks.management = {}),
    (rows) =>
      (rows[0].NetworkSettings.Ports["8080/tcp"] = [
        { HostIp: "0.0.0.0", HostPort: "8080" },
      ]),
  ]) {
    const rows = [target()];
    mutate(rows);
    assert.throws(() => inspectNetworkTarget(rows, config));
  }
});
