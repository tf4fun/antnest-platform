import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const schema = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/runtime/builtin-tools.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: true });
ajv.addSchema(schema);
const valid = {
  read: [
    { path: "demo/check.md" },
    { path: "/skills/example/SKILL.md", offset: 2, limit: 3 },
  ],
  write: [{ path: "demo/check.md", content: "你好\n" }],
  edit: [{ path: "demo/check.md", old_string: "你好", new_string: "已核验" }],
  bash: [
    { command: "pwd" },
    { command: "pwd", working_dir: "/workspace/demo", timeout_ms: 1000 },
  ],
};

for (const [name, examples] of Object.entries(valid)) {
  test(`${name} accepts ordinary flat arguments`, () => {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
    for (const input of examples)
      assert(validate(input), JSON.stringify(validate.errors));
    const old =
      name === "bash"
        ? { ...examples[0], working_dir: { root: "workspace", path: "." } }
        : { ...examples[0], path: { root: "workspace", path: "notes.txt" } };
    assert.equal(validate(old), false);
  });
}

test("read rejects byte offsets, empty paths and unknown root fields", () => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/read`);
  for (const input of [
    { path: "x", offset: 0 },
    { path: "" },
    { path: "x", root: "workspace" },
    { path: "x", limit: 20001 },
  ])
    assert.equal(validate(input), false);
});
