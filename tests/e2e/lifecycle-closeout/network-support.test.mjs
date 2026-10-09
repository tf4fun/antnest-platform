import assert from "node:assert/strict";
import test from "node:test";
import {
  guardRules,
  fixtureRoute,
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

test("test firewall and scoped route preserve the public destination for the kernel backstop", () => {
  const guard = guardRules("172.25.0.3");
  assert(
    guard.includes(
      'iifname "antnest-egress0" ip saddr 100.64.0.0/10 ip daddr != 1.1.1.1 drop',
    ),
  );
  assert(guard.includes("tcp dport != 18080 drop"));
  assert(guard.includes("meta l4proto != tcp drop"));
  assert(!guard.includes("dnat") && !guard.includes("flush ruleset"));
  assert.deepEqual(fixtureRoute("172.25.0.3"), [
    "route",
    "replace",
    "1.1.1.1/32",
    "via",
    "172.25.0.3",
  ]);
  for (const ip of ["1.2.3.4", "172.999.0.1", "172.25.0.3; flush ruleset"])
    for (const rules of [guardRules, fixtureRoute])
      assert.throws(() => rules(ip));
});

test("conntrack evidence matches original tuple, not reply addresses or volatile timeout", () => {
  const entry =
    "tcp 6 432 ESTABLISHED src=100.64.0.2 dst=1.1.1.1 sport=45678 dport=18080 src=1.1.1.1 dst=172.25.0.2 sport=18080 dport=45678 [ASSURED] mark=0 use=1";
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

test("Docker mount enumeration order does not change physical identity; mount attributes do", () => {
  const state = {
    container: {
      Id: "same",
      Image: "image",
      State: { StartedAt: "start" },
      RestartCount: 0,
      Config: {},
      Mounts: [
        {
          Destination: "/workspace",
          Name: "workspace",
          Source: "/vol/workspace",
          RW: true,
        },
        {
          Destination: "/skills",
          Name: "skills",
          Source: "/vol/skills",
          RW: false,
        },
      ],
    },
    volume: "workspace",
    agent: {
      configuration: {},
      runtime: { runtime_revision: "runtime" },
      executable_execution_revision: "execution",
    },
  };
  const before = structuredClone(state);
  const reordered = structuredClone(state);
  reordered.container.Mounts.reverse();
  assert.deepEqual(physicalIdentity(state), physicalIdentity(reordered));
  assert.deepEqual(
    state,
    before,
    "inspection must not mutate raw Docker evidence",
  );
  for (const [field, value] of [
    ["Name", "other"],
    ["Source", "/other"],
    ["RW", false],
    ["Destination", "/other"],
  ]) {
    const changed = structuredClone(state);
    changed.container.Mounts[0][field] = value;
    assert.notDeepEqual(physicalIdentity(state), physicalIdentity(changed));
  }
});
