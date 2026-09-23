import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimePhysical,
  serviceContainer,
  journalReader,
  until,
} from "./recovery-support.mjs";
import { scopeLabel } from "./docker.mjs";

const config = { project: "antnest-lifecycle-1234abcd", image: "sha256:image" };
function runtime() {
  return {
    Id: "container",
    Image: config.image,
    Config: {
      Labels: {
        "io.antnest.agent-id": "agent",
        "io.antnest.runtime-generation": "2",
        "io.antnest.runtime-spec-digest": "digest",
      },
    },
    Mounts: [
      { Destination: "/workspace", Name: "antnest-workspace-agent", RW: true },
    ],
    State: { Running: true, StartedAt: "start", Health: { Status: "healthy" } },
    RestartCount: 0,
  };
}
function physicalDocker(
  container = runtime(),
  ids = "container",
  volume = "antnest-workspace-agent",
) {
  return async (args) => {
    if (args[0] === "inspect") return JSON.stringify([container]);
    assert.deepEqual(args.slice(-4), [
      "--filter",
      `label=${scopeLabel}=antnest-lifecycle-1234abcd`,
      "--filter",
      "label=io.antnest.agent-id=agent",
    ]);
    if (args[0] === "ps") return ids;
    if (args[0] === "volume") return volume;
    assert.fail("Current recovery must not execute a historical startup gate");
  };
}
test("current physical evidence uses scoped inspection without entering the Runtime", async () => {
  assert.deepEqual(await runtimePhysical(physicalDocker(), config, "agent"), {
    id: "container",
    agent_id: "agent",
    generation: 2,
    digest: "digest",
    volume: "antnest-workspace-agent",
    started_at: "start",
    restarts: 0,
    running: true,
    healthy: true,
  });
});
test("absent Runtime preserves the scoped inventory", async () => {
  assert.deepEqual(
    await runtimePhysical(physicalDocker(runtime(), ""), config, "agent"),
    {
      ids: [],
      volumes: ["antnest-workspace-agent"],
    },
  );
});
for (const [name, change] of [
  [
    "image",
    (c) => {
      c.Image = "other";
    },
  ],
  [
    "workspace",
    (c) => {
      c.Mounts[0].Name = "foreign";
    },
  ],
  [
    "read-only workspace",
    (c) => {
      c.Mounts[0].RW = false;
    },
  ],
])
  test(`rejects mismatched ${name}`, async () => {
    const c = runtime();
    change(c);
    await assert.rejects(runtimePhysical(physicalDocker(c), config, "agent"));
  });
test("rejects ambiguous owned Runtime inventory", async () => {
  await assert.rejects(
    runtimePhysical(physicalDocker(runtime(), "one\ntwo"), config, "agent"),
  );
});
test("service inspection requires exactly one Compose-owned container", async () => {
  const calls = [];
  const c = await serviceContainer(
    async (args) => {
      calls.push(args);
      return args[0] === "inspect" ? '[{"Id":"service"}]' : "service";
    },
    "antnest-lifecycle-1234abcd",
    "postgres",
  );
  assert.equal(c.Id, "service");
  assert(calls[0].includes("antnest-lifecycle-1234abcd"));
  assert.deepEqual(calls[0].slice(-3), ["ps", "-aq", "postgres"]);
  for (const ids of ["", "one\ntwo"])
    await assert.rejects(
      serviceContainer(
        async () => ids,
        "antnest-lifecycle-1234abcd",
        "postgres",
      ),
    );
});
const journalCases = [
  ["binding", ["agent"], "agent_controller", "agents"],
  ["runtimeCursor", [], "agent_controller", "runtime_observation_cursor"],
  ["lossBinding", ["agent"], "agent_controller", "agents"],
  ["lossObservation", [1], "runtime_controller", "observations"],
  ["lossEvent", ["event"], "agent_controller", "agent_events"],
  ["ac", ["request"], "agent_controller", "agent_lifecycle_operations"],
  ["rc", ["request"], "runtime_controller", "operations"],
  ["publications", ["agent"], "agent_controller", "execution_revisions"],
  ["claims", ["agent"], "runtime_controller", "generation_claims"],
  ["updated", ["agent", "revision"], "runtime_controller", "observations"],
];
for (const [name, args, service, table] of journalCases)
  test(`${name} reads evidence through its owning database role`, async () => {
    const reader = journalReader(async (command) => {
      assert.deepEqual(command.slice(0, 3), ["exec", "postgres", "psql"]);
      assert.equal(command[command.indexOf("-U") + 1], `antnest_${service}`);
      assert.equal(command[command.indexOf("-d") + 1], `antnest_${service}`);
      assert(command.at(-1).startsWith("SELECT row_to_json(e) FROM (SELECT "));
      assert(command.at(-1).includes(`FROM ${service}.${table}`));
      return '{"evidence":true}';
    }, "postgres");
    assert.deepEqual(await reader[name](...args), { evidence: true });
  });
test("journal rejects unsafe identifiers and observation sequences before Docker", async () => {
  const reader = journalReader(
    () => assert.fail("must reject before executing SQL"),
    "postgres",
  );
  for (const [name, args] of journalCases.filter(
    ([name]) => name !== "runtimeCursor",
  )) {
    for (const bad of ["'; DROP TABLE agents; --", "", "a b"])
      assert.throws(() => reader[name](bad, ...args.slice(1)));
  }
  assert.throws(() => reader.updated("agent", "bad'revision"));
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => reader.lossObservation(sequence));
});
test("empty journal result is null", async () => {
  assert.equal(
    await journalReader(async () => "", "postgres").binding("agent"),
    null,
  );
});
test("polling returns matching evidence and preserves abort and deadline failures", async () => {
  const controller = new AbortController();
  assert.equal(
    await until(
      async () => 42,
      (value) => value === 42,
      controller.signal,
    ),
    42,
  );
  await assert.rejects(
    until(
      () => assert.fail("deadline expired"),
      () => false,
      controller.signal,
      0,
    ),
    /deadline exceeded/,
  );
  controller.abort(new Error("stopped"));
  await assert.rejects(
    until(
      () => assert.fail("already aborted"),
      () => false,
      controller.signal,
    ),
    /stopped/,
  );
});
