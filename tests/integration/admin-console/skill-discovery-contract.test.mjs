import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const ajv = new Ajv2020({ strict: true, validateFormats: false });
for (const path of [
  "skill-registry/registry-api.schema.json",
  "skill-registry/discovery-api.schema.json",
  "admin-console/skill-discovery.schema.json",
]) {
  ajv.addSchema(
    JSON.parse(
      await readFile(new URL(`../../../contracts/${path}`, import.meta.url)),
    ),
  );
}
const id =
  "https://antnest.local/contracts/admin-console/skill-discovery.schema.json";
const accepts = (type, value) => ajv.getSchema(`${id}#/$defs/${type}`)(value);
const ref = {
  kind: "agent",
  agent_id: `agent_${"a".repeat(32)}`,
  name: "code-review",
  sequence: 2,
};
const digest = `sha256:${"b".repeat(64)}`;
const selection = { skill_ref: ref, expected_digest: digest };

test("Console search has no principal, package or organization override", () => {
  assert(accepts("search_request", { query: "review", limit: 50 }));
  for (const input of [
    { query: " " },
    { query: "review", limit: 0 },
    { query: "review", limit: 51 },
    { query: "review", actor_id: "other" },
    { query: "review", organization_id: "other" },
  ]) {
    assert.equal(accepts("search_request", input), false);
  }
});

test("preview selects exactly one current Agent mapping and contains bounded text/file metadata", () => {
  assert(accepts("selection", selection));
  const preview = {
    skill_ref: ref,
    content_digest: digest,
    skill_md: "---\nname: code-review\n---\nText",
    files: [{ path: "SKILL.md", size: 30, executable: false }],
  };
  assert(accepts("preview", preview));
  assert.equal(
    accepts("selection", { ...selection, source_url: "http://source/" }),
    false,
  );
  assert.equal(
    accepts("selection", {
      ...selection,
      skill_ref: {
        kind: "registry",
        skill_id: `skill_${"c".repeat(32)}`,
        version: 1,
      },
    }),
    false,
  );
  assert.equal(accepts("preview", { ...preview, artifact: "bytes" }), false);
  assert.equal(
    accepts("preview", { ...preview, skill_md: "x".repeat(16385) }),
    false,
  );
});

test("promotion chooses create or an explicit expected formal head, never Template or Agent mutation", () => {
  assert(accepts("promote_request", selection));
  assert(
    accepts("promote_request", {
      ...selection,
      skill_id: `skill_${"c".repeat(32)}`,
      expected_version: 1,
    }),
  );
  for (const extra of [
    { skill_id: `skill_${"c".repeat(32)}` },
    { expected_version: 1 },
    { rebuild: true },
    { template_id: "template" },
    { actor_id: "other" },
    { artifact: "bytes" },
  ]) {
    assert.equal(accepts("promote_request", { ...selection, ...extra }), false);
  }
});
