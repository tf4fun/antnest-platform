import assert from "node:assert/strict";

// Console exposes event metadata only. Read private audit payloads through
// the owning database role and correlate every original public identity.
export async function readReliabilityEvents(json, journal, agentID) {
  const page = await json(
    `/api/admin/agents/${encodeURIComponent(agentID)}/events?after_sequence=0&limit=100`,
  );
  const events = page?.events ?? page?.items ?? page;
  assert(Array.isArray(events) && events.length > 0 && events.length < 100);
  const rows = [];
  for (const event of events) {
    assert.equal(event?.agent_id, agentID, "public audit Agent identity");
    const row = await journal.lifecycleEvent(event.event_id);
    assert(
      row &&
        row.data &&
        typeof row.data === "object" &&
        !Array.isArray(row.data),
      "persisted audit payload is required",
    );
    for (const field of [
      "event_id",
      "global_sequence",
      "aggregate_sequence",
      "schema_version",
      "agent_id",
      "event_type",
    ]) {
      assert.equal(row[field], event[field], `persisted audit ${field}`);
    }
    assert.equal(
      row.operation_request_id ?? "",
      event.operation_request_id ?? "",
      "persisted audit operation identity",
    );
    rows.push(row);
  }
  return rows;
}
