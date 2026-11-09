import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadGolden, validateGolden } from "./golden.mjs";

const OBSERVATION_ERROR_REF =
  "agent-acp/workspace-bridge.schema.json#/$defs/observationError";
const INTENT_RECEIPT_REF =
  "agent-acp/workspace-bridge.schema.json#/$defs/intentReceipt";
const EXECUTION_OBSERVATION_REF =
  "agent-acp/workspace-bridge.schema.json#/$defs/executionObservation";

const CANONICAL_ENVELOPES = {
  access_denied: { category: "forbidden", retryable: false },
  intent_receipt_expired: { category: "not_found", retryable: false },
  intent_unknown: { category: "not_found" },
  method_not_allowed: { category: "invalid_request", retryable: false },
  session_not_found: { category: "not_found", retryable: false },
  workspace_observation_unavailable: {
    category: "unavailable",
    retryable: true,
  },
};

const envelope = (code, overrides = {}) => ({
  code,
  category: CANONICAL_ENVELOPES[code]?.category ?? "not_found",
  message: "intent lookup rejected",
  retryable: CANONICAL_ENVELOPES[code]?.retryable ?? false,
  request_id: "req-1",
  ...overrides,
});

const contractsFile = (path) =>
  readFileSync(
    fileURLToPath(new URL(`../../../contracts/${path}`, import.meta.url)),
    "utf8",
  );
const bridgeSchema = JSON.parse(
  contractsFile("agent-acp/workspace-bridge.schema.json"),
);
const registry = JSON.parse(contractsFile("common/errors.json"));
const registryEntry = (code) =>
  registry.errors.find((entry) => entry.code === code);

test("observationError is additive over the existing bridge $defs", () => {
  assert.deepEqual(
    Object.keys(bridgeSchema.$defs).sort(),
    [
      "bridgeCapabilities",
      "configurationCondition",
      "deliveryMark",
      "errorClass",
      "executionObservation",
      "id",
      "intentReceipt",
      "loadCut",
      "observationError",
      "promptIntent",
      "revision",
      "targetCancel",
    ].sort(),
  );
});

test("observationError accepts the canonical envelope for every lookup code", async () => {
  for (const code of Object.keys(CANONICAL_ENVELOPES)) {
    assert.equal(
      await validateGolden(OBSERVATION_ERROR_REF, envelope(code)),
      true,
      `expected the canonical ${code} envelope to validate`,
    );
  }
});

test("observationError accepts canonical and legacy intent_unknown retryable", async () => {
  for (const retryable of [true, false]) {
    assert.equal(
      await validateGolden(
        OBSERVATION_ERROR_REF,
        envelope("intent_unknown", { retryable }),
      ),
      true,
      `expected intent_unknown retryable:${retryable} to validate`,
    );
  }
});

test("observationError tolerates future common envelope fields", async () => {
  assert.equal(
    await validateGolden(
      OBSERVATION_ERROR_REF,
      envelope("session_not_found", {
        details: { session: "removed" },
        future_extension: { anything: true },
      }),
    ),
    true,
  );
});

test("observationError rejects codes outside the observation set", async () => {
  for (const code of [
    "internal",
    "agent_busy",
    "intent_already_recorded",
    "intent_key_mismatch",
    "not_found",
    "unregistered_code",
  ]) {
    await assert.rejects(
      () =>
        validateGolden(
          OBSERVATION_ERROR_REF,
          envelope(code, { category: "internal" }),
        ),
      `expected ${code} to be rejected`,
    );
  }
});

test("observationError rejects envelopes missing common fields", async () => {
  for (const field of [
    "code",
    "category",
    "message",
    "retryable",
    "request_id",
  ]) {
    const value = envelope("intent_unknown");
    delete value[field];
    await assert.rejects(
      () => validateGolden(OBSERVATION_ERROR_REF, value),
      `expected a missing ${field} to be rejected`,
    );
  }
});

test("observationError rejects wrong intent_receipt_expired metadata", async () => {
  for (const overrides of [
    { retryable: true },
    { category: "conflict" },
    { category: "unavailable" },
    { category: "invalid_request" },
  ]) {
    await assert.rejects(
      () =>
        validateGolden(
          OBSERVATION_ERROR_REF,
          envelope("intent_receipt_expired", overrides),
        ),
      `expected intent_receipt_expired ${JSON.stringify(overrides)} to be rejected`,
    );
  }
});

test("observationError keeps each remaining code at its registered metadata", async () => {
  const mismatches = [
    ["access_denied", { category: "not_found" }],
    ["access_denied", { retryable: true }],
    ["method_not_allowed", { category: "unavailable" }],
    ["method_not_allowed", { retryable: true }],
    ["session_not_found", { category: "conflict" }],
    ["session_not_found", { retryable: true }],
    ["workspace_observation_unavailable", { category: "not_found" }],
    ["workspace_observation_unavailable", { retryable: false }],
    ["intent_unknown", { category: "conflict" }],
  ];
  for (const [code, overrides] of mismatches) {
    await assert.rejects(
      () => validateGolden(OBSERVATION_ERROR_REF, envelope(code, overrides)),
      `expected ${code} ${JSON.stringify(overrides)} to be rejected`,
    );
  }
});

test("success schemas are unchanged and an error envelope is not a receipt", async () => {
  assert.equal(
    await validateGolden(
      INTENT_RECEIPT_REF,
      loadGolden("agent-acp", "workspace-intent.running.json"),
    ),
    true,
  );
  assert.equal(
    await validateGolden(
      EXECUTION_OBSERVATION_REF,
      loadGolden("agent-acp", "workspace-execution.running.json"),
    ),
    true,
  );
  for (const code of Object.keys(CANONICAL_ENVELOPES)) {
    await assert.rejects(
      () => validateGolden(INTENT_RECEIPT_REF, envelope(code)),
      `expected the ${code} envelope to fail intentReceipt`,
    );
  }
});

test("registry declares intent_receipt_expired with expired metadata", () => {
  const entry = registryEntry("intent_receipt_expired");
  assert.ok(entry, "registry must declare intent_receipt_expired");
  assert.equal(entry.owner, "agent-acp-service");
  assert.equal(entry.category, "not_found");
  assert.equal(entry.http_status, 410);
  assert.equal(entry.retryable, false);
  assert.equal(typeof entry.description, "string");
  assert.notEqual(entry.description, "");
});

test("agent-ui and agent-acp-service slices expose intent_receipt_expired", () => {
  for (const service of ["agent-ui", "agent-acp-service"]) {
    const slice = JSON.parse(contractsFile(`common/slices/${service}.json`));
    assert.equal(slice.service, service);
    assert.ok(
      slice.codes.includes("intent_receipt_expired"),
      `${service} slice must list intent_receipt_expired`,
    );
  }
});

test("registry declares canonical lookup-retryable intent_unknown metadata", () => {
  const entry = registryEntry("intent_unknown");
  assert.ok(entry, "registry must declare intent_unknown");
  assert.equal(entry.owner, "agent-acp-service");
  assert.equal(entry.category, "not_found");
  assert.equal(entry.http_status, 404);
  assert.equal(
    entry.retryable,
    true,
    "retryable:true authorizes repeating the lookup only, never the Prompt",
  );
});
