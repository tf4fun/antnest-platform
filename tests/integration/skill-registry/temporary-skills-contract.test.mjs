import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const Ajv = require("ajv");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/runtime/temporary-skills.schema.json",
      import.meta.url,
    ),
  ),
);
const ajv = new Ajv({ strict: true });
ajv.addSchema(schema);
const digest = `sha256:${"a".repeat(64)}`;
const install = {
  action: "temporary_install",
  request_id: "request_1",
  job_id: "run_1",
  generation: 1,
  content_digest: digest,
  artifact_digest: digest,
  package_rules_version: 1,
};
const release = {
  action: "temporary_release",
  request_id: "release_1",
  job_id: "run_1",
  generation: 1,
};
const validate = (name, input) =>
  ajv.getSchema(`${schema.$id}#/$defs/${name}`)(input);

test("temporary delivery accepts exact Run-bound operations and rejects model paths or learning identities", () => {
  assert(validate("install_metadata", install));
  assert(validate("release_request", release));
  for (const patch of [
    { path: "/skills/x" },
    { organization_id: "org_1" },
    { source_url: "https://source.invalid" },
    { generation: 2 },
    { action: "prepare" },
    { job_id: "../run_1" },
    { content_digest: "latest" },
    { package_rules_version: 2 },
  ])
    assert.equal(validate("install_metadata", { ...install, ...patch }), false);
  assert.equal(
    validate("release_request", { ...release, path: "/workspace" }),
    false,
  );
});

test("installed and released replies must prove settled file effects and a real managed path", () => {
  const common = {
    request_id: "request_1",
    job_id: "run_1",
    execution_id: "execution-1",
    effect_state: "settled",
    runtime_call_stopped: true,
  };
  const installed = {
    ...common,
    action: "temporary_install",
    outcome: "installed",
    temporary_path: `/workspace/.antnest/skill-temporary/v1/${"b".repeat(64)}/${"a".repeat(64)}/package`,
    content_digest: digest,
    artifact_digest: digest,
    unpacked_size: 32,
  };
  assert(validate("install_reply", installed));
  assert(
    validate("release_reply", {
      ...common,
      action: "temporary_release",
      outcome: "released",
    }),
  );
  for (const patch of [
    { temporary_path: "/skills/x" },
    { temporary_path: "/workspace/.antnest/skills/x" },
    { effect_state: "none" },
    { runtime_call_stopped: false },
    { unpacked_size: 33554433 },
  ])
    assert.equal(validate("install_reply", { ...installed, ...patch }), false);
});

test("uncertain temporary effects cannot be mistaken for readonly discovery", () => {
  const error = {
    error: {
      code: "outcome_unknown",
      message: "Temporary Skill request did not complete",
      retryable: true,
      effect_state: "unknown",
      runtime_call_stopped: false,
    },
  };
  assert(validate("error_reply", error));
  assert.equal(
    validate("error_reply", {
      error: { ...error.error, artifact: "private bytes" },
    }),
    false,
  );
});
