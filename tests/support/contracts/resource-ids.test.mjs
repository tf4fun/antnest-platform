import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateGolden } from "./golden.mjs";

const SCHEMA_REF = "common/ids.schema.json";
const KINDS = ["organizationId", "userId", "agentId"];
const SHARED_ACCEPT = ["a", "0", "A", "Legacy.ID_9-z", "a".repeat(200)];
const NON_STRINGS = [null, 7, {}, []];

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../contracts/common/id-vectors.json", import.meta.url),
    ),
    "utf8",
  ),
);

test("id vectors cover exactly the three shared kinds", () => {
  assert.deepEqual(
    Object.keys(vectors).sort(),
    [...KINDS].sort(),
    "vector kinds must be organizationId, userId, agentId",
  );
  for (const kind of KINDS) {
    assert.ok(
      Array.isArray(vectors[kind].accept) &&
        vectors[kind].accept.every((value) => typeof value === "string"),
      `${kind} accept vectors must be strings`,
    );
    assert.ok(
      Array.isArray(vectors[kind].reject) &&
        vectors[kind].reject.every((value) => typeof value === "string"),
      `${kind} reject vectors must be strings`,
    );
  }
});

test("all kinds share the same opaque-ID boundary", () => {
  const [first, ...rest] = KINDS;
  for (const kind of rest) {
    assert.deepEqual(
      vectors[kind].reject,
      vectors[first].reject,
      `${kind} must reject exactly the same boundary values as ${first}`,
    );
  }
  for (const kind of KINDS) {
    for (const value of SHARED_ACCEPT)
      assert.ok(
        vectors[kind].accept.includes(value),
        `${kind} must accept the shared boundary value ${JSON.stringify(value)}`,
      );
  }
});

for (const kind of KINDS) {
  const ref = `${SCHEMA_REF}#/$defs/${kind}`;

  test(`${kind} accepts shared and kind-specific opaque IDs`, async () => {
    for (const value of vectors[kind].accept) {
      assert.equal(
        await validateGolden(ref, value),
        true,
        `expected ${JSON.stringify(value)} to validate`,
      );
    }
  });

  test(`${kind} rejects out-of-grammar values`, async () => {
    for (const value of vectors[kind].reject) {
      await assert.rejects(
        () => validateGolden(ref, value),
        `expected ${JSON.stringify(value)} to be rejected`,
      );
    }
  });

  test(`${kind} rejects non-string values`, async () => {
    for (const value of NON_STRINGS) {
      await assert.rejects(
        () => validateGolden(ref, value),
        `expected non-string ${JSON.stringify(value)} to be rejected`,
      );
    }
  });
}
