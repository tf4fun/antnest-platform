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
      "../../../contracts/skill-learning/learning-api.schema.json",
      import.meta.url,
    ),
  ),
);
const ajv = new Ajv2020({ strict: true, validateFormats: false });
ajv.addSchema(schema);
const accepts = (name, value) => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert(validate, `Missing ${name} definition`);
  return validate(value);
};

const org = `org_${"a".repeat(32)}`;
const agent = `agent_${"b".repeat(32)}`;
const owner = `user_${"c".repeat(32)}`;
const digest = `sha256:${"d".repeat(64)}`;
const revision = "e".repeat(64);
const path = ".antnest/skills/fix-timeouts";

const maintenanceKidFixtures = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/runtime/maintenance-kid-fixtures.json",
      import.meta.url,
    ),
  ),
);
const runtimeSchema = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/runtime/runtime-spec.schema.json",
      import.meta.url,
    ),
  ),
);
const instanceSchema = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/runtime/instance-connection.schema.json",
      import.meta.url,
    ),
  ),
);
const runtimeValidator = new Ajv2020({ strict: true, validateFormats: false });
const managedSchema = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/runtime/managed-mcp.schema.json",
      import.meta.url,
    ),
  ),
);
runtimeValidator.addSchema(managedSchema);
runtimeValidator.addSchema(instanceSchema);
runtimeValidator.addSchema(runtimeSchema);
const validateVerifiers = runtimeValidator.getSchema(
  `${runtimeSchema.$id}#/$defs/skillMaintenanceVerifiers`,
);

test("maintenance key identity has one bounded RuntimeSpec grammar", () => {
  assert.equal(
    runtimeSchema.$defs.maintenanceKid.pattern,
    "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
  );
  assert.equal(
    runtimeSchema.$defs.skillMaintenanceVerifiers.properties.keys.items
      .properties.kid.$ref,
    "#/$defs/maintenanceKid",
  );
});

for (const [group, kids] of Object.entries(maintenanceKidFixtures)) {
  for (const kid of kids) {
    test(`maintenance key identity ${group}: ${JSON.stringify(kid)}`, () => {
      assert.equal(
        validateVerifiers({
          keys: [
            { kid, algorithm: "Ed25519", public_key_base64url: "A".repeat(43) },
          ],
        }),
        group === "valid",
        JSON.stringify(validateVerifiers.errors),
      );
      assert.equal(
        accepts("runtime_verifiers", {
          keys: [
            { kid, algorithm: "Ed25519", public_key_base64url: "A".repeat(43) },
          ],
        }),
        group === "valid",
      );
    });
  }
}

test("learning status exposes one bounded blocker without maintenance authority or process arguments", () => {
  const status = { agentId: agent, blocked: null };
  assert(accepts("learning_status", status));
  const blocked = {
    reason: "writer_present",
    skillName: "fix-timeouts",
    sourceSessionId: "session-1",
  };
  assert(accepts("learning_status", { ...status, blocked }));
  assert.equal(
    accepts("learning_status", {
      ...status,
      blocked: { ...blocked, command: "bash secret" },
    }),
    false,
  );
  assert.equal(
    accepts("learning_status", {
      ...status,
      blocked: { ...blocked, stopUrl: "/kill" },
    }),
    false,
  );
  assert.equal(
    accepts("learning_status", { ...status, blocked: { reason: "arbitrary" } }),
    false,
  );
});

