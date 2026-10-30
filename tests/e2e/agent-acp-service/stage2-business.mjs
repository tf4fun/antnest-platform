import assert from "node:assert/strict";
import { assertPromptEvidence } from "./stage2-acp-evidence.mjs";
import { assertV1Completion } from "./stage2-protocol.mjs";
import { stage2Scenarios } from "./stage2-inventory.mjs";

export function assertStage2BusinessInventory(value) {
  const { agentId, audits, interrupted, modelCalls, workflows } = value;
  assert(typeof agentId === "string" && agentId);
  assert.deepEqual(value.scenarios, stage2Scenarios);
  assert.equal(value.auditReads, 48);
  assert.equal(audits.length, 7);
  assert.equal(new Set(audits.map((row) => row.run_id)).size, 7);
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.error_class, "service_restarted_during_run");
  assert.equal(
    audits.filter((row) => row.run_id === interrupted.run_id).length,
    1,
  );
  for (const row of audits) {
    assert.equal(row.agent_id, agentId);
    assert(typeof row.run_id === "string" && row.run_id);
    assert(typeof row.session_id === "string" && row.session_id);
    assert.equal(
      row.state,
      row.run_id === interrupted.run_id ? "failed" : "completed",
    );
  }
  assert.equal(modelCalls.requests.length, 13);
  assert.equal(modelCalls.attempts.length, 13);
  const successful = [];
  for (const [index, request] of modelCalls.requests.entries()) {
    assert.equal(request.request_number, index + 1);
    const attempt = modelCalls.attempts[index];
    assert.equal(attempt.status, index === 10 ? 499 : 200);
    if (index === 10) assert.equal(request.has_tool_result, false);
    else successful.push(request.has_tool_result);
  }
  assert.deepEqual(
    successful,
    Array.from({ length: 6 }, () => [false, true]).flat(),
  );
  const completed = [],
    counts = [];
  for (const [transport, version] of [
    ["connections", 2],
    ["http", 1],
  ]) {
    let count = 0;
    for (const connection of value.private[transport]) {
      assert.equal(connection.version, version);
      assert.equal(connection.closed, true);
      assert.equal(connection.agentId, agentId);
      for (const row of connection.evidence.filter((row) => row.completion)) {
        assert.equal(row.method, "session/prompt");
        assert.equal(row.outcome, "succeeded");
        assert.equal(row.requestParams.sessionId, row.sessionId);
        const receipt = row.completion;
        if (version === 2)
          assertPromptEvidence(receipt.ack, receipt.events, row.sessionId);
        else assertV1Completion(receipt.result, receipt.events);
        const updates =
          version === 2
            ? receipt.events.map((event) => event.update)
            : receipt.events;
        assert.equal(
          new Set(
            updates
              .filter(
                (event) =>
                  event.sessionUpdate === "tool_call_update" &&
                  event.status === "completed",
              )
              .map((event) => event.toolCallId),
          ).size,
          1,
        );
        completed.push(row.sessionId);
        count++;
      }
    }
    counts.push(count);
  }
  assert.deepEqual(counts, [5, 1]);
  assert.deepEqual(
    completed.sort(),
    audits
      .filter((row) => row.state === "completed")
      .map((row) => row.session_id)
      .sort(),
  );
  assert.deepEqual(
    value.management.map((row) => row.kind),
    ["create", "rebuild"],
  );
  assert.equal(workflows.length, 5);
  assert.equal(new Set(workflows).size, 5);
  for (const [index, kind] of [
    "create",
    "rebuild",
    "disable",
    "enable",
    "delete",
  ].entries())
    assert(
      workflows[index].startsWith(`agent-${kind}/`) &&
        workflows[index].length > kind.length + 7,
    );
  return {
    scenarios: 9,
    runs: 7,
    completed_runs: 6,
    interrupted_runs: 1,
    model_requests: 13,
    runtime_writes: 6,
    audit_reads: 48,
    workflows: 5,
  };
}
