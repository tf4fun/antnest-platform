import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./rpc-model.mjs";

function payload(phase, result) {
  return {
    messages: [
      { role: "user", content: phase },
      ...(result === undefined
        ? []
        : [{ role: "tool", content: JSON.stringify(result) }]),
    ],
    tools: ["bash", "read"].map((name) => ({ function: { name } })),
  };
}
for (const version of [1, 2])
  for (const kind of ["acquire", "finish"])
    test(`v${version} ${kind}: only a real single append and later exact read satisfy the model`, () => {
      const phase = `v${version}-rpc-${kind}`;
      const read = `v${version}-rpc-read-${kind}`;
      assert.equal(decide(payload(phase)).call.name, "bash");
      assert.equal(decide(payload(read)).call.name, "read");
      assert.equal(
        decide(payload(read)).call.arguments.path.path,
        `${phase}.log`,
      );
      const result = {
        exit_code: 0,
        stdout: `${phase}\n`,
        stderr: "",
        truncated: false,
        effect_state: "settled",
      };
      assert.equal(decide(payload(phase, result)).text, `${phase} verified`);
      assert.equal(
        decide(payload(read, { content: `${phase}\n` })).text,
        `${read} verified`,
      );
      for (const invalid of [
        { ...result, exit_code: 1 },
        { ...result, stdout: `${phase}\n${phase}\n` },
        { ...result, stdout: "" },
        { ...result, truncated: true },
      ])
        assert.throws(() => decide(payload(phase, invalid)));
      for (const content of ["", "different\n", `${phase}\n${phase}\n`])
        assert.throws(() => decide(payload(read, { content })));
      assert.throws(() => decide({ ...payload(phase), tools: [] }));
      const duplicate = payload(phase, result);
      duplicate.messages.push(duplicate.messages.at(-1));
      assert.throws(() => decide(duplicate));
    });
