import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSourceActive } from "./source-projection-check.mjs";

const source = "agent_201ce8";
const peer = "agent_5ab7";

const sourceRow = {
  agent_id: source,
  name: "fixture-procedure",
  sequence: 2,
  sent_sequence: 1,
  active: true,
  failures: 6,
  candidate_id: "candidate_source",
  content_digest: "sha256:source",
  managed_state: "active",
  managed_origin: "auto_generated",
  managed_candidate_id: "candidate_source",
  managed_digest: "sha256:source",
};
const peerRow = {
  ...sourceRow,
  agent_id: peer,
  sequence: 1,
  sent_sequence: 1,
  failures: 0,
};
const waiting = {
  agentId: source,
  sequence: 2,
  agentIds: [peer],
  waitForAck: true,
  timeoutMs: 1000,
  pollMs: 1,
};

test("peer ACK does not bypass a source ACK still in flight", async () => {
  let checks = 0;
  await assertSourceActive({
    ...waiting,
    sql: async (query) => {
      if (query.startsWith("SELECT count(*)")) return ++checks < 3 ? "0" : "1";
      return JSON.stringify([sourceRow, peerRow]);
    },
  });
  assert.equal(checks, 3);
});

test("the ordinary invariant assertion still fails immediately on ACK lag", async () => {
  let checks = 0;
  await assert.rejects(
    assertSourceActive({
      ...waiting,
      waitForAck: false,
      sql: async (query) => {
        if (query.startsWith("SELECT count(*)"))
          return ++checks < 2 ? "0" : "1";
        return JSON.stringify([sourceRow, peerRow]);
      },
    }),
    /"sent_sequence":1/u,
  );
  assert.equal(checks, 1);
});

for (const [name, rows] of [
  ["missing source", [peerRow]],
  ["withdrawn source", [{ ...sourceRow, active: false }, peerRow]],
  ["newer sequence", [{ ...sourceRow, sequence: 3 }, peerRow]],
  ["invalid ACK", [{ ...sourceRow, sent_sequence: 3 }, peerRow]],
  ["inactive managed Skill", [{ ...sourceRow, managed_state: "disabled" }]],
  ["changed managed origin", [{ ...sourceRow, managed_origin: "manual" }]],
  [
    "changed managed candidate",
    [{ ...sourceRow, managed_candidate_id: "other" }],
  ],
  ["changed managed digest", [{ ...sourceRow, managed_digest: "other" }]],
]) {
  test(`ACK waiting rejects ${name} immediately`, async () => {
    let checks = 0;
    await assert.rejects(
      assertSourceActive({
        ...waiting,
        sql: async (query) => {
          if (query.startsWith("SELECT count(*)"))
            return ++checks < 2 ? "0" : "1";
          return JSON.stringify(rows);
        },
      }),
      /must remain active and acknowledged/u,
    );
    assert.equal(checks, 1);
  });
}

test("an ACK that never arrives fails within the budget with the last rows", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  let checks = 0;
  let lastFailures;
  await assert.rejects(
    assertSourceActive({
      ...waiting,
      timeoutMs: 10,
      sql: async (query) => {
        if (query.startsWith("SELECT count(*)")) {
          checks++;
          if (checks === 2) now = 10;
          return "0";
        }
        lastFailures = checks;
        return JSON.stringify([
          { ...sourceRow, failures: lastFailures },
          peerRow,
        ]);
      },
    }),
    (error) => {
      assert.match(error.message, /ACK deadline exceeded/u);
      assert(error.message.includes(`"failures":${lastFailures}`));
      assert.match(error.message, /"sent_sequence":1/u);
      return true;
    },
  );
  assert.equal(checks, 2);
  assert.equal(lastFailures, 1);
});

for (const stage of ["count", "diagnostic"]) {
  test(`an ACK observed after the deadline in the ${stage} query fails`, async (t) => {
    let now = 0;
    t.mock.method(Date, "now", () => now);
    await assert.rejects(
      assertSourceActive({
        ...waiting,
        timeoutMs: 10,
        sql: async (query) => {
          if (query.startsWith("SELECT count(*)")) {
            if (stage === "count") {
              now = 10;
              return "1";
            }
            return "0";
          }
          now = 10;
          return JSON.stringify([{ ...sourceRow, sent_sequence: 2 }, peerRow]);
        },
      }),
      /ACK deadline exceeded/u,
    );
  });
}

test("cancellation during ACK waiting stops before another SQL query", async () => {
  const abort = new AbortController();
  let checks = 0;
  await assert.rejects(
    assertSourceActive({
      ...waiting,
      signal: abort.signal,
      sql: async (query) => {
        if (query.startsWith("SELECT count(*)")) {
          checks++;
          return "0";
        }
        abort.abort(new Error("caller interrupted"));
        return JSON.stringify([sourceRow, peerRow]);
      },
    }),
    /caller interrupted|aborted/u,
  );
  assert.equal(checks, 1);
});

test("an ACK arriving between the count and diagnostic reads completes the wait", async () => {
  let queries = 0;
  await assertSourceActive({
    ...waiting,
    sql: async (query) => {
      queries++;
      return query.startsWith("SELECT count(*)")
        ? "0"
        : JSON.stringify([{ ...sourceRow, sent_sequence: 2 }, peerRow]);
    },
  });
  assert.equal(queries, 2);
});

test("withdrawal during ACK waiting remains an immediate invariant failure", async () => {
  let checks = 0;
  await assert.rejects(
    assertSourceActive({
      ...waiting,
      sql: async (query) => {
        if (query.startsWith("SELECT count(*)"))
          return ++checks < 3 ? "0" : "1";
        return JSON.stringify([
          {
            ...sourceRow,
            active: checks === 1,
            sequence: checks === 1 ? 2 : 3,
          },
          peerRow,
        ]);
      },
    }),
    /"active":false/u,
  );
  assert.equal(checks, 2);
});

test("a failed diagnostic query cannot be mistaken for pending ACK", async () => {
  let queries = 0;
  await assert.rejects(
    assertSourceActive({
      ...waiting,
      sql: async () => {
        if (++queries === 1) return "0";
        throw new Error("diagnostics offline");
      },
    }),
    /unavailable: diagnostics offline/u,
  );
  assert.equal(queries, 2);
});

test("an already cancelled wait issues no SQL", async () => {
  await assert.rejects(
    assertSourceActive({
      ...waiting,
      signal: AbortSignal.abort(new Error("caller cancelled")),
      sql: async () => assert.fail("cancelled wait issued SQL"),
    }),
    /caller cancelled/u,
  );
});

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