test("automatic policy stays Agent-scoped, bounded, and separate from the off switch", () => {
  const policy = {
    organization_id: org,
    agent_id: agent,
    owner_principal_id: owner,
    revision,
    mode: "automatic",
    activation_cut_at: "2026-09-29T00:00:00Z",
    scope: { auto_generated_personal: true, adopted_paths: [] },
    pinned_paths: [],
    limits: {
      daily_reviews: 20,
      daily_model_input_tokens: 320000,
      daily_model_output_tokens: 80000,
    },
  };
  assert(accepts("policy", policy));
  assert.equal(
    accepts("policy", {
      ...policy,
      scope: { auto_generated_personal: true, adopted_paths: [path] },
    }),
    false,
  );
  assert(accepts("policy", { ...policy, mode: "off" }));
  assert(
    accepts("policy", {
      ...policy,
      organization_id: "org-1",
      agent_id: "agent-1",
      owner_principal_id: "user-1",
    }),
  );
  assert.equal(
    accepts("policy", { ...policy, mode: "approval_required" }),
    false,
  );
  assert.equal(
    accepts("policy", { ...policy, activation_cut_at: undefined }),
    false,
  );
  assert.equal(
    accepts("policy", {
      ...policy,
      activation_cut_at: "2026-09-29T00:00:00+08:00",
    }),
    false,
  );
  assert.equal(
    accepts("policy", { ...policy, organization_id: "org/other" }),
    false,
  );
  assert.equal(
    accepts("policy", { ...policy, user_claimed_scope: true }),
    false,
  );
  assert.equal(
    accepts("policy", {
      ...policy,
      scope: {
        auto_generated_personal: true,
        adopted_paths: ["/skills/system"],
      },
    }),
    false,
  );
  assert.equal(
    accepts("policy", {
      ...policy,
      limits: {
        ...policy.limits,
        daily_reviews: 21,
      },
    }),
    false,
  );
});

test("policy mutation uses revision CAS and an authenticated actor, not caller-selected scope", () => {
  const mutation = {
    request_id: "policy-1",
    organization_id: org,
    actor_principal_id: owner,
    expected_revision: revision,
    mode: "off",
    scope: { auto_generated_personal: true, adopted_paths: [] },
    pinned_paths: [],
    limits: {
      daily_reviews: 20,
      daily_model_input_tokens: 320000,
      daily_model_output_tokens: 80000,
    },
  };
  assert(accepts("policy_mutation_request", mutation));
  assert.equal(
    accepts("policy_mutation_request", {
      ...mutation,
      expected_revision: undefined,
    }),
    false,
  );
  assert.equal(
    accepts("policy_mutation_request", { ...mutation, agent_id: agent }),
    false,
  );
  assert.equal(
    accepts("policy_mutation_request", {
      ...mutation,
      activation_cut_at: "2020-01-01T00:00:00Z",
    }),
    false,
  );
  assert.equal(
    accepts("policy_mutation_request", {
      ...mutation,
      apply_without_recheck: true,
    }),
    false,
  );
});

test("policy application requires source evidence and cannot impersonate user action", () => {
  const basis = {
    kind: "policy",
    policy_revision: revision,
    package_path: path,
    target_digest: digest,
    evidence_ids: ["user-message-1"],
  };
  assert(accepts("apply_basis", basis));
  assert.equal(accepts("apply_basis", { ...basis, evidence_ids: [] }), false);
  assert.equal(
    accepts("apply_basis", { ...basis, user_action_id: "claimed" }),
    false,
  );
  assert(
    accepts("apply_basis", {
      kind: "user_action",
      user_action_id: "action-1",
      confirmation_id: "confirmed-1",
      package_path: path,
      target_digest: digest,
    }),
  );
  assert.equal(
    accepts("apply_basis", {
      kind: "user_action",
      user_action_id: "action-1",
      package_path: path,
      target_digest: digest,
    }),
    false,
  );
});

test("Runtime ticket binds execution, job generation, action, request, and body", () => {
  const ticket = {
    organization_id: org,
    agent_id: agent,
    execution_id: "execution-1",
    job_id: "job-1",
    generation: 2,
    action: "commit",
    request_id: "commit-1",
    body_sha256: digest,
    issued_at: 1790610000,
    expires_at: 1790610060,
  };
  assert(accepts("ticket", ticket));
  assert.equal(accepts("ticket", { ...ticket, body_sha256: undefined }), false);
  assert.equal(accepts("ticket", { ...ticket, generation: 0 }), false);
  assert.equal(accepts("ticket", { ...ticket, action: "tools/call" }), false);
  assert.equal(accepts("ticket", { ...ticket, caller_role: "admin" }), false);
});

test("maintenance requests carry conditional digest and stable request identity", () => {
  const request = {
    action: "commit",
    request_id: "commit-1",
    job_id: "job-1",
    generation: 2,
    candidate_id: "candidate-1",
    package_path: path,
    expected_base_digest: null,
    target_digest: digest,
  };
  assert(accepts("commit_request", request));
  assert.equal(
    accepts("commit_request", { ...request, target_digest: undefined }),
    false,
  );
  assert.equal(
    accepts("commit_request", { ...request, package_path: "/skills/system" }),
    false,
  );
  assert.equal(accepts("commit_request", { ...request, force: true }), false);
});

