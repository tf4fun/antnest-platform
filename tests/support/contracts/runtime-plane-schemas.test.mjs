import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateGolden } from "./golden.mjs";

const contract = (relative) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../contracts/${relative}`, import.meta.url)),
      "utf8",
    ),
  );

const DIGEST = `sha256:${"a".repeat(64)}`;

const valid = async (ref, document) =>
  assert.equal(await validateGolden(ref, document), true);

const invalid = async (ref, document) =>
  assert.rejects(() => validateGolden(ref, document));

test("egress policy revision request wraps a policy spec strictly", async () => {
  const ref = "egress/policy-revision-request.schema.json";
  await valid(ref, { spec: { schema_version: 1, action: "allow_all" } });
  await valid(ref, { spec: { schema_version: 1, action: "deny_all" } });
  await valid(ref, {
    spec: {
      schema_version: 2,
      default: "deny",
      rules: [
        {
          action: "allow",
          domains: ["api.github.com"],
          ports: [443],
          protocol: "tcp",
        },
      ],
    },
  });
  await invalid(ref, {});
  await invalid(ref, { spec: null });
  await invalid(ref, { spec: { schema_version: 1, action: "sometimes" } });
  await invalid(ref, {
    spec: { schema_version: 1, action: "allow_all" },
    revision: 3,
  });
  await invalid(ref, { spec: { schema_version: 2, default: "deny" } });
});

test("egress policy assignment request accepts each precondition form", async () => {
  const ref = "egress/policy-assignment-request.stored-v2.schema.json";
  const base = { policy_id: "internet-enabled", revision: 3 };
  await valid(ref, { ...base, expected_version: "7" });
  await valid(ref, { ...base, expected_resource_version: 7 });
  await valid(ref, base);
});

test("egress policy assignment request rejects conflicting and null preconditions", async () => {
  const ref = "egress/policy-assignment-request.stored-v2.schema.json";
  const base = { policy_id: "internet-enabled", revision: 3 };
  await invalid(ref, {
    ...base,
    expected_version: "7",
    expected_resource_version: 7,
  });
  await invalid(ref, { ...base, expected_version: null });
  await invalid(ref, { ...base, expected_resource_version: null });
});

test("egress policy assignment request rejects malformed versions", async () => {
  const ref = "egress/policy-assignment-request.stored-v2.schema.json";
  const base = { policy_id: "internet-enabled", revision: 3 };
  await invalid(ref, { ...base, expected_version: 7 });
  await invalid(ref, { ...base, expected_version: "0" });
  await invalid(ref, { ...base, expected_version: "07" });
  await invalid(ref, { ...base, expected_version: "" });
  await invalid(ref, { ...base, expected_resource_version: 0 });
  await invalid(ref, { ...base, expected_resource_version: "7" });
  await invalid(ref, { ...base, expected_resource_version: -1 });
});

test("egress policy assignment request requires identity and rejects unknown fields", async () => {
  const ref = "egress/policy-assignment-request.stored-v2.schema.json";
  const base = { policy_id: "internet-enabled", revision: 3 };
  await invalid(ref, { revision: 3 });
  await invalid(ref, { policy_id: "internet-enabled" });
  await invalid(ref, { ...base, revision: 0 });
  await invalid(ref, { ...base, revision: "3" });
  await invalid(ref, { ...base, policy_id: "" });
  await invalid(ref, { ...base, policy_id: "has space" });
  await invalid(ref, { ...base, if_match: '"7"' });
  await invalid(ref, { ...base, expected_version: "7", extra: true });
});

test("egress control contract publishes the stored v2 active request schemas", () => {
  const descriptor = contract("egress/control-contract.json");
  assert.equal(
    descriptor.schemas.attachment_state_request,
    "attachment-state-request.stored-v2.schema.json",
  );
  assert.equal(
    descriptor.schemas.attachment_state_body,
    "attachment-state-body.stored-v2.schema.json",
  );
  assert.equal(
    descriptor.schemas.resource_version_request,
    "resource-version-request.stored-v2.schema.json",
  );
  assert.equal(
    descriptor.schemas.resource_version_body,
    "resource-version-body.stored-v2.schema.json",
  );
  assert.equal(
    descriptor.schemas.policy_assignment_request,
    "policy-assignment-request.stored-v2.schema.json",
  );
  const route = (method, path) =>
    descriptor.routes.find(
      (entry) => entry.method === method && entry.path === path,
    );
  const attachment = route(
    "PUT",
    "/internal/agent-network-attachments/{agent_id}",
  );
  assert.equal(
    attachment.request_schema,
    "attachment-state-request.stored-v2.schema.json",
  );
  assert.equal(
    attachment.request_body,
    "attachment-state-body.stored-v2.schema.json",
  );
  const release = route("POST", "/internal/agent-networks/{agent_id}/release");
  assert.equal(
    release.request_schema,
    "resource-version-request.stored-v2.schema.json",
  );
  assert.equal(
    release.request_body,
    "resource-version-body.stored-v2.schema.json",
  );
  assert.equal(
    route("PUT", "/internal/agent-policy-assignments/{agent_id}").request_body,
    "policy-assignment-request.stored-v2.schema.json",
  );
});

test("egress stored v2 request schemas bound version tokens to the stored range", async () => {
  const files = [
    "egress/attachment-state-request.stored-v2.schema.json",
    "egress/attachment-state-body.stored-v2.schema.json",
    "egress/resource-version-request.stored-v2.schema.json",
    "egress/resource-version-body.stored-v2.schema.json",
    "egress/policy-assignment-request.stored-v2.schema.json",
  ];
  const base = (ref) =>
    ref.includes("policy-assignment")
      ? { policy_id: "internet-enabled", revision: 3 }
      : ref.includes("attachment-state")
        ? { state: "closed" }
        : {};
  for (const ref of files) {
    const document = base(ref);
    await valid(ref, { ...document, expected_version: "1" });
    await valid(ref, {
      ...document,
      expected_version: "9223372036854775807",
    });
    await valid(ref, {
      ...document,
      expected_version: "9223372036854775806",
    });
    for (const token of [
      "0",
      "01",
      "+1",
      "9223372036854775808",
      "9223372036854775809",
      "9223372036854775899",
      "18446744073709551615",
      "9999999999999999999",
      "abc",
      "",
      "1.5",
      "1\n",
      "1\r",
      "1\r\n",
      "1 ",
      "\n1",
      "1\t",
      "１",
      "１2",
      1,
    ])
      await invalid(ref, { ...document, expected_version: token });
    for (const value of [0, -1])
      await invalid(ref, {
        ...document,
        expected_resource_version: value,
      });
    await valid(ref, {
      ...document,
      expected_resource_version: 9007199254740991,
    });
  }
});

test("egress stored v2 assignment schema bounds the revision integer", async () => {
  const ref = "egress/policy-assignment-request.stored-v2.schema.json";
  const base = { policy_id: "internet-enabled", expected_version: "1" };
  await valid(ref, { ...base, revision: 1 });
  await valid(ref, { ...base, revision: 9007199254740991 });
  for (const revision of [0, -1, "3"])
    await invalid(ref, { ...base, revision });
});

test("egress stored v2 numeric maximum stays the literal stored bound", () => {
  for (const name of [
    "attachment-state-request",
    "attachment-state-body",
    "resource-version-request",
    "resource-version-body",
    "policy-assignment-request",
  ]) {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          `../../../contracts/egress/${name}.stored-v2.schema.json`,
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const match of source.matchAll(/"maximum":\s*(\d+)/g))
      assert.equal(match[1], "9223372036854775807", `${name} maximum`);
    assert.match(source, /"maximum":\s*9223372036854775807/, name);
  }
});

test("historical egress request schemas keep their unchanged N-1 definitions", async () => {
  for (const [ref, document] of [
    [
      "egress/attachment-state-request.schema.json",
      { state: "closed", expected_version: "18446744073709551615" },
    ],
    [
      "egress/attachment-state-body.schema.json",
      { state: "closed", expected_version: "18446744073709551615" },
    ],
    [
      "egress/resource-version-request.schema.json",
      { expected_version: "18446744073709551615" },
    ],
    [
      "egress/resource-version-body.schema.json",
      { expected_version: "18446744073709551615" },
    ],
    [
      "egress/policy-assignment-request.schema.json",
      {
        policy_id: "internet-enabled",
        revision: 3,
        expected_version: "18446744073709551615",
      },
    ],
  ])
    await valid(ref, document);
});

test("egress control status reports ready and degraded shapes", async () => {
  const ref = "egress/control-response.ids-v2.schema.json#/$defs/status";
  const ready = {
    status: "ready",
    data_plane_ready: true,
    control_plane_ready: true,
    snapshot_revision: 12,
  };
  await valid(ref, ready);
  await valid(ref, {
    ...ready,
    status: "degraded",
    data_plane_ready: false,
    snapshot_revision: 0,
  });
});

test("egress control status rejects missing fields and bad values", async () => {
  const ref = "egress/control-response.ids-v2.schema.json#/$defs/status";
  const ready = {
    status: "ready",
    data_plane_ready: true,
    control_plane_ready: true,
    snapshot_revision: 12,
  };
  await invalid(ref, { ...ready, status: "starting" });
  await invalid(ref, { ...ready, status: "unavailable" });
  await invalid(ref, {
    data_plane_ready: true,
    control_plane_ready: true,
    snapshot_revision: 12,
  });
  await invalid(ref, { ...ready, data_plane_ready: "yes" });
  await invalid(ref, { ...ready, snapshot_revision: -1 });
  await invalid(ref, { ...ready, snapshot_revision: "12" });
  await invalid(ref, { ...ready, extra: true });
});

test("runtime skill-maintenance keeps the published learning definitions unchanged", () => {
  const canonical = contract("runtime/skill-maintenance.schema.json");
  const learning = contract("skill-learning/learning-api.ids-v2.schema.json");
  for (const name of [
    "install_request",
    "digest_request",
    "maintenance_receipt",
    "id",
    "request_id",
    "package_path",
    "digest",
  ])
    assert.deepEqual(canonical.$defs[name], learning.$defs[name], name);
});

test("runtime skill-maintenance install and digest requests validate", async () => {
  const installRef =
    "runtime/skill-maintenance.schema.json#/$defs/install_request";
  const digestRef =
    "runtime/skill-maintenance.schema.json#/$defs/digest_request";
  const install = {
    action: "install",
    request_id: "req-1",
    job_id: "job-1",
    generation: 1,
    package_path: ".antnest/skills/review-helper",
    expected_base_digest: null,
    target_digest: DIGEST,
    artifact_digest: DIGEST,
    package_rules_version: 1,
  };
  const digest = {
    action: "digest",
    request_id: "req-2",
    job_id: "job-1",
    generation: 1,
    package_path: ".antnest/skills/review-helper",
  };
  await valid(installRef, install);
  await valid(installRef, { ...install, expected_base_digest: DIGEST });
  await valid(digestRef, digest);
  await valid(
    "skill-learning/learning-api.ids-v2.schema.json#/$defs/install_request",
    install,
  );
  await valid(
    "skill-learning/learning-api.ids-v2.schema.json#/$defs/digest_request",
    digest,
  );
  await invalid(installRef, { ...install, action: "digest" });
  await invalid(installRef, { ...install, package_rules_version: 2 });
  await invalid(installRef, {
    ...install,
    package_path: "skills/review-helper",
  });
  await invalid(installRef, { ...install, generation: 0 });
  await invalid(installRef, { ...install, extra: true });
  await invalid(digestRef, { ...digest, action: "install" });
  await invalid(digestRef, { ...digest, artifact_digest: DIGEST });
  await invalid(digestRef, { ...digest, request_id: "has space" });
});

test("runtime skill-maintenance receipts follow the outcome rules", async () => {
  const ref =
    "runtime/skill-maintenance.schema.json#/$defs/maintenance_receipt";
  const base = { request_id: "req-1", execution_id: "exec-1" };
  await valid(ref, {
    ...base,
    action: "install",
    outcome: "applied",
    observed_digest: DIGEST,
  });
  await valid(ref, {
    ...base,
    action: "install",
    outcome: "conflict",
    observed_digest: null,
    conflict_reason: "target_exists",
  });
  await valid(ref, {
    ...base,
    action: "install",
    outcome: "blocked",
    observed_digest: null,
    blocked_reason: "managed_call_in_flight",
    blocked_subject_id: "managed:indexer-1",
  });
  await valid(ref, {
    ...base,
    action: "install",
    outcome: "preempted",
    observed_digest: null,
  });
  await valid(ref, {
    ...base,
    action: "digest",
    outcome: "observed",
    observed_digest: DIGEST,
  });
  await valid(ref, {
    ...base,
    action: "digest",
    outcome: "blocked",
    observed_digest: null,
    blocked_reason: "foreground_running",
  });
});

test("runtime skill-maintenance receipts reject malformed outcomes", async () => {
  const ref =
    "runtime/skill-maintenance.schema.json#/$defs/maintenance_receipt";
  const base = { request_id: "req-1", execution_id: "exec-1" };
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "observed",
    observed_digest: DIGEST,
  });
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "conflict",
    observed_digest: null,
  });
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "applied",
    observed_digest: DIGEST,
    conflict_reason: "base_changed",
  });
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "blocked",
    observed_digest: null,
  });
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "blocked",
    observed_digest: DIGEST,
    blocked_reason: "foreground_running",
  });
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "blocked",
    observed_digest: null,
    blocked_reason: "background_task_running",
  });
  await invalid(ref, {
    ...base,
    action: "digest",
    outcome: "blocked",
    observed_digest: null,
    blocked_reason: "managed_call_in_flight",
    blocked_subject_id: "managed:indexer-1",
  });
  await invalid(ref, {
    ...base,
    action: "digest",
    outcome: "applied",
    observed_digest: DIGEST,
  });
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "applied",
    observed_digest: "md5:abc",
  });
  await invalid(ref, {
    ...base,
    action: "install",
    outcome: "applied",
    observed_digest: DIGEST,
    extra: true,
  });
});

test("runtime http live_status matches the reduced liveness body", async () => {
  const ref = "runtime/http.schema.json#/$defs/live_status";
  await valid(ref, { status: "ready" });
  await valid(ref, { status: "unavailable" });
  await invalid(ref, {});
  await invalid(ref, { status: "degraded" });
  await invalid(ref, { status: "ready", agent_id: "agent-1" });
});

test("runtime http protocol_request accepts requests and notifications", async () => {
  const ref = "runtime/http.schema.json#/$defs/protocol_request";
  await valid(ref, { jsonrpc: "2.0", method: "tools/list", id: 1 });
  await valid(ref, {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "read", arguments: { path: "/workspace/a" } },
    id: "req-9",
  });
  await valid(ref, { jsonrpc: "2.0", method: "notifications/initialized" });
  await invalid(ref, { jsonrpc: "1.0", method: "tools/list", id: 1 });
  await invalid(ref, { method: "tools/list", id: 1 });
  await invalid(ref, { jsonrpc: "2.0", id: 1 });
  await invalid(ref, { jsonrpc: "2.0", method: "tools/list", id: null });
  await invalid(ref, { jsonrpc: "2.0", method: "tools/list", id: {} });
  await invalid(ref, { jsonrpc: "2.0", method: "tools/list", extra: true });
});

test("runtime http protocol_response carries result or error exactly once", async () => {
  const ref = "runtime/http.schema.json#/$defs/protocol_response";
  await valid(ref, { jsonrpc: "2.0", id: 1, result: { tools: [] } });
  await valid(ref, { jsonrpc: "2.0", id: 2, result: null });
  await valid(ref, {
    jsonrpc: "2.0",
    id: "req-9",
    error: { code: -32602, message: "Invalid params" },
  });
  await valid(ref, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
  await valid(ref, {
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32000, message: "Server error", data: { retryable: true } },
  });
  await invalid(ref, { jsonrpc: "2.0", id: 1 });
  await invalid(ref, { jsonrpc: "2.0", result: {} });
  await invalid(ref, {
    jsonrpc: "2.0",
    id: 1,
    result: {},
    error: { code: -32000, message: "Server error" },
  });
  await invalid(ref, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000 },
  });
  await invalid(ref, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: "-32000", message: "Server error" },
  });
  await invalid(ref, { jsonrpc: "2.0", id: 1, result: {}, extra: true });
});
