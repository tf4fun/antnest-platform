import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { decide } from "./automatic-model.mjs";

test("tool usability fixture exercises four ordinary calls and checks the read-back", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL(
        "../../../contracts/runtime/builtin-tools.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const payload = {
    model: "stage3-model",
    tools: Object.entries(schema.$defs).map(([name, parameters]) => ({
      type: "function",
      function: { name, parameters },
    })),
    messages: [
      { role: "user", content: "learn: inspect the target before editing it" },
    ],
  };
  const output = [
    { bytes_written: 34 },
    { bytes_written: 37 },
    { content: "# Tool verification\nstate: verified\n" },
    { exit_code: 0, stdout: "fixture-tool-completed\n" },
  ];
  for (const [index, name] of ["write", "edit", "read", "bash"].entries()) {
    const result = decide(payload, { toolUsability: true });
    assert.equal(result.call.name, name);
    if (name !== "bash")
      assert.equal(result.call.arguments.path, "demo/tool-usability.md");
    if (name === "read")
      assert.deepEqual(result.call.arguments, {
        path: "demo/tool-usability.md",
      });
    if (name === "bash")
      assert.deepEqual(Object.keys(result.call.arguments), ["command"]);
    payload.messages.push({
      role: "tool",
      content: JSON.stringify(output[index]),
    });
  }
  assert.equal(decide(payload, { toolUsability: true }).call, undefined);
  payload.messages[3].content = JSON.stringify({ content: "state: draft" });
  assert.throws(() => decide(payload, { toolUsability: true }), /read-back/);
});
