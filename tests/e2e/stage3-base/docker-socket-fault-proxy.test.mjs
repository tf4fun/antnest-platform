import assert from "node:assert/strict";
import test from "node:test";
import {
  creationTarget,
  initializationTarget,
  startTarget,
} from "./docker-socket-fault-proxy.mjs";

const agent_id = `agent_${"a".repeat(32)}`;
const expected = { agent_id, skill_set_digest: `sha256:${"b".repeat(64)}` };
const volume = `antnest-skills-${"c".repeat(32)}-m1`;
const path = `/v1.47/containers/create?name=antnest-runtime-${agent_id}`;
const body = (mounts) => JSON.stringify({ HostConfig: { Mounts: mounts } });
const skill = {
  Type: "volume",
  Source: volume,
  Target: "/skills",
  ReadOnly: true,
  VolumeOptions: { NoCopy: true },
};

test("Docker race proxy selects only the expected read-only Skill target", () => {
  assert.deepEqual(creationTarget(path, body([skill]), expected), {
    version: "v1.47",
    volume,
  });
  assert.equal(
    creationTarget(
      path.replace(agent_id, `agent_${"d".repeat(32)}`),
      body([skill]),
      expected,
    ),
    null,
  );
  assert.equal(
    creationTarget(
      path.replace("/containers/create", "/containers/start"),
      body([skill]),
      expected,
    ),
    null,
  );
  assert.equal(
    creationTarget(path, body([{ ...skill, Target: "/workspace" }]), expected),
    null,
  );
  assert.equal(
    creationTarget(path, body([{ ...skill, ReadOnly: false }]), expected),
    null,
  );
  assert.equal(
    creationTarget(path, body([{ ...skill, VolumeOptions: {} }]), expected),
    null,
  );
});

test("initialization race selects the first exact Skill Runtime without a known Agent ID", () => {
  assert.deepEqual(initializationTarget(path, body([skill])), {
    version: "v1.47",
    volume,
    agent_id,
  });
  assert.equal(
    initializationTarget(path.replace(agent_id, "agent-other"), body([skill])),
    null,
  );
  assert.equal(
    initializationTarget(path, body([{ ...skill, ReadOnly: false }])),
    null,
  );
});

test("Docker start response loss selects only the prepared target candidate", () => {
  const id = "d".repeat(64);
  const path = `/v1.47/containers/${id}/start`;
  const inspected = {
    Id: id,
    State: { Status: "created", Running: false },
    Config: {
      Labels: {
        "io.antnest.managed": "runtime",
        "io.antnest.runtime-controller-scope": "test-controller",
        "io.antnest.agent-id": agent_id,
      },
    },
    Mounts: [
      { Type: "volume", Name: volume, Destination: "/skills", RW: false },
    ],
  };
  const target = { ...expected, scope: "test-controller", volume };
  assert.deepEqual(startTarget(path, inspected, target), {
    version: "v1.47",
    id,
    volume,
  });
  assert.equal(
    startTarget(
      path,
      { ...inspected, State: { Status: "running", Running: true } },
      target,
    ),
    null,
  );
  assert.equal(
    startTarget(
      path,
      {
        ...inspected,
        Config: {
          Labels: {
            ...inspected.Config.Labels,
            "io.antnest.agent-id": `agent_${"e".repeat(32)}`,
          },
        },
      },
      target,
    ),
    null,
  );
  assert.equal(
    startTarget(
      path,
      { ...inspected, Mounts: [{ ...inspected.Mounts[0], RW: true }] },
      target,
    ),
    null,
  );
});