test("learning notice metadata has a stable change identity and no authority fields", () => {
  const notice = {
    version: 1,
    changeId: "change-1",
    sequence: "42",
    agentId: agent,
    kind: "skill_updated",
    occurredAt: "2026-09-29T00:00:00Z",
    skillName: "fix-timeouts",
    changeSummary: "Added a retry check",
    sourceSessionId: "session-1",
    sourceRunId: "run-1",
  };
  assert(accepts("notice_metadata", notice));
  assert.equal(
    accepts("notice_metadata", { ...notice, changeId: undefined }),
    false,
  );
  assert.equal(accepts("notice_metadata", { ...notice, sequence: "0" }), false);
  assert.equal(
    accepts("notice_metadata", { ...notice, occurredAt: undefined }),
    false,
  );
  assert.equal(
    accepts("notice_metadata", { ...notice, skillName: undefined }),
    false,
  );
  assert.equal(
    accepts("notice_metadata", { ...notice, changeSummary: undefined }),
    false,
  );
  assert.equal(
    accepts("notice_metadata", { ...notice, kind: "skill_reverted" }),
    false,
  );
  assert.equal(
    accepts("notice_metadata", { ...notice, approved: true }),
    false,
  );
  assert.equal(accepts("notice_metadata", { ...notice, version: 2 }), false);
});

test("learning change pages bound recovery size to applied Skill changes", () => {
  const item = {
    changeId: "change-2",
    sequence: "43",
    agentId: agent,
    kind: "skill_updated",
    occurredAt: "2026-09-29T00:00:00Z",
    skillName: "fix-timeouts",
    changeSummary: "Added a retry check",
  };
  const page = {
    items: [item],
    nextCursor: "cursor-43",
    olderCursor: "cursor-before-43",
    sealedCursor: "cursor-43",
  };
  assert(accepts("change_page", page));
  assert.equal(
    accepts("change_page", { ...page, items: Array(21).fill(item) }),
    false,
  );
  assert.equal(
    accepts("change_page", {
      ...page,
      items: [{ ...item, skillBody: "secret" }],
    }),
    false,
  );
  assert.equal(
    accepts("change_page", {
      ...page,
      items: [
        { ...item, kind: "skill_reverted", revertedChangeId: "change-1" },
      ],
    }),
    false,
  );
  assert(
    accepts("change_page", {
      items: [],
      nextCursor: "0",
      olderCursor: null,
      sealedCursor: "0",
    }),
  );
  assert.equal(
    accepts("change_page", {
      items: [],
      nextCursor: "",
      olderCursor: null,
      sealedCursor: "0",
    }),
    false,
  );
  assert.equal(
    accepts("change_page", { ...page, olderCursor: undefined }),
    false,
  );
});

test("first delivery contract has no undo or diff surface", () => {
  for (const name of [
    "change_detail",
    "file_change",
    "undo_request",
    "undo_receipt",
    "revert_request",
  ])
    assert.equal(Object.hasOwn(schema.$defs, name), false, name);
});

test("Runtime verifier bootstrap is bounded and uses public keys only", () => {
  const key = {
    kid: "learning-2026-09",
    algorithm: "Ed25519",
    public_key_base64url: "a".repeat(43),
  };
  assert(accepts("runtime_verifiers", { keys: [] }));
  assert(accepts("runtime_verifiers", { keys: [key] }));
  assert.equal(accepts("runtime_verifiers", { keys: [key, key, key] }), false);
  assert.equal(
    accepts("runtime_verifiers", { keys: [{ ...key, private_key: "leak" }] }),
    false,
  );
  assert.equal(
    accepts("runtime_verifiers", { keys: [{ ...key, algorithm: "none" }] }),
    false,
  );
});

