import assert from "node:assert/strict";
import test from "node:test";
import {
  compareEnvironment,
  retainedState,
  snapshotEnvironment,
} from "./environment.mjs";

const row = {
  Id: "old",
  Name: "retained",
  Image: "sha256:old",
  RestartCount: 0,
  Mounts: [
    { Destination: "/b", Source: "two" },
    { Destination: "/a", Source: "one" },
  ],
  State: { Running: false, StartedAt: "previous" },
  NetworkSettings: { Networks: { net: {} } },
};
test("environment comparison preserves stopped baseline and normalizes mount order", () => {
  const state = retainedState(row);
  const before = {
    resources: { containers: ["old"], volumes: ["one"], networks: ["net"] },
    retained: [state],
    images: { local: "sha256:old" },
  };
  const after = structuredClone(before);
  after.retained = [
    retainedState({ ...row, Mounts: [...row.Mounts].reverse() }),
  ];
  assert.equal(compareEnvironment(before, after).unchanged, true);
  after.retained[0].Running = true;
  assert.equal(compareEnvironment(before, after).unchanged, false);
});
test("environment comparison detects leaks, deletion and image replacement", () => {
  const before = {
    resources: { containers: ["old"], volumes: [], networks: [] },
    retained: [retainedState(row)],
    images: { local: "sha256:old" },
  };
  const after = {
    resources: { containers: ["leak"], volumes: [], networks: [] },
    retained: [],
    images: { local: "sha256:new" },
  };
  const diff = compareEnvironment(before, after);
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.resources.containers, {
    added: ["leak"],
    removed: ["old"],
  });
  assert.deepEqual(diff.image_changes, ["local"]);
  assert.equal(diff.retained_changes.length, 1);
});
test("a snapshot cannot pin a missing image as a null baseline", async () => {
  const docker = async (args) => {
    if (args[0] === "image") throw new Error("missing image");
    return "";
  };
  await assert.rejects(
    snapshotEnvironment({ images: ["missing:local"], docker }),
  );
});
