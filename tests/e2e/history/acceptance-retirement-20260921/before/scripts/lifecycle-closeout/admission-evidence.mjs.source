import assert from "node:assert/strict";
import { composeArgs } from "./docker.mjs";

// Fixture-only persisted evidence. Never select snapshots or credentials.
export async function readAdmissionEvidence(config, docker, agentID) {
  assert.match(agentID, /^[a-zA-Z0-9_-]+$/u);
  const text = await docker(
    composeArgs(config.project, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_agent_controller",
      "-d",
      "antnest_agent_controller",
      "-c",
      `SELECT COALESCE(json_agg(e), '[]'::json) FROM (
      SELECT admission_id, request_id, agent_id, session_id, state,
             terminal_report, created_at, finished_at, released_at,
             released_by_operation_request_id
      FROM agent_controller.run_admissions WHERE agent_id='${agentID}'
    ) e`,
    ]),
  );
  const records = JSON.parse(text);
  assert(
    Array.isArray(records) && records.length > 0,
    "persisted admission evidence missing",
  );
  return records;
}

export function assertAdmissionEvidence(records, expected) {
  assert(Array.isArray(records), "persisted admission evidence required");
  assert(
    expected.admissionID && expected.agentID,
    "admission identity required",
  );
  const matches = records.filter(
    (record) => record.admission_id === expected.admissionID,
  );
  assert.equal(matches.length, 1, "missing/duplicate persisted admission");
  const record = matches[0];
  assert.equal(record.agent_id, expected.agentID, "foreign persisted Agent");
  assert(
    record.session_id && record.request_id,
    "admission request/session missing",
  );
  if (expected.requestID !== undefined)
    assert.equal(
      record.request_id,
      expected.requestID,
      "foreign acquire request",
    );
  if (expected.sessionID !== undefined)
    assert.equal(
      record.session_id,
      expected.sessionID,
      "foreign acquire Session",
    );
  assert.equal(record.state, expected.state);
  assert.equal(record.terminal_report?.terminal_class, expected.terminalClass);
  assert.equal(
    record.terminal_report?.tool_effect_state,
    expected.toolEffectState,
  );
  assert(
    Number.isFinite(Date.parse(record.created_at)),
    "admission creation missing",
  );
  assert(
    Number.isFinite(Date.parse(record.finished_at)),
    "admission finish not persisted",
  );
  assert(Date.parse(record.finished_at) >= Date.parse(record.created_at));
  assert.equal(
    record.released_by_operation_request_id,
    null,
    "lifecycle release cannot substitute for FinishRun",
  );
  if (expected.state === "released")
    assert.equal(
      record.released_at,
      record.finished_at,
      "FinishRun did not release admission",
    );
  else
    assert.equal(
      record.released_at,
      null,
      "unknown-effect admission was not fenced",
    );
  return record;
}
