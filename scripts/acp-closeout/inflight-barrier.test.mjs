import assert from "node:assert/strict";
import { test } from "node:test";
import {
  verifyInflightCheckpoint,
  verifyRetiredRuntime,
} from "./inflight-barrier.mjs";

const project = "antnest-stage3-e2e-12345";
const agentID = `agent_${"a".repeat(32)}`;
const container = "c".repeat(64);
const request = { kind: "tool-inflight", agent_id: agentID, version: 1 };
function fixture(overrides = {}) {
  const calls = [];
  const labels = {
    "io.antnest.managed": "runtime",
    "io.antnest.agent-id": agentID,
    "io.antnest.runtime-controller-scope": project,
  };
  const values = {
    containers: `${container}\n`,
    labels: JSON.stringify(labels),
    marker: "v1-tool-inflight\n",
    pid: "42\n",
    ...overrides,
  };
  return {
    calls,
    async invoke(args) {
      calls.push(args);
      if (args[0] === "ps") return values.containers;
      if (args[0] === "inspect") return values.labels;
      if (args.includes("cat"))
        return args.at(-1).endsWith(".pid") ? values.pid : values.marker;
      assert.deepEqual(args, [
        "exec",
        container,
        "sh",
        "-c",
        'test ! -e "$1" && kill -0 "$2"',
        "--",
        "/workspace/acp-unknown-v1.release",
        "42",
      ]);
      if (values.dead) throw new Error("process absent");
      return "";
    },
  };
}
test("fault barrier reads physical effect and a live PID only in the exact test Runtime", async () => {
  const mock = fixture();
  const evidence = await verifyInflightCheckpoint(
    request,
    project,
    mock.invoke,
  );
  assert.equal(evidence.container_id, container);
  assert.equal(evidence.tool_pid, 42);
  assert.equal(evidence.marker, "v1-tool-inflight\n");
  assert(
    mock.calls[0].includes(
      `label=io.antnest.runtime-controller-scope=${project}`,
    ),
  );
  assert(mock.calls[0].includes(`label=io.antnest.agent-id=${agentID}`));
});
test("retirement requires the exact original container ID to disappear", async () => {
  const proof = { ...request, container_id: container };
  await verifyRetiredRuntime(proof, async (args) => {
    assert.deepEqual(args, [
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      `id=${container}`,
    ]);
    return "";
  });
  await assert.rejects(verifyRetiredRuntime(proof, async () => container));
  await assert.rejects(
    verifyRetiredRuntime(
      { ...proof, container_id: "name-not-id" },
      async () => "",
    ),
  );
});
test("ambiguous, foreign, repeated and dead executions cannot authorize fault injection", async () => {
  for (const invalid of [
    { containers: "" },
    { containers: `${container}\n${"d".repeat(64)}` },
    { labels: "{}" },
    { marker: "v1-tool-inflight\nv1-tool-inflight\n" },
    { marker: "wrong phase" },
    { pid: "-1" },
    { pid: "42; echo bad" },
    { dead: true },
  ]) {
    const mock = fixture(invalid);
    await assert.rejects(
      verifyInflightCheckpoint(request, project, mock.invoke),
    );
  }
});
test("restart checkpoints reject arbitrary fields, invalid identities and retained projects", async () => {
  let calls = 0;
  const invoke = () => {
    calls++;
    throw new Error("unexpected Docker");
  };
  assert.deepEqual(
    await verifyInflightCheckpoint({ kind: "restart" }, project, invoke),
    { kind: "restart" },
  );
  for (const invalid of [
    { ...request, version: 3 },
    { ...request, agent_id: "other;docker" },
    { kind: "restart", path: "/etc/shadow" },
    { ...request, path: "/etc/shadow" },
  ])
    await assert.rejects(verifyInflightCheckpoint(invalid, project, invoke));
  await assert.rejects(
    verifyInflightCheckpoint(request, "retained-stack", invoke),
  );
  assert.equal(calls, 0);
});
