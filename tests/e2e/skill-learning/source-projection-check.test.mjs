import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSourceActive } from "./source-projection-check.mjs";

const source = "agent_201ce8";
const peer = "agent_5ab7";

test("an active acknowledged source passes with one query", async () => {
  const queries = [];
  await assertSourceActive({
    sql: async (query) => (queries.push(query), "1"),
    agentId: source,
    sequence: 2,
    agentIds: [peer],
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /active AND sequence=2 AND sent_sequence=2/u);
});

test("a missing source fails with every related projection and its managed state", async () => {
  const rows = [
    {
      agent_id: source,
      name: "fixture-procedure",
      sequence: 3,
      sent_sequence: 3,
      active: false,
      managed_state: "disabled",
    },
  ];
  const queries = [];
  await assert.rejects(
    assertSourceActive({
      sql: async (query) => {
        queries.push(query);
        return queries.length === 1 ? "0" : JSON.stringify(rows);
      },
      agentId: source,
      sequence: 2,
      agentIds: [peer, source],
    }),
    (error) => {
      assert.match(error.message, /must remain active and acknowledged/u);
      assert.match(error.message, /sequence 2 matched 0/u);
      assert.match(error.message, /"managed_state":"disabled"/u);
      return true;
    },
  );
  assert.match(queries[1], new RegExp(`IN \\('${source}','${peer}'\\)`, "u"));
  assert.match(queries[1], /learning_managed_skills/u);
});

test("the failure stands when the diagnostic query also fails", async () => {
  let calls = 0;
  await assert.rejects(
    assertSourceActive({
      sql: async () => {
        if (++calls === 1) return "0";
        throw new Error("psql exited 2");
      },
      agentId: source,
      sequence: 1,
      agentIds: [],
    }),
    /matched 0; projections "unavailable: psql exited 2"/u,
  );
});

test("agent identifiers are validated before they reach SQL", async () => {
  await assert.rejects(
    assertSourceActive({
      sql: async () => "1",
      agentId: "agent_x' OR '1'='1",
      sequence: 1,
      agentIds: [],
    }),
  );
});
