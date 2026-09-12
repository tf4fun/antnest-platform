import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAdmissionEvidence,
  readAdmissionEvidence,
} from "./admission-evidence.mjs";

const record = {
  admission_id: "admission",
  agent_id: "agent",
  request_id: "request",
  session_id: "session",
  state: "released",
  terminal_report: {
    terminal_class: "completed",
    tool_effect_state: "settled",
  },
  created_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:01Z",
  released_at: "2026-01-01T00:00:01Z",
  released_by_operation_request_id: null,
};
const expected = {
  admissionID: "admission",
  agentID: "agent",
  requestID: "request",
  sessionID: "session",
  state: "released",
  terminalClass: "completed",
  toolEffectState: "settled",
};
test("persisted admission binds terminal state to the exact acquire identity", () => {
  assertAdmissionEvidence([record], expected);
  for (const key of Object.keys(record)) {
    assert.throws(
      () =>
        assertAdmissionEvidence(
          [
            {
              ...record,
              [key]:
                key === "released_by_operation_request_id" ? "rebuild" : null,
            },
          ],
          expected,
        ),
      key,
    );
  }
  assert.throws(() => assertAdmissionEvidence([record, record], expected));
});
test("fixture reader obtains only final admission facts using the existing fixture database role", async () => {
  const commands = [];
  const result = await readAdmissionEvidence(
    { project: "antnest-lifecycle-1234abcd" },
    async (args) => {
      commands.push(args);
      return JSON.stringify([record]);
    },
    "agent",
  );
  assert.deepEqual(result, [record]);
  assert.equal(commands.length, 1);
  const sql = commands[0].at(-1);
  assert(sql.includes("agent_controller.run_admissions"));
  assert(
    !sql.includes("snapshot") &&
      !sql.includes("credential") &&
      !sql.includes("SELECT *"),
  );
  await assert.rejects(
    readAdmissionEvidence(
      { project: "antnest-lifecycle-1234abcd" },
      async () => {
        throw Error("must not query");
      },
      "agent' OR TRUE",
    ),
  );
  await assert.rejects(
    readAdmissionEvidence(
      { project: "antnest-lifecycle-1234abcd" },
      async () => "[]",
      "agent",
    ),
  );
});
