import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditEventsForBrowser } from "./stage2-audit-projection.mjs";

const load = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/agent-acp/examples/${name}`, import.meta.url),
      "utf8",
    ),
  );

for (const name of [
  "execution-events.current.json",
  "execution-events.n-1.json",
  "execution-events.permissions.json",
]) {
  test(`stage2 compares the browser representation of real ACP output: ${name}`, () => {
    const wire = load(name);
    const before = structuredClone(wire);
    const actual = auditEventsForBrowser(wire);
    const expected = name.includes("permissions")
      ? {
          stream: "permissions",
          next_cursor: null,
          items: [
            {
              created_at: "2026-09-01T00:00:00Z",
              decided_at: "2026-09-01T00:00:00Z",
              decision: "allow_once",
              reason: null,
              request: { tool_name: "read" },
              tool_call_id: "tool-1",
            },
          ],
        }
      : {
          stream: "execution",
          next_cursor: null,
          items: [
            {
              created_at: "2026-09-01T00:00:00Z",
              id: "event-1",
              kind: "run_started",
              payload: { text: "started" },
              sequence: 1,
              visible: true,
            },
          ],
        };
    assert.deepEqual(actual, expected);
    assert.deepEqual(wire, before);
  });
}

test("stage2 preserves opaque audit data, pagination, identity and ordering", () => {
  const wire = load("execution-events.current.json");
  wire.items[0].payload.schema_version = "user-owned";
  wire.items[0].payload.secret = "opaque-user-data";
  wire.items.push({ ...wire.items[0], id: "event-2", sequence: 2 });
  wire.next_cursor = "opaque-cursor";
  const actual = auditEventsForBrowser(wire);
  assert.deepEqual(
    actual.items.map((row) => [row.id, row.sequence]),
    [
      ["event-1", 1],
      ["event-2", 2],
    ],
  );
  assert.deepEqual(
    actual.items.map((row) => row.payload),
    wire.items.map((row) => row.payload),
  );
  assert.equal(actual.next_cursor, wire.next_cursor);
});

test("stage2 rejects malformed protocol versions at the page and row boundaries", () => {
  for (const value of [null, 0, 2, "1", false]) {
    for (const target of ["page", "row"]) {
      const wire = load("execution-events.current.json");
      (target === "page" ? wire : wire.items[0]).schema_version = value;
      assert.throws(() => auditEventsForBrowser(wire));
    }
  }
});
