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
  const ref = "egress/policy-assignment-request.schema.json";
  const base = { policy_id: "internet-enabled", revision: 3 };
  await valid(ref, { ...base, expected_version: "7" });
  await valid(ref, { ...base, expected_resource_version: 7 });
  await valid(ref, base);
});

test("egress policy assignment request rejects conflicting and null preconditions", async () => {
  const ref = "egress/policy-assignment-request.schema.json";
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
  const ref = "egress/policy-assignment-request.schema.json";
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
  const ref = "egress/policy-assignment-request.schema.json";
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

test("egress control status reports ready and degraded shapes", async () => {
  const ref = "egress/control-response.schema.json#/$defs/status";
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
  const ref = "egress/control-response.schema.json#/$defs/status";
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
  const learning = contract("skill-learning/learning-api.schema.json");
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
    "skill-learning/learning-api.schema.json#/$defs/install_request",
    install,
  );
  await valid(
    "skill-learning/learning-api.schema.json#/$defs/digest_request",
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
