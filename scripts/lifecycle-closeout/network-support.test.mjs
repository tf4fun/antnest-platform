import assert from "node:assert/strict";
import test from "node:test";
import {
  guardRules,
  redirectRules,
  flowTuples,
  physicalIdentity,
  assertProducerStopped,
  assertRuntimeExited,
} from "./network-support.mjs";

test("Runtime deletion must preserve a single clean exit before physical removal", () => {
  const events = ["kill", "die", "stop", "destroy"].map((Action) => ({
    Type: "container",
    Action,
    Actor: {
      ID: "runtime-id",
      Attributes: {
        "io.antnest.runtime-controller-scope": "fixture",
        exitCode: "0",
        signal: "15",
      },
    },
  }));
  assertRuntimeExited(events, "runtime-id", "fixture");
  for (const mutate of [
    (e) => e.splice(1, 1),
    (e) => e.push(e[1]),
    (e) => (e[1].Actor.Attributes.exitCode = "137"),
    (e) => (e[0].Actor.Attributes.signal = "9"),
    (e) => (e[1].Actor.ID = "other"),
    (e) =>
      (e[1].Actor.Attributes["io.antnest.runtime-controller-scope"] = "other"),
  ]) {
    const changed = structuredClone(events);
    mutate(changed);
    assert.throws(() => assertRuntimeExited(changed, "runtime-id", "fixture"));
  }
});

test("trace producer barrier requires own container and a clean completed exit", () => {
  const container = {
    Config: { Labels: { "com.docker.compose.project": "fixture" } },
    State: { Running: false, OOMKilled: false, ExitCode: 0 },
  };
  assertProducerStopped(container, "fixture");
  for (const State of [
    { ...container.State, Running: true },
    { ...container.State, OOMKilled: true },
    { ...container.State, ExitCode: 137 },
  ])
    assert.throws(() =>
      assertProducerStopped({ ...container, State }, "fixture"),
    );
  assert.throws(() => assertProducerStopped(container, "other"));
});

test("test firewall is fail-closed independently of destination translation", () => {
  const guard = guardRules("172.25.0.3");
  assert(
    guard.includes(
      'iifname "antnest-egress0" ip saddr 100.64.0.0/10 ip daddr != 172.25.0.3 drop',
    ),
  );
  assert(guard.includes("tcp dport != 8080 drop"));
  assert(guard.includes("meta l4proto != tcp drop"));
  assert(!guard.includes("dnat") && !guard.includes("flush ruleset"));
  const nat = redirectRules("172.25.0.3");
  assert(
    nat.includes("ip daddr 1.1.1.1 tcp dport 18080 dnat to 172.25.0.3:8080"),
  );
  for (const ip of ["1.2.3.4", "172.999.0.1", "172.25.0.3; flush ruleset"])
    assert.throws(() => guardRules(ip));
});

test("conntrack evidence matches original tuple, not reply addresses or volatile timeout", () => {
  const entry =
    "tcp 6 432 ESTABLISHED src=100.64.0.2 dst=1.1.1.1 sport=45678 dport=18080 src=172.25.0.3 dst=172.25.0.2 sport=8080 dport=45678 [ASSURED] mark=0 use=1";
  const expected = [
    {
      source: "100.64.0.2",
      port: 45678,
      destination: "1.1.1.1",
      targetPort: 18080,
      state: "ESTABLISHED",
    },
  ];
  assert.deepEqual(flowTuples(entry, "100.64.0.2"), expected);
  assert.deepEqual(
    flowTuples(entry.replace("432", "123"), "100.64.0.2"),
    expected,
  );
  assert.deepEqual(flowTuples(entry, "172.25.0.3"), []);
  assert.deepEqual(
    flowTuples(entry.replace("dport=18080", "dport=53"), "100.64.0.2"),
    [],
  );
});

test("runtime identity retains process, mount, configuration and binding evidence", () => {
  const runtime = {
    container: {
      Id: "id",
      Image: "image",
      RestartCount: 0,
      Config: { Labels: {}, Env: ["config=1"] },
      State: { StartedAt: "now" },
      Mounts: [],
    },
    volume: "volume",
    agent: {
      configuration: { value: 1 },
      runtime: { runtime_revision: "rev" },
      executable_execution_revision: 3,
    },
  };
  const before = physicalIdentity(runtime);
  for (const mutate of [
    (r) => r.container.RestartCount++,
    (r) => (r.container.State.StartedAt = "later"),
    (r) => r.agent.executable_execution_revision++,
    (r) => r.container.Config.Env.push("config=2"),
  ]) {
    const other = structuredClone(runtime);
    mutate(other);
    assert.notDeepEqual(physicalIdentity(other), before);
  }
});
