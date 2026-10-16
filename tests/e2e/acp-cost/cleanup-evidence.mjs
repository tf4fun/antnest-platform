import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { withAgentCleanup } from "../../support/verification/agent-cleanup.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";

const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const one = (rows, label) => {
  assert.equal(rows.length, 1, "missing or duplicate " + label);
  return rows[0];
};

function inspectCleanup(events, agents) {
  const ack = one(
    events.filter((row) => row.kind === "runtime-ack-consumed"),
    "consumed Runtime ACK",
  );
  assert.deepEqual(ack.request.agent_ids, agents);
  assert.equal(agents.length, 4);
  const starts = events.filter((row) => row.kind === "request-start");
  assert.equal(
    starts.filter((row) => row.method === "POST").length,
    agents.length,
  );
  const response = (start) => {
    const row = one(
      events.filter(
        (event) =>
          event.kind === "response-complete" &&
          event.request_sequence === start.sequence,
      ),
      "cleanup response",
    );
    assert(
      row.sequence > start.sequence && row.monotonic_ms >= start.monotonic_ms,
    );
    assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
    return row;
  };
  const operations = new Set();
  for (const agent of agents) {
    const start = one(
      starts.filter(
        (row) =>
          row.method === "POST" &&
          row.path === `/api/admin/agents/${encodeURIComponent(agent)}/delete`,
      ),
      "Agent deletion",
    );
    assert(
      start.sequence > ack.sequence && start.monotonic_ms >= ack.monotonic_ms,
      "Agent deleted before consuming Runtime ACK",
    );
    const submitted = response(start);
    assert.equal(submitted.status, 202);
    const id = submitted.body?.request_id;
    assert(typeof id === "string" && id.length > 0);
    assert(!operations.has(id), "Agent deletions reused one operation");
    operations.add(id);
    assert.equal(submitted.body.agent_id, agent);
    assert.equal(submitted.body.kind, "delete");
    const polls = starts.filter(
      (row) =>
        row.method === "GET" &&
        row.path === `/api/admin/operations/${encodeURIComponent(id)}`,
    );
    assert(polls.length > 0);
    for (const poll of polls) {
      assert(
        poll.sequence > submitted.sequence &&
          poll.monotonic_ms >= submitted.monotonic_ms,
      );
      const result = response(poll);
      assert.equal(result.status, 200);
      assert.equal(result.body?.request_id, id);
      assert.equal(result.body?.agent_id, agent);
      assert.equal(result.body?.kind, "delete");
    }
    assert.equal(response(polls.at(-1)).body?.state, "completed");
  }
}

// Evidence recording must never prevent either actual deletion or its operation
// polling. Report recording errors only after the shared cleanup has joined.
export async function withCostAgentCleanup(
  agents,
  client,
  action,
  { directory } = {},
) {
  const events = [],
    evidenceErrors = [];
  const clock_id = randomUUID();
  const save = (name, contents) => {
    try {
      assert(
        evidenceDirectory(directory),
        "cleanup evidence directory required",
      );
      writeEvidenceFile(directory, name, contents);
    } catch (error) {
      evidenceErrors.push(error);
    }
  };
  const record = (kind, data) => {
    const row = {
      sequence: events.length + 1,
      monotonic_ms: performance.now(),
      kind,
      ...data,
    };
    events.push(row);
    save(
      `cleanup-event-${String(row.sequence).padStart(4, "0")}.json`,
      encode(row),
    );
    return row;
  };
  const consumed = (bytes, receipt) => {
    assert(Buffer.isBuffer(bytes));
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), receipt);
    assert.equal(receipt.status, "verified");
    assert.deepEqual(receipt.request.agent_ids, agents);
    const file = "runtime-ack-consumed.raw";
    save(file, bytes);
    record("runtime-ack-consumed", {
      file,
      bytes: bytes.length,
      sha256: hash(bytes),
      request: structuredClone(receipt.request),
      runtime_raw_sha256: receipt.raw_sha256,
    });
  };
  const api = async (path, body, status = 200) => {
    const start = record("request-start", {
      method: body === undefined ? "GET" : "POST",
      path,
    });
    let captured = false;
    try {
      // GatewayClient consumes the complete response text. Preserve that exact
      // decoded text, not a reserialized JSON body and never credential headers.
      const result = await client.request(path, {
        body,
        status,
        responseType: "text",
        onResponse: (receipt) => {
          const bytes = Buffer.from(receipt.text, "utf8");
          const file = `cleanup-response-${String(start.sequence).padStart(4, "0")}.raw`;
          save(file, bytes);
          let parsed = null;
          try {
            parsed = JSON.parse(receipt.text);
          } catch {
            // Retain a non-JSON failure response verbatim; it is not admission.
          }
          record("response-complete", {
            request_sequence: start.sequence,
            status: receipt.status,
            trace_id: receipt.traceID,
            file,
            bytes: bytes.length,
            sha256: hash(bytes),
            body: parsed,
          });
          captured = true;
        },
      });
      assert(captured, "actual cleanup response was not observed");
      assert.equal(typeof result.body, "string");
      return JSON.parse(result.body);
    } catch (error) {
      record("request-failed", {
        request_sequence: start.sequence,
        error_type: error.name,
      });
      throw error;
    }
  };
  let result;
  const failures = [];
  try {
    result = await withAgentCleanup(agents, api, () => action(consumed));
    inspectCleanup(events, agents);
  } catch (error) {
    failures.push(error);
  }
  save(
    "cleanup-lifecycle.private.json",
    encode({
      version: 1,
      clock_id,
      process_pid: process.pid,
      status: failures.length || evidenceErrors.length ? "failed" : "verified",
      agent_ids: [...agents],
      events,
      evidence_error_count: evidenceErrors.length,
    }),
  );
  failures.push(...evidenceErrors);
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Cost cleanup or evidence failed");
  return result;
}
