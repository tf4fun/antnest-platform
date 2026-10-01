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
  test(`v${version}: in-flight effect cannot complete or replay before ACP restart`, () => {
    const phase = `v${version}-tool-inflight`;
    const result = decide(payload(phase));
    assert.equal(result.call.name, "bash");
    assert(
      result.call.arguments.command.includes(
        `>> /workspace/acp-unknown-v${version}.log`,
      ),
    );
    assert(
      result.call.arguments.command.includes(`acp-unknown-v${version}.pid`),
    );
    assert(result.call.arguments.command.includes("while"));
    assert.throws(
      () => decide(payload(phase, [phase])),
      /in-flight Tool completed before fault/,
    );
    const recovered = `v${version}-recovered-effect`;
    assert.equal(
      decide(payload(recovered)).call.arguments.path,
      `acp-unknown-v${version}.log`,
    );
    assert.equal(
      decide(payload(recovered, [JSON.stringify({ content: `${phase}\n` })]))
        .text,
      `${recovered} verified`,
    );
    for (const invalid of ["missing", `${phase}\n${phase}\n`, "tool error"])
      assert.throws(() =>
        decide(payload(recovered, [JSON.stringify({ content: invalid })])),
      );
  });
  test(`v${version}: baseline appends once; earlier Run results do not skip tools`, () => {
    const phase = `v${version}-baseline`;
    const first = decide(payload(phase));
    assert.equal(first.call.name, "bash");
    assert.deepEqual(first.call.arguments.working_dir, ".");
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
        path: "acp-effects.log",
        offset: 1,
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
