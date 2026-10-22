import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

const implementation = new URL(
  "./automatic-recovery-evidence.mjs",
  import.meta.url,
);
let recoveryEvidence = {};
try {
  recoveryEvidence = await import(implementation.href);
} catch (error) {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    error.url !== implementation.href
  )
    throw error;
}

function admission() {
  assert.equal(
    typeof recoveryEvidence.assertAutomaticRecoveryEvidence,
    "function",
    "automatic recovery evidence admission API is required",
  );
  return recoveryEvidence.assertAutomaticRecoveryEvidence;
}

function fixture({
  barrierID = "barrier-restart-original",
  runtimeExecutionID = "runtime-execution-original",
} = {}) {
  const expected = {
    organization_id: "organization-restart",
    agent_id: "agent_" + "1".repeat(32),
    source: {
      runtime_revision: "runtime_" + "2".repeat(32),
      runtime_execution_id: runtimeExecutionID,
      template_id: "template_" + "3".repeat(32),
      template_revision: 4,
      execution_revision: "execution_" + "4".repeat(32),
    },
    policy: {
      organization_id: "organization-restart",
      revision: 7,
      mode: "auto",
      cooldown_ms: 300000,
    },
  };
  const tuple = JSON.stringify([
    expected.organization_id,
    expected.agent_id,
    barrierID,
  ]);
  const requestID =
    "rebuild_" +
    createHash("sha256")
      .update("runtime-barrier-recovery\0" + tuple)
      .digest("hex")
      .slice(0, 32);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        RequestID: requestID,
        OrganizationID: expected.organization_id,
        ActorPrincipalID: "agent-controller",
        AgentID: expected.agent_id,
        TemplateID: expected.source.template_id,
        TemplateRevision: expected.source.template_revision,
      }),
    )
    .digest("hex");
  const acceptedAt = "2026-10-23T02:00:00.123456+00:00";
  const cooldownUntil = "2026-10-23T02:05:00.123456+00:00";
  const barrierHex = Buffer.from(barrierID, "utf8").toString("hex");
  const executionHex = Buffer.from(runtimeExecutionID, "utf8").toString("hex");
  const cycle = {
    barrier_hex: barrierHex,
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    runtime_revision: expected.source.runtime_revision,
    runtime_execution_hex: executionHex,
    created_at: "2026-10-23T02:00:00.000001+00:00",
    retired_at: "2026-10-23T02:00:03.456789+00:00",
  };
  const receipt = {
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    barrier_hex: barrierHex,
    runtime_revision: expected.source.runtime_revision,
    runtime_execution_hex: executionHex,
    reason: "runtime_barrier_required",
    request_id: requestID,
    request_fingerprint: fingerprint,
    actor_principal_id: "agent-controller",
    template_id: expected.source.template_id,
    template_revision: expected.source.template_revision,
    policy_revision: expected.policy.revision,
    policy_mode: expected.policy.mode,
    policy_cooldown_ms: expected.policy.cooldown_ms,
    accepted_at: acceptedAt,
    cooldown_until: cooldownUntil,
    kind: "rebuild",
    phase: "completed",
    state: "completed",
    operation_fingerprint: fingerprint,
    source_spec_revision_id: "spec_" + "5".repeat(32),
    source_execution_revision_id: expected.source.execution_revision,
    source_runtime_revision: expected.source.runtime_revision,
    target_spec_revision_id: "spec_" + "6".repeat(32),
    operation_created_at: acceptedAt,
    source_template_id: expected.source.template_id,
    source_template_revision: expected.source.template_revision,
    target_template_id: expected.source.template_id,
    target_template_revision: expected.source.template_revision,
    cooldown_request_id: requestID,
    cooldown_accepted_at: acceptedAt,
    saved_cooldown_until: cooldownUntil,
    started_at: "2026-10-23T02:00:01.234567+00:00",
    cooldown_exact: true,
    requested_events: 1,
    requested_reason: "runtime_barrier_required",
    requested_at: acceptedAt,
  };
  return {
    expected,
    data: {
      cycles: [cycle],
      receipts: [receipt],
      rebuilds: [{ request_id: requestID }],
    },
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("automatic recovery evidence requires its business admission API", () => {
  admission();
});

test("automatic recovery admits the unique retired cycle and completed original receipt without mutation", () => {
  const admit = admission();
  const { data, expected } = fixture();
  const before = structuredClone({ data, expected });
  freeze(data);
  freeze(expected);
  const receipt = admit(data, expected);
  assert.deepEqual(receipt, data.receipts[0]);
  assert.deepEqual({ data, expected }, before);
});

test("automatic recovery preserves opaque UTF-8 barrier and original Runtime execution identities", () => {
  const admit = admission();
  const { data, expected } = fixture({
    barrierID: "barrier:恢复/α?cycle=原",
    runtimeExecutionID: "runtime:执行/β?instance=旧",
  });
  const before = structuredClone({ data, expected });
  assert.deepEqual(admit(data, expected), data.receipts[0]);
  assert.deepEqual({ data, expected }, before);
});

for (const collection of ["cycles", "receipts", "rebuilds"]) {
  for (const [name, modify] of [
    ["missing inventory", (data) => delete data[collection]],
    ["empty inventory", (data) => (data[collection] = [])],
    [
      "duplicate row",
      (data) => data[collection].push(structuredClone(data[collection][0])),
    ],
    [
      "additional unrelated row",
      (data) => {
        const extra = structuredClone(data[collection][0]);
        if (collection === "cycles") extra.barrier_hex = "666f726569676e";
        else extra.request_id = "rebuild_" + "f".repeat(32);
        data[collection].push(extra);
      },
    ],
  ]) {
    test(`automatic recovery rejects ${collection}: ${name}`, () => {
      const admit = admission();
      const { data, expected } = fixture();
      modify(data);
      assert.throws(() => admit(data, expected));
    });
  }
}

const rejectedEvidence = [
  [
    "cycle organization",
    ({ data }) => (data.cycles[0].organization_id = "foreign"),
  ],
  ["cycle Agent", ({ data }) => (data.cycles[0].agent_id = "foreign")],
  [
    "cycle Runtime revision",
    ({ data }) => (data.cycles[0].runtime_revision = "foreign"),
  ],
  [
    "cycle original execution",
    ({ data }) => (data.cycles[0].runtime_execution_hex = "666f726569676e"),
  ],
  ["unretired cycle", ({ data }) => (data.cycles[0].retired_at = null)],
  ["empty retirement receipt", ({ data }) => (data.cycles[0].retired_at = "")],
  [
    "barrier identity mismatch",
    ({ data }) => (data.receipts[0].barrier_hex = "666f726569676e"),
  ],
  [
    "missing barrier identity",
    ({ data }) => (data.receipts[0].barrier_hex = ""),
  ],
  [
    "receipt organization",
    ({ data }) => (data.receipts[0].organization_id = "foreign"),
  ],
  ["receipt Agent", ({ data }) => (data.receipts[0].agent_id = "foreign")],
  [
    "receipt Runtime revision",
    ({ data }) => (data.receipts[0].runtime_revision = "foreign"),
  ],
  [
    "receipt original execution",
    ({ data }) => (data.receipts[0].runtime_execution_hex = "666f726569676e"),
  ],
  [
    "coherent but wrong original execution",
    ({ data }) => {
      data.cycles[0].runtime_execution_hex = "666f726569676e";
      data.receipts[0].runtime_execution_hex = "666f726569676e";
    },
  ],
  [
    "malformed opaque execution bytes",
    ({ data }) => {
      data.cycles[0].runtime_execution_hex = "not-hex";
      data.receipts[0].runtime_execution_hex = "not-hex";
    },
  ],
  [
    "wrong barrier reason",
    ({ data }) => (data.receipts[0].reason = "agent_unavailable"),
  ],
  [
    "manual actor disguised as auto",
    ({ data }) => (data.receipts[0].actor_principal_id = "admin-user"),
  ],
  ["manual policy", ({ data }) => (data.receipts[0].policy_mode = "manual")],
  ["notify policy", ({ data }) => (data.receipts[0].policy_mode = "notify")],
  ["wrong policy revision", ({ data }) => data.receipts[0].policy_revision++],
  [
    "wrong frozen cooldown",
    ({ data }) => (data.receipts[0].policy_cooldown_ms = 60000),
  ],
  [
    "cross-organization policy expectation",
    ({ expected }) => (expected.policy.organization_id = "foreign"),
  ],
  [
    "receipt template",
    ({ data }) => (data.receipts[0].template_id = "foreign"),
  ],
  [
    "receipt template revision",
    ({ data }) => data.receipts[0].template_revision++,
  ],
  [
    "source configured template",
    ({ data }) => (data.receipts[0].source_template_id = "foreign"),
  ],
  [
    "source configured template revision",
    ({ data }) => data.receipts[0].source_template_revision++,
  ],
  [
    "target template",
    ({ data }) => (data.receipts[0].target_template_id = "foreign"),
  ],
  [
    "target template revision",
    ({ data }) => data.receipts[0].target_template_revision++,
  ],
  [
    "source execution revision",
    ({ data }) => (data.receipts[0].source_execution_revision_id = "foreign"),
  ],
  [
    "source Runtime revision",
    ({ data }) => (data.receipts[0].source_runtime_revision = "foreign"),
  ],
  ["non-Rebuild operation", ({ data }) => (data.receipts[0].kind = "create")],
  ["running operation", ({ data }) => (data.receipts[0].state = "running")],
  ["failed operation", ({ data }) => (data.receipts[0].state = "failed")],
  [
    "incomplete operation phase",
    ({ data }) => (data.receipts[0].phase = "drain"),
  ],
  ["unconfirmed start", ({ data }) => (data.receipts[0].started_at = null)],
  [
    "empty start confirmation",
    ({ data }) => (data.receipts[0].started_at = ""),
  ],
  [
    "operation fingerprint mismatch",
    ({ data }) => (data.receipts[0].operation_fingerprint = "0".repeat(64)),
  ],
  [
    "missing receipt fingerprint",
    ({ data }) => (data.receipts[0].request_fingerprint = ""),
  ],
  [
    "malformed matching fingerprints",
    ({ data }) => {
      data.receipts[0].request_fingerprint = "not-a-fingerprint";
      data.receipts[0].operation_fingerprint = "not-a-fingerprint";
    },
  ],
  [
    "missing requested event",
    ({ data }) => (data.receipts[0].requested_events = 0),
  ],
  [
    "duplicate requested event",
    ({ data }) => (data.receipts[0].requested_events = 2),
  ],
  [
    "missing requested reason",
    ({ data }) => delete data.receipts[0].requested_reason,
  ],
  [
    "wrong requested reason",
    ({ data }) => (data.receipts[0].requested_reason = "manual"),
  ],
  [
    "requested event acceptance time",
    ({ data }) =>
      (data.receipts[0].requested_at = "2026-10-23T02:00:00.123457+00:00"),
  ],
  [
    "operation acceptance time",
    ({ data }) =>
      (data.receipts[0].operation_created_at =
        "2026-10-23T02:00:00.123457+00:00"),
  ],
  [
    "cooldown acceptance time",
    ({ data }) =>
      (data.receipts[0].cooldown_accepted_at =
        "2026-10-23T02:00:00.123457+00:00"),
  ],
  [
    "cooldown deadline mismatch",
    ({ data }) =>
      (data.receipts[0].saved_cooldown_until =
        "2026-10-23T02:05:00.123457+00:00"),
  ],
  [
    "database cooldown arithmetic mismatch",
    ({ data }) => (data.receipts[0].cooldown_exact = false),
  ],
  [
    "unproven database cooldown arithmetic",
    ({ data }) => (data.receipts[0].cooldown_exact = null),
  ],
  [
    "wrong cooldown request",
    ({ data }) =>
      (data.receipts[0].cooldown_request_id = "rebuild_" + "f".repeat(32)),
  ],
  [
    "wrong complete Rebuild inventory request",
    ({ data }) => (data.rebuilds[0].request_id = "rebuild_" + "f".repeat(32)),
  ],
  [
    "receipt request mismatch",
    ({ data }) => (data.receipts[0].request_id = "rebuild_" + "f".repeat(32)),
  ],
  [
    "empty matching request identities",
    ({ data }) => {
      data.receipts[0].request_id = "";
      data.receipts[0].cooldown_request_id = "";
      data.rebuilds[0].request_id = "";
    },
  ],
];

for (const [name, modify] of rejectedEvidence) {
  test(`automatic recovery rejects ${name}`, () => {
    const admit = admission();
    const input = fixture();
    modify(input);
    assert.throws(() => admit(input.data, input.expected));
  });
}
