import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseReceiver, validateToken, authenticateFields, validateMode } from "../src/adapters/service-authentication.ts";
import { parseKeys, verifyCallerContext } from "../src/adapters/caller-context.ts";

const tokens = JSON.parse(readFileSync(new URL("../../../../../contracts/platform/service-token-fixtures.json", import.meta.url), "utf8"));
for (const v of tokens.configuration_vectors) test(`receiver: ${v.name}`, () => {
  const operation = () => parseReceiver(v.receiver, Buffer.from(v.callers_json), v.self_allowed);
  if (v.valid) assert.doesNotThrow(operation); else assert.throws(operation);
});
for (const v of tokens.token_vectors) test(`token: ${v.name}`, () => assert.equal(validateToken(v.token), v.valid));
for (const v of tokens.header_vectors) test(`header: ${v.name}`, () => {
  const receiver = parseReceiver("runtime-controller", Buffer.from(JSON.stringify(tokens.receiver_configurations[v.configuration])));
  assert.deepEqual(authenticateFields(receiver, v.fields, v.allowed_callers), v.expected);
});
for (const v of tokens.mode_vectors) test(`mode: ${v.name}`, () => {
  const operation = () => validateMode(v.mode ?? undefined, v.allow_insecure_transport ?? undefined, v.transport);
  if (v.valid) assert.doesNotThrow(operation); else assert.throws(operation);
});
const contexts = JSON.parse(readFileSync(new URL("../../../../../contracts/platform/caller-context-fixtures.json", import.meta.url), "utf8"));
for (const v of contexts.verification_vectors) test(`signed CCT: ${v.name}`, async () => {
  const keys = await parseKeys(Buffer.from(JSON.stringify(contexts.jwks)));
  const promise = verifyCallerContext(v.token, keys, { consumer: v.consumer, organization: v.organization,
    agent: v.agent ?? undefined, now: v.now, tolerance: v.tolerance });
  if (v.valid) assert.ok((await promise).sub); else await assert.rejects(promise);
});