test("automatic task binds a persisted completed Run and frozen policy", () => {
  const task = {
    organization_id: org,
    agent_id: agent,
    owner_principal_id: owner,
    job_id: "job-1",
    trigger: "run_completed",
    source_run_id: "run-1",
    policy_revision: revision,
    review_prompt_version: 1,
    package_rules_version: 1,
    state: "pending",
  };
  assert(accepts("task", task));
  assert(accepts("task", { ...task, review_prompt_version: 2 }));
  assert.equal(accepts("task", { ...task, source_run_id: undefined }), false);
  assert.equal(accepts("task", { ...task, state: "approval_required" }), false);
  assert.equal(accepts("task", { ...task, user_action_id: "claimed" }), false);
});

test("candidate and evidence preserve provenance and do not claim executable verification", () => {
  const candidate = {
    candidate_id: "candidate-1",
    job_id: "job-1",
    package_path: path,
    expected_base_digest: null,
    target_digest: digest,
    artifact_digest: digest,
    package_rules_version: 1,
    state: "ready_waiting_idle",
    evidence_ids: ["evidence-1"],
  };
  assert(accepts("candidate", candidate));
  assert.equal(accepts("candidate", { ...candidate, evidence_ids: [] }), false);
  assert.equal(
    accepts("candidate", { ...candidate, verified_execution: true }),
    false,
  );
  assert(
    accepts("evidence", {
      evidence_id: "evidence-1",
      source_run_id: "run-1",
      source_id: "user-message-1",
      kind: "authenticated_user",
      scope: "timeout-retry",
    }),
  );
  assert.equal(
    accepts("evidence", {
      evidence_id: "evidence-1",
      source_run_id: "run-1",
      source_id: "tool-output-1",
      kind: "trusted_tool_output",
      scope: "retry",
    }),
    false,
  );
});

test("prepare, check, observe, cancel and release are distinct strict operations", () => {
  const base = { request_id: "request-1", job_id: "job-1", generation: 2 };
  const prepare = {
    ...base,
    action: "prepare",
    candidate_id: "candidate-1",
    package_path: path,
    expected_base_digest: null,
    target_digest: digest,
    artifact_digest: digest,
    package_rules_version: 1,
  };
  const check = {
    ...base,
    action: "check",
    candidate_id: "candidate-1",
    package_path: path,
    target_digest: digest,
    package_rules_version: 1,
  };
  const observe = {
    ...base,
    action: "observe",
    effect_request_id: "commit-1",
    expected_target_digest: digest,
  };
  const cancel = { ...base, action: "cancel" };
  const release = {
    ...base,
    action: "release",
    storage_class: "candidate",
    storage_key: digest.slice(7),
    package_path: path,
    expected_digest: digest,
  };
  for (const [name, value] of Object.entries({
    prepare,
    check,
    observe,
    cancel,
    release,
  }))
    assert(accepts(`${name}_request`, value), name);
  assert.equal(
    accepts("prepare_request", { ...prepare, package_rules_version: 2 }),
    false,
  );
  assert.equal(
    accepts("observe_request", { ...observe, retry_as_new: true }),
    false,
  );
  assert.equal(
    accepts("ticket", {
      organization_id: org,
      agent_id: agent,
      execution_id: "execution-1",
      job_id: "job-1",
      generation: 2,
      action: "revert",
      request_id: "request-1",
      body_sha256: digest,
      issued_at: 1790610000,
      expires_at: 1790610060,
    }),
    false,
  );
  assert.equal(
    accepts("release_request", { ...release, storage_key: "../skills" }),
    false,
  );
  assert.equal(
    accepts("release_request", { ...release, storage_class: "workspace" }),
    false,
  );
  assert.equal(
    accepts("release_request", { ...release, storage_class: "history" }),
    false,
  );
  assert.equal(
    accepts("release_request", {
      ...release,
      storage_key: `revert-${release.storage_key}`,
    }),
    false,
  );
});

