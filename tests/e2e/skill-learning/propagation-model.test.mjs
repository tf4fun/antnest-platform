import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./automatic-model.mjs";

const before = "For the fixture task, inspect the target before editing it.";
const after = "For the fixture task, check the result after editing it.";

function payload(
  version,
  content,
  phase = version === 1 ? "created" : "rebuilt-existing",
) {
  return {
    model: "stage3-model",
    tools: [{ function: { name: "read" } }],
    messages: [
      {
        role: "user",
        content: `verify propagated preset v${version} ${phase}`,
      },
      ...(content === undefined
        ? []
        : [{ role: "tool", content: JSON.stringify(content) }]),
    ],
  };
}

test("propagation fixture reads the actual system Skill and verifies its frozen version", () => {
  for (const version of [1, 2]) {
    assert.deepEqual(decide(payload(version)).call, {
      name: "read",
      arguments: { path: "/skills/fixture-procedure/SKILL.md" },
    });
    const body = version === 1 ? before : `${before}\n${after}`;
    assert.equal(
      decide(payload(version, { content: body })).text,
      `Preset v${version} verified.`,
    );
  }
});

test("six propagation phases retain duplicate-request protection without rejecting legitimate later Runs", () => {
  const kinds = [];
  for (const [version, phase] of [
    [1, "created"],
    [1, "offline"],
    [1, "frozen"],
    [2, "rebuilt-existing"],
    [2, "rebuilt-new"],
    [2, "independent"],
  ]) {
    const body = version === 1 ? before : `${before}\n${after}`;
    kinds.push(decide(payload(version, undefined, phase)).kind);
    kinds.push(decide(payload(version, { content: body }, phase)).kind);
  }
  assert.equal(new Set(kinds).size, 12);
  assert.throws(() => decide(payload(2, undefined, "created")));
});

test("propagation fixture cannot report success from stale, advanced or failed tool results", () => {
  assert.throws(() => decide(payload(2, { content: before })));
  assert.throws(() => decide(payload(1, { content: `${before}\n${after}` })));
  assert.throws(() => decide(payload(1, { error: { code: "not_found" } })));
  assert.throws(() => decide(payload(1, { content: "another procedure" })));
  const noRead = payload(1);
  noRead.tools = [{ function: { name: "bash" } }];
  assert.throws(() => decide(noRead));
});

test("source lifecycle phases verify frozen formal bytes with distinct request identities", () => {
  const kinds = [];
  for (const phase of ["source-disabled", "source-deleted"]) {
    const read = decide(payload(2, undefined, phase));
    assert.deepEqual(read.call, {
      name: "read",
      arguments: { path: "/skills/fixture-procedure/SKILL.md" },
    });
    const reply = decide(payload(2, { content: `${before}\n${after}` }, phase));
    assert.equal(reply.text, "Preset v2 verified.");
    kinds.push(read.kind, reply.kind);
    assert.throws(() => decide(payload(1, undefined, phase)));
    assert.throws(() => decide(payload(2, { content: before }, phase)));
  }
  assert.equal(new Set(kinds).size, 4);
});
