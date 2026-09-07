import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./model.mjs";

function payload(phase, results = []) {
  return {
    messages: [
      { role: "tool", content: "old-session-result" },
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
    tools: ["bash", "read"].map((name) => ({ function: { name } })),
  };
}

for (const version of [1, 2]) {
  test(`v${version}: baseline appends once; earlier Run results do not skip tools`, () => {
    const phase = `v${version}-baseline`;
    const first = decide(payload(phase));
    assert.equal(first.call.name, "bash");
    assert.deepEqual(first.call.arguments.working_dir, {
      root: "workspace",
      path: ".",
    });
    assert.equal(first.call.arguments.timeout_ms, 10000);
    assert(
      first.call.arguments.command.includes(">> /workspace/acp-effects.log"),
    );
    assert.equal(decide(payload(phase, [phase])).text, `${phase} verified`);
  });
  test(`v${version}: barriers distinguish model-only from settled Tool interruption`, () => {
    assert.equal(decide(payload(`v${version}-model-blocked`)).hold, true);
    const phase = `v${version}-tool-blocked`;
    assert.equal(decide(payload(phase)).call.name, "bash");
    assert.equal(decide(payload(phase, [phase])).hold, true);
  });
  test(`v${version}: invalid and replayed effects fail the fixture`, () => {
    assert.throws(() =>
      decide(payload(`v${version}-baseline`, ["wrong output"])),
    );
    assert.throws(() =>
      decide(payload(`v${version}-baseline`, ["one", "two"])),
    );
    assert.throws(() => decide(payload(`v${version}-unknown`)));
  });
  test(`v${version}: effect read is bounded and requires real file content`, () => {
    const phase = `v${version}-read-effects`;
    assert.deepEqual(decide(payload(phase)).call, {
      name: "read",
      arguments: {
        path: { root: "workspace", path: "acp-effects.log" },
        offset: 0,
        limit: 4096,
      },
    });
    assert.throws(() => decide(payload(phase, ["tool arguments rejected"])));
    assert.equal(
      decide(
        payload(phase, [`v${version}-baseline\nv${version}-tool-blocked\n`]),
      ).text,
      `${phase} verified`,
    );
  });
}
