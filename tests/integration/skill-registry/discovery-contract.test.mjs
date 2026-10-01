import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const load = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const original = await load(
  "../../../contracts/skill-registry/registry-api.schema.json",
);
const schema = await load(
  "../../../contracts/skill-registry/discovery-api.schema.json",
);
const ajv = new Ajv2020({ strict: true, validateFormats: false });
ajv.addSchema(original);
ajv.addSchema(schema);
const accepts = (name, value) => {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert(check, name);
  return check(value);
};
const org = `org_${"a".repeat(32)}`;
const agent = `agent_${"b".repeat(32)}`;
const owner = `user_${"c".repeat(32)}`;
const digest = `sha256:${"d".repeat(64)}`;
const projection = {
  organization_id: org,
  agent_id: agent,
  owner_id: owner,
  name: "code-review",
  description: "Review code",
  sequence: 1,
  content_digest: digest,
  active: true,
};
const ref = {
  kind: "agent",
  agent_id: agent,
  name: "code-review",
  sequence: 1,
};

test("projection is a bounded metadata mapping with no content, URLs or publishing authority", () => {
  assert(accepts("projection", projection));
  assert(accepts("projection", { ...projection, active: false, sequence: 2 }));
  for (const extra of [
    { artifact: "ZIP" },
    { instructions: "body" },
    { source_url: "http://arbitrary/" },
    { sharing: "organization" },
    { publish: true },
  ]) {
    assert.equal(accepts("projection", { ...projection, ...extra }), false);
  }
  for (const extra of [
    { sequence: 0 },
    { sequence: 9007199254740992 },
    { name: "../escape" },
    { owner_id: "owner" },
    { active: "yes" },
  ]) {
    assert.equal(accepts("projection", { ...projection, ...extra }), false);
  }
});

test("Agent references and immutable Registry references cannot be mixed", () => {
  const formal = {
    kind: "registry",
    skill_id: `skill_${"e".repeat(32)}`,
    version: 1,
  };
  assert(accepts("skill_ref", ref));
  assert(accepts("skill_ref", formal));
  assert.equal(accepts("skill_ref", { ...ref, version: 1 }), false);
  assert.equal(accepts("skill_ref", { ...formal, agent_id: agent }), false);
  assert.equal(accepts("skill_ref", { ...ref, sequence: undefined }), false);
});

test("search and loading require trusted actor context, bounded queries and exact selected content", () => {
  assert(
    accepts("search_request", {
      organization_id: org,
      actor_id: owner,
      query: "review",
      limit: 20,
    }),
  );
  assert.equal(
    accepts("search_request", { organization_id: org, query: "review" }),
    false,
  );
  assert.equal(
    accepts("search_request", {
      organization_id: org,
      actor_id: owner,
      query: "review",
      limit: 51,
    }),
    false,
  );
  const input = {
    organization_id: org,
    actor_id: owner,
    skill_ref: ref,
    expected_digest: digest,
  };
  assert(accepts("load_request", input));
  assert.equal(
    accepts("load_request", { ...input, expected_digest: undefined }),
    false,
  );
  assert.equal(
    accepts("load_request", { ...input, source_url: "http://source/" }),
    false,
  );
});

test("only trusted search context can identify the requesting Agent", () => {
  const input = {
    organization_id: org,
    actor_id: owner,
    query: "review",
    requesting_agent_id: agent,
  };
  assert(accepts("search_request", input));
  for (const id of [null, "", owner, "agent", 1])
    assert.equal(
      accepts("search_request", { ...input, requesting_agent_id: id }),
      false,
    );
  assert.equal(
    accepts("find_skill_input", {
      query: "review",
      requesting_agent_id: agent,
    }),
    false,
  );
});

test("promotion selects an Agent source and explicitly chooses create or append", () => {
  const input = {
    request_id: "promote-1",
    organization_id: org,
    actor_id: owner,
    skill_ref: ref,
    expected_digest: digest,
  };
  assert(accepts("promote_request", input));
  assert(
    accepts("promote_request", {
      ...input,
      skill_id: `skill_${"e".repeat(32)}`,
      expected_version: 1,
    }),
  );
  assert.equal(
    accepts("promote_request", { ...input, expected_version: 1 }),
    false,
  );
  assert.equal(
    accepts("promote_request", {
      ...input,
      skill_id: `skill_${"e".repeat(32)}`,
    }),
    false,
  );
  assert.equal(
    accepts("promote_request", {
      ...input,
      skill_ref: {
        kind: "registry",
        skill_id: `skill_${"e".repeat(32)}`,
        version: 1,
      },
    }),
    false,
  );
  assert.equal(
    accepts("promote_request", { ...input, artifact: "ZIP" }),
    false,
  );
});

test("model tools cannot select a tenant, principal, download URL or permanent install", () => {
  assert(accepts("find_skill_input", { query: "review" }));
  assert(
    accepts("load_skill_input", { skill_ref: ref, expected_digest: digest }),
  );
  assert.equal(
    accepts("find_skill_input", { query: "review", organization_id: org }),
    false,
  );
  assert.equal(
    accepts("load_skill_input", {
      skill_ref: ref,
      expected_digest: digest,
      persist: true,
    }),
    false,
  );
});

test("source inspection is bounded and the binary fetch uses the same selected identity", () => {
  assert(
    accepts("inspect_request", {
      organization_id: org,
      actor_id: owner,
      sources: [{ agent_id: agent, name: "code-review" }],
    }),
  );
  assert(accepts("inspect_response", { items: [projection] }));
  assert.equal(
    accepts("inspect_request", {
      organization_id: org,
      actor_id: owner,
      sources: Array(51).fill({ agent_id: agent, name: "code-review" }),
    }),
    false,
  );
  assert(
    accepts("source_artifact_request", {
      organization_id: org,
      actor_id: owner,
      skill_ref: ref,
      expected_digest: digest,
    }),
  );
});

test("Template references remain fixed formal versions and reject dynamic Agent mappings", async () => {
  const controller = await load(
    "../../../contracts/agent-controller/control-api.schema.json",
  );
  const fixed = ajv.compile(controller.$defs.skill_reference);
  assert(fixed({ skill_id: `skill_${"e".repeat(32)}`, version: 1 }));
  assert.equal(fixed(ref), false);
  assert.equal(
    fixed({ skill_id: `skill_${"e".repeat(32)}`, version: 1, latest: true }),
    false,
  );
});
