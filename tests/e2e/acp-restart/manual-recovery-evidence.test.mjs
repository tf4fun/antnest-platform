import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

const implementation = new URL(
  "./manual-recovery-evidence.mjs",
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

function admission(stage) {
  const name =
    stage === "pending"
      ? "assertPendingRecoveryEvidence"
      : "assertManualRecoveryEvidence";
  assert.equal(
    typeof recoveryEvidence[name],
    "function",
    `${name} admission API is required`,
  );
  return recoveryEvidence[name];
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
function fingerprint(requestID, expected, actor = expected.actor_principal_id) {
  return digest(
    JSON.stringify({
      RequestID: requestID,
      OrganizationID: expected.organization_id,
      ActorPrincipalID: actor,
      AgentID: expected.agent_id,
      TemplateID: expected.source.template_id,
      TemplateRevision: expected.source.template_revision,
    }),
  );
}

function fixture(mode = "manual", stage = "completed") {
  const barrierID = "barrier-browser-\0-e\u0301-🧪";
  const runtimeExecutionID = "runtime-execution-original-执行";
  const expected = {
    organization_id: "organization-restart",
    agent_id: "agent_" + "1".repeat(32),
    actor_principal_id: "admin-user",
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
      mode,
      cooldown_ms: 300000,
    },
  };
  const tuple = JSON.stringify([
    expected.organization_id,
    expected.agent_id,
    barrierID,
  ]);
  const identity = digest("runtime-barrier-recovery\0" + tuple).slice(0, 32);
  const requestID = "rebuild_" + identity;
  const commandFingerprint = fingerprint(requestID, expected);
  const barrierHex = Buffer.from(barrierID, "utf8").toString("hex");
  const executionHex = Buffer.from(runtimeExecutionID, "utf8").toString("hex");
  const acceptedAt = "2026-10-23T02:00:00.123456+00:00";
  const cooldownUntil = "2026-10-23T02:05:00.123456+00:00";
  const cycle = {
    barrier_hex: barrierHex,
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    runtime_revision: expected.source.runtime_revision,
    runtime_execution_hex: executionHex,
    created_at: "2026-10-23T02:00:00.000001+00:00",
    retired_at: stage === "pending" ? null : "2026-10-23T02:00:03.456789+00:00",
  };
  const receipt = {
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    barrier_hex: barrierHex,
    runtime_revision: expected.source.runtime_revision,
    runtime_execution_hex: executionHex,
    reason: "runtime_barrier_required",
    request_id: requestID,
    request_fingerprint: commandFingerprint,
    actor_principal_id: expected.actor_principal_id,
    manual: true,
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
    operation_fingerprint: commandFingerprint,
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
  const observation = {
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    barrier_hex: barrierHex,
    runtime_execution_hex: executionHex,
    runtime_revision: expected.source.runtime_revision,
    policy_revision: expected.policy.revision,
    policy_mode: expected.policy.mode,
    policy_cooldown_ms: expected.policy.cooldown_ms,
    observation_revision: 1,
    observed_at: "2026-10-23T02:00:00.100001+00:00",
  };
  const notification = {
    organization_id: expected.organization_id,
    agent_id: expected.agent_id,
    barrier_hex: barrierHex,
    runtime_revision: expected.source.runtime_revision,
    policy_revision: expected.policy.revision,
    event_id: "notification_" + identity,
    journal_agent_id: expected.agent_id,
    event_type: "agent_runtime_barrier_required",
    schema_version: 1,
    operation_request_id: "",
    data: {
      organization_id: expected.organization_id,
      runtime_revision: expected.source.runtime_revision,
      reason: "runtime_barrier_required",
      policy_revision: expected.policy.revision,
    },
    occurred_at: "2026-10-23T02:00:00.100001+00:00",
  };
  const data = {
    cycles: [cycle],
    receipts: stage === "pending" ? [] : [receipt],
    rebuilds: stage === "pending" ? [] : [{ request_id: requestID }],
    starts:
      stage === "pending"
        ? []
        : [{ request_id: requestID, started_at: receipt.started_at }],
    notifications: mode === "notify" ? [notification] : [],
  };
  // Completed recovery may have replaced its binding and cleared observation.
  if (stage === "pending") data.observations = [observation];
  return { data, expected };
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function reject(stage, input, label) {
  // An absent API must fail the test, not satisfy a negative evidence case.
  const check = admission(stage);
  assert.throws(() => check(input.data, input.expected), undefined, label);
}

test("manual browser recovery exposes pending and completed business admission APIs", () => {
  admission("pending");
  admission("completed");
});

for (const mode of ["manual", "notify"]) {
  for (const stage of ["pending", "completed"]) {
    test(`${mode} browser recovery admits complete ${stage} inventories without mutation`, () => {
      const input = fixture(mode, stage);
      const before = structuredClone(input);
      freeze(input);
      const result = admission(stage)(input.data, input.expected);
      if (stage === "completed")
        assert.deepEqual(result, input.data.receipts[0]);
      assert.deepEqual(input, before);
    });
  }
}

for (const stage of ["pending", "completed"]) {
  test(`${stage} recovery requires every complete inventory`, () => {
    const collections = [
      "cycles",
      "receipts",
      "rebuilds",
      "starts",
      "notifications",
    ];
    if (stage === "pending") collections.push("observations");
    for (const collection of collections) {
      const input = fixture("notify", stage);
      delete input.data[collection];
      reject(stage, input, `missing ${collection} inventory`);
      if (
        stage === "completed" ||
        ["cycles", "observations", "notifications"].includes(collection)
      ) {
        const empty = fixture("notify", stage);
        empty.data[collection] = [];
        reject(stage, empty, `empty ${collection} inventory`);
      }
    }
  });
  test(`${stage} recovery rejects a duplicate ACP cycle`, () => {
    const input = fixture("manual", stage);
    input.data.cycles.push(structuredClone(input.data.cycles[0]));
    reject(stage, input);
  });
}

test("pending recovery rejects any admitted receipt, Rebuild or pending start", () => {
  for (const collection of ["receipts", "rebuilds", "starts"]) {
    const input = fixture("notify", "pending");
    input.data[collection] = fixture("notify").data[collection];
    reject("pending", input, `premature ${collection}`);
  }
});

test("completed recovery rejects duplicate receipt, Rebuild and start inventories", () => {
  for (const collection of ["receipts", "rebuilds", "starts"]) {
    const input = fixture();
    input.data[collection].push(structuredClone(input.data[collection][0]));
    reject("completed", input, `duplicate ${collection}`);
  }
});

test("pending recovery requires exactly one persisted observation", () => {
  for (const duplicate of [false, true]) {
    const input = fixture("notify", "pending");
    input.data.observations = duplicate
      ? [
          input.data.observations[0],
          structuredClone(input.data.observations[0]),
        ]
      : [];
    reject("pending", input);
  }
});

test("manual mode rejects any notification before or after recovery", () => {
  for (const stage of ["pending", "completed"]) {
    const input = fixture("manual", stage);
    input.data.notifications = fixture("notify", stage).data.notifications;
    reject(stage, input);
  }
});

test("notify mode rejects missing or duplicate notification rows in both phases", () => {
  for (const stage of ["pending", "completed"]) {
    for (const duplicate of [false, true]) {
      const input = fixture("notify", stage);
      input.data.notifications = duplicate
        ? [
            input.data.notifications[0],
            structuredClone(input.data.notifications[0]),
          ]
        : [];
      reject(stage, input);
    }
  }
});

test("recovery rejects a foreign organization even when persisted inventories agree", () => {
  for (const stage of ["pending", "completed"]) {
    const input = fixture("notify", stage);
    for (const collection of [
      "cycles",
      "receipts",
      "observations",
      "notifications",
    ])
      for (const row of input.data[collection] ?? [])
        row.organization_id = "foreign";
    if (input.data.notifications[0])
      input.data.notifications[0].data.organization_id = "foreign";
    reject(stage, input);
  }
});

test("pending observation must match the original Agent, barrier and Runtime binding", () => {
  for (const field of [
    "organization_id",
    "agent_id",
    "barrier_hex",
    "runtime_execution_hex",
    "runtime_revision",
  ]) {
    const input = fixture("manual", "pending");
    input.data.observations[0][field] = field.endsWith("_hex")
      ? "666f726569676e"
      : "foreign";
    reject("pending", input, `wrong observation ${field}`);
  }
});

test("pending observation requires the exact frozen policy and organization", () => {
  for (const [field, value] of [
    ["policy_revision", 8],
    ["policy_mode", "auto"],
    ["policy_cooldown_ms", 60000],
  ]) {
    const input = fixture("notify", "pending");
    input.data.observations[0][field] = value;
    reject("pending", input, `wrong observation ${field}`);
  }
  const input = fixture("manual", "pending");
  input.expected.policy.organization_id = "foreign";
  reject("pending", input, "foreign policy expectation");
});

test("notify evidence requires the original stable notification identity", () => {
  for (const stage of ["pending", "completed"]) {
    const input = fixture("notify", stage);
    input.data.notifications[0].event_id = "notification_" + "f".repeat(32);
    reject(stage, input);
  }
});

test("notify evidence rejects changed or expanded public event payload", () => {
  for (const stage of ["pending", "completed"]) {
    for (const [field, value] of [
      ["organization_id", "foreign"],
      ["runtime_revision", "foreign"],
      ["reason", "agent_unavailable"],
      ["policy_revision", 8],
      ["barrier_id", "must-not-be-in-JSONB"],
    ]) {
      const input = fixture("notify", stage);
      input.data.notifications[0].data[field] = value;
      reject(stage, input, `wrong notification payload ${field}`);
    }
  }
});

test("notify evidence retains the v1 notification-only envelope", () => {
  for (const stage of ["pending", "completed"]) {
    for (const [field, value] of [
      ["event_type", "agent_rebuild_requested"],
      ["schema_version", 2],
      ["operation_request_id", "not-a-notification"],
      ["occurred_at", "not-a-time"],
    ]) {
      const input = fixture("notify", stage);
      input.data.notifications[0][field] = value;
      reject(stage, input, `wrong notification ${field}`);
    }
  }
});

test("notify rows must match the exact Agent, barrier, Runtime and policy", () => {
  for (const stage of ["pending", "completed"]) {
    for (const [field, value] of [
      ["organization_id", "foreign"],
      ["agent_id", "foreign"],
      ["barrier_hex", "666f726569676e"],
      ["runtime_revision", "foreign"],
      ["policy_revision", 8],
    ]) {
      const input = fixture("notify", stage);
      input.data.notifications[0][field] = value;
      reject(stage, input, `wrong notification row ${field}`);
    }
  }
});

test("completed browser recovery must persist explicit manual provenance", () => {
  const input = fixture();
  input.data.receipts[0].manual = false;
  reject("completed", input);
});

test("completed browser recovery rejects a different actor even with matching fingerprints", () => {
  const input = fixture("notify");
  const receipt = input.data.receipts[0];
  receipt.actor_principal_id = "agent-controller";
  receipt.request_fingerprint = fingerprint(
    receipt.request_id,
    input.expected,
    receipt.actor_principal_id,
  );
  receipt.operation_fingerprint = receipt.request_fingerprint;
  reject("completed", input);
});

test("completed browser recovery independently verifies the original command fingerprint", () => {
  const input = fixture();
  input.data.receipts[0].request_fingerprint = "0".repeat(64);
  input.data.receipts[0].operation_fingerprint = "0".repeat(64);
  reject("completed", input);
});

test("completed browser recovery rejects a coherent but different request identity", () => {
  const input = fixture("notify");
  const requestID = "rebuild_" + "f".repeat(32);
  const receipt = input.data.receipts[0];
  receipt.request_id = requestID;
  receipt.cooldown_request_id = requestID;
  receipt.request_fingerprint = fingerprint(requestID, input.expected);
  receipt.operation_fingerprint = receipt.request_fingerprint;
  input.data.rebuilds[0].request_id = requestID;
  input.data.starts[0].request_id = requestID;
  reject("completed", input);
});

test("completed browser recovery rejects an unconfirmed actual start", () => {
  const input = fixture();
  input.data.receipts[0].started_at = null;
  input.data.starts[0].started_at = null;
  reject("completed", input);
});

test("completed browser recovery requires exact start request and timestamp inventory", () => {
  for (const [field, value] of [
    ["request_id", "rebuild_" + "f".repeat(32)],
    ["started_at", "2026-10-23T02:00:01.234568+00:00"],
  ]) {
    const input = fixture("notify");
    input.data.starts[0][field] = value;
    reject("completed", input, `wrong start ${field}`);
  }
});

test("pending evidence rejects a cycle already retired before the browser action", () => {
  const input = fixture("manual", "pending");
  input.data.cycles[0].retired_at = "2026-10-23T02:00:03.456789+00:00";
  reject("pending", input);
});

test("completed evidence rejects an original cycle that remains live", () => {
  const input = fixture();
  input.data.cycles[0].retired_at = null;
  reject("completed", input);
});

test("manual recovery preserves original lifecycle, source and frozen cooldown admission", () => {
  for (const [field, value] of [
    ["source_execution_revision_id", "foreign"],
    ["source_runtime_revision", "foreign"],
    ["source_template_id", "foreign"],
    ["target_template_revision", 5],
    ["policy_mode", "auto"],
    ["policy_revision", 8],
    ["policy_cooldown_ms", 60000],
    ["kind", "create"],
    ["state", "running"],
    ["phase", "drain"],
    ["requested_events", 2],
    ["requested_reason", "manual"],
    ["cooldown_exact", false],
    ["operation_created_at", "2026-10-23T02:00:00.123457+00:00"],
    ["saved_cooldown_until", "2026-10-23T02:05:00.123457+00:00"],
  ]) {
    const input = fixture("notify");
    input.data.receipts[0][field] = value;
    reject("completed", input, `changed original receipt ${field}`);
  }
});

test("notification extension cannot point at another Agent journal event", () => {
  for (const stage of ["pending", "completed"]) {
    const input = fixture("notify", stage);
    input.data.notifications[0].journal_agent_id = "foreign-agent";
    reject(stage, input);
  }
});

test("orphan notification journal entries remain in the complete inventory", () => {
  for (const mode of ["manual", "notify"]) {
    const input = fixture(mode, "pending");
    input.data.notifications.push({
      journal_agent_id: input.expected.agent_id,
      event_type: "agent_runtime_barrier_required",
      event_id: "orphan",
      organization_id: null,
    });
    reject("pending", input);
  }
});
