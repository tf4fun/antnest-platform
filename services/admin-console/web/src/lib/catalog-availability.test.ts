import assert from "node:assert/strict";
import test from "node:test";
import { referenceLinks } from "./catalog-availability.ts";

test("reference rendering preserves server order and optional fields", () => {
  const result = referenceLinks({
    references: [
      { kind: "template", resource_id: "template 1" },
      { kind: "agent", resource_id: "agent/1" },
      {
        kind: "lifecycle_operation",
        resource_id: "operation/1",
        agent_id: "agent 2",
      },
    ],
  });
  assert.equal(result.incomplete, false);
  assert.deepEqual(
    result.items.map((item) => item.href),
    ["#templates/template%201", "#agents/agent%2F1", "#agents/agent%202"],
  );
});

test("invalid or missing reference metadata does not imply an unused resource", () => {
  for (const references of [
    undefined,
    null,
    {},
    [],
    [null],
    [{ kind: "unknown", resource_id: "one" }],
    [{ kind: "template", resource_id: "" }],
    [{ kind: "lifecycle_operation", resource_id: "one" }],
  ]) {
    assert.equal(referenceLinks({ references }).incomplete, true);
  }
  assert.equal(referenceLinks().incomplete, true);
});

test("truncated, unrecognized and over-budget references remain explicitly incomplete", () => {
  const references = Array.from({ length: 100 }, (_, id) => ({
    kind: "agent",
    resource_id: `agent-${id}`,
  }));
  assert.equal(referenceLinks({ references }).items.length, 100);
  assert.equal(referenceLinks({ references }).incomplete, false);
  assert.equal(
    referenceLinks({ references, references_truncated: true }).incomplete,
    true,
  );
  assert.equal(
    referenceLinks({ references, references_truncated: "false" }).incomplete,
    true,
  );
  const excess = referenceLinks({
    references: [...references, { kind: "agent", resource_id: "extra" }],
  });
  assert.equal(excess.items.length, 100);
  assert.equal(excess.incomplete, true);
});
