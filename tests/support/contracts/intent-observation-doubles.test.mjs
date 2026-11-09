import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateGolden } from "./golden.mjs";
import { intentObservationFailure } from "../intent-observation.mjs";

const OBSERVATION_ERROR_REF =
  "agent-acp/workspace-bridge.schema.json#/$defs/observationError";

const contractsFile = (path) =>
  readFileSync(
    fileURLToPath(new URL(`../../../contracts/${path}`, import.meta.url)),
    "utf8",
  );
const catalog = JSON.parse(contractsFile("agent-acp/errors.json"));
const registry = JSON.parse(contractsFile("common/errors.json"));
const registryEntry = (code) =>
  registry.errors.find((entry) => entry.code === code);

const SIX = [
  "access_denied",
  "intent_receipt_expired",
  "intent_unknown",
  "method_not_allowed",
  "session_not_found",
  "workspace_observation_unavailable",
];

test("intentObservationFailure emits catalog-canonical envelopes for all six observation codes", async () => {
  for (const code of SIX) {
    const { status, body } = intentObservationFailure(code);
    assert.equal(status, catalog.errors[code].http_status, code);
    assert.deepEqual(
      body,
      {
        code,
        category: registryEntry(code).category,
        message: catalog.errors[code].message,
        retryable: catalog.errors[code].retryable,
        request_id: "fixture-intent-observation",
      },
      code,
    );
    await validateGolden(OBSERVATION_ERROR_REF, body);
  }
});

test("canonical intent_unknown is 404 retryable true and expired is 410 retryable false", () => {
  const unknown = intentObservationFailure("intent_unknown");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.retryable, true);
  const expired = intentObservationFailure("intent_receipt_expired");
  assert.equal(expired.status, 410);
  assert.equal(expired.body.retryable, false);
});

test("custom request_id is honored and unsafe ids or codes outside the schema enum are rejected", () => {
  const { body } = intentObservationFailure(
    "session_not_found",
    "req-custom-1",
  );
  assert.equal(body.request_id, "req-custom-1");
  assert.throws(() => intentObservationFailure("intent_key_mismatch"));
  assert.throws(() => intentObservationFailure("internal_error"));
  for (const bad of ["", "has space", "x".repeat(129), 42]) {
    assert.throws(
      () => intentObservationFailure("intent_unknown", bad),
      /request_id|request id|unsafe|invalid/i,
    );
  }
});

test("mutating the emitted envelope fails the published observationError schema", async () => {
  const { body } = intentObservationFailure("intent_receipt_expired");
  await assert.rejects(
    validateGolden(OBSERVATION_ERROR_REF, { ...body, category: "conflict" }),
  );
  await assert.rejects(
    validateGolden(OBSERVATION_ERROR_REF, { ...body, retryable: true }),
  );
  await assert.rejects(
    validateGolden(OBSERVATION_ERROR_REF, { ...body, code: "internal_error" }),
  );
  const { request_id: _drop, ...withoutId } = body;
  await assert.rejects(validateGolden(OBSERVATION_ERROR_REF, withoutId));
});
