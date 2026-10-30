import assert from "node:assert/strict";
import test from "node:test";
import { readReliabilityEvents } from "./reliability-events.mjs";

const metadata = {
  event_id: "event-failed",
  global_sequence: 9,
  aggregate_sequence: 2,
  schema_version: 1,
  agent_id: "agent-test",
  event_type: "agent_build_failed",
  operation_request_id: "request-create",
};
const audit = () => ({
  ...metadata,
  data: {
    failure_code: "phase_deadline_exceeded",
    failure_stage: "network_ensure",
  },
});

test("public event metadata correlates to the original persisted audit payload", async () => {
  const row = audit();
  const publicEvent = { ...metadata };
  const reads = [];
  const rows = await readReliabilityEvents(
    async (path) => {
      assert.equal(
        path,
        "/api/admin/agents/agent-test/events?after_sequence=0&limit=100",
      );
      return { events: [publicEvent] };
    },
    {
      lifecycleEvent: async (id) => {
        reads.push(id);
        return row;
      },
    },
    "agent-test",
  );
  assert.strictEqual(rows[0], row);
  assert.deepEqual(reads, [metadata.event_id]);
  assert.equal(rows[0].data.failure_code, "phase_deadline_exceeded");
  assert.deepEqual(
    publicEvent,
    metadata,
    "private payload must not be copied into the public event",
  );
});

for (const field of Object.keys(metadata)) {
  test(`reject mismatched persisted ${field}`, async () => {
    const row = audit();
    row[field] = typeof row[field] === "number" ? row[field] + 1 : "other";
    await assert.rejects(
      readReliabilityEvents(
        async () => ({ events: [{ ...metadata }] }),
        { lifecycleEvent: async () => row },
        "agent-test",
      ),
    );
  });
}

test("missing audit rows or non-object audit data never count as evidence", async () => {
  for (const row of [null, { ...metadata }, { ...metadata, data: [] }]) {
    await assert.rejects(
      readReliabilityEvents(
        async () => ({ events: [{ ...metadata }] }),
        { lifecycleEvent: async () => row },
        "agent-test",
      ),
    );
  }
});

test("a foreign public Agent and a truncated event page are rejected", async () => {
  for (const events of [
    [{ ...metadata, agent_id: "agent-other" }],
    Array.from({ length: 100 }, () => ({ ...metadata })),
  ]) {
    await assert.rejects(
      readReliabilityEvents(
        async () => ({ events }),
        { lifecycleEvent: async () => audit() },
        "agent-test",
      ),
    );
  }
});

test("forged public data cannot replace the persisted failure payload", async () => {
  const row = audit();
  const events = [{ ...metadata, data: { failure_code: "forged" } }];
  const result = await readReliabilityEvents(
    async () => ({ events }),
    { lifecycleEvent: async () => row },
    "agent-test",
  );
  assert.strictEqual(result[0], row);
  assert.equal(result[0].data.failure_code, "phase_deadline_exceeded");
  assert.equal(events[0].data.failure_code, "forged");
});
