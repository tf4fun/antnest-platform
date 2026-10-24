import assert from "node:assert/strict";
import { test } from "node:test";
import { partitionSurvivorDeployment } from "./deployment.mjs";

const project = "antnest-lifecycle-01234567";
const initializerNames = [
  "temporal-databases",
  "temporal-schema",
  "temporal-namespace",
  "skill-registry-database-init",
];
function row(name, initializer = false) {
  return {
    Id: name,
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": name,
      },
    },
    State: {
      Status: initializer ? "exited" : "running",
      Running: !initializer,
      ExitCode: 0,
      OOMKilled: false,
      Error: "",
    },
    HostConfig: { PortBindings: {} },
  };
}
function inventory() {
  return [
    row("agent-acp-service"),
    row("agent-acp-peer-b"),
    row("postgres"),
    ...initializerNames.map((name) => row(name, true)),
  ];
}

test("successful one-shot initializers are proved separately from resident services", () => {
  const rows = inventory();
  const result = partitionSurvivorDeployment(rows, project);
  assert.deepEqual(
    result.initializers.map((item) => item.Id),
    initializerNames,
  );
  assert.deepEqual(
    result.baseRows.map((item) => item.Id),
    ["agent-acp-service", "postgres"],
  );
  assert.equal(result.peer, rows[1]);
  assert.equal(result.baseRows[0], rows[0]);
  assert.equal(rows.length, 7);
});

test("unknown or stopped resident services remain subject to the original deployment checks", () => {
  const rows = inventory();
  rows.push(row("unexpected-service", true));
  rows[0].State = { ...rows[0].State, Running: false, ExitCode: 1 };
  const result = partitionSurvivorDeployment(rows, project);
  assert(result.baseRows.includes(rows[0]));
  assert(result.baseRows.includes(rows.at(-1)));
});

for (const [description, state] of [
  ["nonzero exit", { ExitCode: 1 }],
  ["still running", { Running: true }],
  ["never completed", { Status: "created" }],
  ["OOM", { OOMKilled: true }],
  ["engine error", { Error: "initialization failed" }],
]) {
  test(`rejects initializer with ${description}`, () => {
    const rows = inventory();
    Object.assign(rows[3].State, state);
    assert.throws(() => partitionSurvivorDeployment(rows, project));
  });
}

test("rejects missing, duplicate, foreign-project and publicly exposed initializers", () => {
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => rows.push(row(initializerNames[0], true)),
    (rows) => {
      rows[3].Config.Labels["com.docker.compose.project"] = "unrelated-project";
    },
    (rows) => {
      rows[3].HostConfig.PortBindings = {
        "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }],
      };
    },
  ]) {
    const rows = inventory();
    mutate(rows);
    assert.throws(() => partitionSurvivorDeployment(rows, project));
  }
});

test("requires exactly one peer replica", () => {
  assert.throws(() =>
    partitionSurvivorDeployment(
      inventory().filter((item) => item.Id !== "agent-acp-peer-b"),
      project,
    ),
  );
  assert.throws(() =>
    partitionSurvivorDeployment(
      [...inventory(), row("agent-acp-peer-b")],
      project,
    ),
  );
});