test("maintenance receipt distinguishes settled results, blocked and unknown effects", () => {
  const base = {
    request_id: "commit-1",
    action: "commit",
    execution_id: "execution-1",
    outcome: "applied",
    observed_digest: digest,
  };
  assert(accepts("maintenance_receipt", base));
  assert.equal(
    accepts("maintenance_receipt", {
      ...base,
      action: "prepare",
      outcome: "prepared",
    }),
    false,
  );
  assert(
    accepts("maintenance_receipt", {
      ...base,
      action: "prepare",
      outcome: "prepared",
      storage_key: digest.slice(7),
    }),
  );
  assert(
    accepts("maintenance_receipt", {
      ...base,
      action: "release",
      outcome: "released",
      observed_digest: null,
    }),
  );
  assert(
    accepts("maintenance_receipt", {
      ...base,
      outcome: "unknown",
      observed_digest: null,
    }),
  );
  assert.equal(
    accepts("maintenance_receipt", { ...base, outcome: "blocked" }),
    false,
  );
  assert.equal(
    accepts("maintenance_receipt", {
      ...base,
      outcome: "blocked",
      blocked_reason: "background_task_running",
    }),
    false,
  );
  assert(
    accepts("maintenance_receipt", {
      ...base,
      outcome: "blocked",
      blocked_reason: "background_task_running",
      blocked_subject_id: "bash:42",
    }),
  );
  assert.equal(
    accepts("maintenance_receipt", {
      ...base,
      outcome: "blocked",
      blocked_reason: "managed_call_in_flight",
    }),
    false,
  );
  assert(
    accepts("maintenance_receipt", {
      ...base,
      outcome: "blocked",
      blocked_reason: "managed_call_in_flight",
      blocked_subject_id: "managed:server-a",
    }),
  );
  assert.equal(
    accepts("maintenance_receipt", { ...base, shell_output: "secret" }),
    false,
  );
});

test("L0 links notice negotiation, Runtime bootstrap, and Agent View without a second channel", async () => {
  const related = await Promise.all(
    [
      "agent-acp/workspace-bridge.schema.json",
      "runtime/runtime-spec.schema.json",
      "agent-ui/workspace-api.schema.json",
    ].map(async (path) =>
      JSON.parse(
        await readFile(new URL(`../../../contracts/${path}`, import.meta.url)),
      ),
    ),
  );
  const [bridge, runtime, workspace] = related;
  const compile = (document, name) => {
    const validator = new Ajv2020({ strict: true, validateFormats: false });
    validator.addSchema(managedSchema);
    validator.addSchema(instanceSchema);
    validator.addSchema(document);
    return validator.getSchema(`${document.$id}#/$defs/${name}`);
  };
  const bridgeCapability = compile(bridge, "bridgeCapabilities");
  const original = {
    intentReceipt: 1,
    targetCancel: 1,
    deliveryMark: 1,
    configurationCas: 1,
  };
  assert(bridgeCapability({ ...original, learningNotices: 1 }));
  assert.equal(bridgeCapability({ ...original, learningNotices: 2 }), false);

  const verifiers = compile(runtime, "skillMaintenanceVerifiers");
  assert(verifiers({ keys: [] }));
  assert.equal(
    verifiers({
      keys: [
        { kid: "one", algorithm: "none", public_key_base64url: "a".repeat(43) },
      ],
    }),
    false,
  );
  assert(runtime.properties.skill_maintenance_verifiers);

  const notice = compile(workspace, "systemNotice");
  assert(
    notice({
      changeId: "change-1",
      sequence: "42",
      agentId: agent,
      kind: "skill_updated",
      occurredAt: "2026-09-29T00:00:00Z",
      skillName: "fix-timeouts",
      changeSummary: "Added a retry check",
    }),
  );
  assert(
    notice({
      changeId: "change-1",
      sequence: "42",
      agentId: "agent-1",
      kind: "skill_updated",
      occurredAt: "2026-09-29T00:00:00Z",
      skillName: "fix-timeouts",
      changeSummary: "Added a retry check",
    }),
  );
  assert.equal(
    notice({
      changeId: "change-1",
      sequence: "42",
      agentId: agent,
      kind: "skill_updated",
      occurredAt: "2026-09-29T00:00:00Z",
      skillName: "fix-timeouts",
      changeSummary: "Added a retry check",
      rawToolOutput: "private",
    }),
    false,
  );
  assert.equal(
    notice({
      changeId: "change-1",
      sequence: "42",
      agentId: agent,
      kind: "skill_reverted",
      occurredAt: "2026-09-29T00:00:00Z",
      skillName: "fix-timeouts",
      changeSummary: "Reverted a skill",
      revertedChangeId: "change-0",
    }),
    false,
  );
  assert(workspace.$defs.agentView.properties.systemNotices);
});
