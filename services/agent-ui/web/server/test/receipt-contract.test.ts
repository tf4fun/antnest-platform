import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  parseIntentObservation,
  parseExecutionObservation,
} from "../src/adapters/acp-http.ts";
import { operationFromReceipt } from "../src/bridge/operations.ts";

const requireAcp = createRequire(
  new URL("../../../../agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../contracts/agent-acp/workspace-bridge.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../tests/support/fixtures/agent-acp/bridge-receipts.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  valid: { name: string; receipt: unknown }[];
  invalid: { name: string; receipt: unknown }[];
};
const validReceipt = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/intentReceipt",
});
const validObservation = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/executionObservation",
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const execution = (receipt: unknown) => ({
  sessionId: "session-1",
  appendVersion: 2,
  outputWatermark: 4,
  activeRunId: null,
  recentReceipts: [receipt],
  configurationRevision: "a".repeat(64),
});

test("the real receipt parser accepts every central-schema fixture and preserves open classifications", async () => {
  for (const fixture of fixtures.valid) {
    assert.equal(validReceipt(fixture.receipt), true, fixture.name);
    const actual = await parseIntentObservation(response(fixture.receipt));
    assert.equal(actual.kind, "receipt");
    if (actual.kind !== "receipt")
      throw new Error("Expected a durable receipt");
    assert.deepEqual(actual.receipt, fixture.receipt, fixture.name);
    const observation = execution(fixture.receipt);
    assert.equal(validObservation(observation), true, fixture.name);
    assert.deepEqual(
      await parseExecutionObservation(response(observation)),
      observation,
      fixture.name,
    );
    const operation = operationFromReceipt(actual.receipt);
    assert.equal(Object.hasOwn(operation, "errorClass"), true, fixture.name);
    assert.equal(operation.errorClass, actual.receipt.errorClass, fixture.name);
  }
});

test("the real receipt parser rejects every central-schema invalid fixture", async () => {
  for (const fixture of fixtures.invalid) {
    assert.equal(validReceipt(fixture.receipt), false, fixture.name);
    await assert.rejects(
      () => parseIntentObservation(response(fixture.receipt)),
      fixture.name,
    );
    const observation = execution(fixture.receipt);
    assert.equal(validObservation(observation), false, fixture.name);
    await assert.rejects(
      () => parseExecutionObservation(response(observation)),
      fixture.name,
    );
  }
});
