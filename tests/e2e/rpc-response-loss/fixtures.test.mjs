import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./model.mjs";
import { seed } from "./setup.mjs";
import { assertReceipts, assertUnacknowledged } from "./evidence.mjs";
const payload = (phase, stdout) => ({
  model: "rpc-model",
  max_tokens: phase.startsWith("v1") ? 3072 : 4096,
  tools: [{ function: { name: "bash" } }],
  messages: [
    { role: "user", content: phase },
    ...(stdout === undefined
      ? []
      : [
          {
            role: "tool",
            content: JSON.stringify({
              stdout,
              exit_code: 0,
              stderr: "",
              truncated: false,
              effect_state: "settled",
            }),
          },
        ]),
  ],
});
test("real append/read and current Model parameters are mandatory", () => {
  for (const version of [1, 2])
    for (const kind of ["apply", "settle"])
      for (const op of ["write", "read"]) {
        const phase = `v${version}-${kind}-${op}`,
          value = payload(phase);
        assert.equal(decide(value).call.name, "bash");
        assert.equal(
          decide(payload(phase, `v${version}-${kind}\n`)).text,
          `${phase} verified`,
        );
        assert.throws(() => decide({ ...value, max_tokens: 1024 }));
        assert.throws(() =>
          decide(payload(phase, `v${version}-${kind}\nv${version}-${kind}\n`)),
        );
        assert.throws(() => decide(payload(phase, "")));
      }
});
test("setup uses public Provider/Model APIs and returned Template revision", async () => {
  const calls = [];
  const result = await seed(async (path, body, status) => {
    calls.push({ path, body, status });
    return path.endsWith("model-profiles")
      ? { items: [{ model_profile_id: "model" }] }
      : { template_id: "template", revision: 5 };
  }, "sha256:image");
  assert.equal(result.template.revision, 5);
  assert.deepEqual(
    calls.map((c) => c.path),
    [
      "/api/admin/provider-connections",
      "/api/admin/model-profiles",
      "/api/admin/templates",
    ],
  );
  assert.equal(calls[2].body.model_profile_id, "model");
  assert.equal(calls[2].body.runtime.image_ref, "sha256:image");
});
function receipt(method = "apply-execution-snapshot") {
  return {
    receipt_id: "first",
    method,
    organization_id: "org",
    revision: 7,
    minimum_revision: 7,
    applied_revision: 7,
    agent_id: "agent",
    operation_id: "op",
    mode: "wait",
    deadline_at: "2026-09-17T12:00:00Z",
    outcome: "settled",
    request_hash: "a".repeat(64),
    response_hash: "b".repeat(64),
    traceparent: "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-01",
    status: 200,
    delivery: "held",
  };
}
test("receipt oracle requires the exact held success, explicit drop and unchanged delivered retry", () => {
  for (const method of ["apply-execution-snapshot", "settle-agent"]) {
    const held = receipt(method),
      rows = [
        { ...held, delivery: "dropped" },
        {
          ...held,
          receipt_id: "second",
          traceparent: "00-" + "1".repeat(32) + "-" + "3".repeat(16) + "-01",
          delivery: "delivered",
        },
      ];
    assertReceipts(held, rows);
    for (const [index, field, value] of [
      [0, "delivery", "expired"],
      [1, "request_hash", "changed"],
      [1, "applied_revision", 8],
      [1, "response_hash", "other"],
      [1, "organization_id", "other"],
      [1, "traceparent", held.traceparent],
      [1, "status", 503],
      ...(method === "settle-agent"
        ? [
            [1, "deadline_at", "later"],
            [1, "operation_id", "other"],
            [1, "outcome", "not_settled"],
          ]
        : []),
    ]) {
      const changed = structuredClone(rows);
      changed[index][field] = value;
      assert.throws(() => assertReceipts(held, changed));
    }
    assert.throws(() => assertReceipts(held, rows.slice(0, 1)));
  }
});
test("held publication cannot imply Controller acknowledgement", () => {
  const held = receipt();
  assertUnacknowledged({ revision: 7, applied_revision: 6 }, held);
  for (const changed of [
    { revision: 6, applied_revision: 6 },
    { revision: 7, applied_revision: 7 },
  ])
    assert.throws(() => assertUnacknowledged(changed, held));
});

function businessReceipts(method, sharedDiagnostic) {
  const held = receipt(method);
  if (sharedDiagnostic) held.traceparent = "unavailable-diagnostic-context";
  else delete held.traceparent;
  return {
    held,
    rows: [
      { ...held, delivery: "dropped" },
      { ...held, receipt_id: "second", delivery: "delivered" },
    ],
  };
}

test("receipt business proof uses independent receipt IDs when Trace is absent or duplicated, keeping default strict", () => {
  for (const method of ["apply-execution-snapshot", "settle-agent"])
    for (const sharedDiagnostic of [false, true]) {
      const { held, rows } = businessReceipts(method, sharedDiagnostic);
      const before = structuredClone({ held, rows });
      assertReceipts(held, rows, { requireTrace: false });
      assert.deepEqual({ held, rows }, before);
      assert.throws(
        () => assertReceipts(held, rows),
        "default Trace policy was relaxed",
      );
    }
});

test("receipt business proof still rejects duplicate attempts, changed hashes, missing delivery and settlement deadline changes", () => {
  for (const mutate of [
    (f) => {
      f.rows[1].receipt_id = f.rows[0].receipt_id;
    },
    (f) => {
      delete f.rows[1].receipt_id;
    },
    (f) => {
      f.rows[1].request_hash = "c".repeat(64);
    },
    (f) => {
      f.rows[1].response_hash = "d".repeat(64);
    },
    (f) => {
      f.rows[1].delivery = "expired";
    },
    (f) => {
      f.rows[1].deadline_at = "2026-09-17T12:01:00Z";
    },
    (f) => f.rows.pop(),
  ]) {
    const f = businessReceipts("settle-agent", false);
    mutate(f);
    assert.throws(() =>
      assertReceipts(f.held, f.rows, { requireTrace: false }),
    );
  }
});
