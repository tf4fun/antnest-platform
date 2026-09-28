import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireFromAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireFromAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/skill-registry/legacy-source-recovery.schema.json",
      import.meta.url,
    ),
  ),
);
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  validateFormats: false,
});
ajv.addSchema(schema);
const request = ajv.getSchema(`${schema.$id}#/$defs/request`);
const receipt = ajv.getSchema(`${schema.$id}#/$defs/receipt`);

const org = `org_${"a".repeat(32)}`;
const agent = `agent_${"b".repeat(32)}`;
const source = `rtv_${"c".repeat(32)}`;
const disabled = `rtv_${"d".repeat(32)}`;

test("source recovery request cannot choose or infer a Runtime source", () => {
  assert(request({ organization_id: org, actor_principal_id: "admin-1" }));
  assert.equal(
    request({
      organization_id: org,
      actor_principal_id: "admin-1",
      source_runtime_revision: source,
    }),
    false,
  );
  assert.equal(
    request({
      organization_id: org,
      actor_principal_id: "admin-1",
      source_absent: true,
    }),
    false,
  );
});

test("completed and manual recovery receipts carry their required evidence", () => {
  const base = {
    request_id: "recover-1",
    agent_id: agent,
    source_runtime_revision: source,
    observed_runtime_execution_id: "process-1",
  };
  assert(receipt({ ...base, state: "running", phase: "disable_runtime" }));
  assert.equal(receipt({ ...base, state: "completed", phase: "done" }), false);
  assert(
    receipt({
      ...base,
      state: "completed",
      phase: "done",
      child_request_id: "child-1",
      disabled_runtime_revision: disabled,
    }),
  );
  assert.equal(
    receipt({ ...base, state: "manual_recovery_required", phase: "publish" }),
    false,
  );
  assert(
    receipt({
      ...base,
      state: "manual_recovery_required",
      phase: "publish",
      error_code: "legacy_source_manual_recovery_required",
      manual_reason: "publication_conflict",
    }),
  );
});
