import assert from "node:assert/strict";
import test from "node:test";
import { BridgeOperationTracker } from "./bridge-operations.ts";
import { WorkspaceApiError, type PromptAdmission } from "./workspace-api-client.ts";

const admission: PromptAdmission = {
  intentId: "intent-1", expectedAppendVersion: 7, historyToken: "history-7",
  prompt: [{ type: "text", text: "hello" }],
};

test("Bridge receipt returns immediately while the Run remains active until observed terminal", async () => {
  const updates: string[] = [];
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => assert.fail("unexpected cancel"),
    },
    changed: (operation) => updates.push(operation.phase),
  });
  const receipt = await tracker.submit("session-1", admission);
  assert.equal(receipt.phase, "dispatching");
  assert.equal(tracker.get("session-1", "intent-1")?.phase, "dispatching");
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  assert.equal(tracker.get("session-1", "intent-1")?.phase, "running");
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "completed",
    acceptance: "acp", runId: "run-1", outputWatermark: 4 }]);
  assert.equal(tracker.get("session-1", "intent-1")?.phase, "completed");
  assert.deepEqual(updates, ["dispatching", "running", "completed"]);
});

test("failed operation retains the durable failure class after an HTTP reread", async () => {
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => assert.fail("unexpected prompt"),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "failed",
    acceptance: "acp", runId: "run-1", outputWatermark: 4,
    errorClass: "model_unsupported_content" }]);
  assert.equal(tracker.get("session-1", "intent-1")?.errorClass,
    "model_unsupported_content");
});

test("operation observation retains active work while bounding completed history", () => {
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => assert.fail("unexpected prompt"),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  tracker.observe([{ operationId: "active", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "active-run", outputWatermark: 1 },
  { operationId: "uncertain", sessionId: "session-2", phase: "uncertain",
    acceptance: "unknown" }]);
  for (let index = 0; index < 200; index++)
    tracker.observe([{ operationId: `done-${index}`, sessionId: "session-1",
      phase: "completed", acceptance: "acp", runId: `run-${index}`,
      outputWatermark: index }]);
  const snapshot = tracker.snapshot;
  assert.ok(snapshot.length <= 66, `retained ${snapshot.length} operations`);
  assert.equal(snapshot.find((item) => item.operationId === "active")?.phase, "running");
  assert.equal(snapshot.find((item) => item.operationId === "uncertain")?.phase, "uncertain");
  assert.equal(snapshot.find((item) => item.operationId === "done-199")?.phase, "completed");
  assert.equal(tracker.get("session-1", "done-0"), undefined);
});

test("lost prompt response queries the original intent without submitting again", async () => {
  let submits = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => { submits++; throw new WorkspaceApiError("lost", undefined, "workspace_network_error", "query_operation", "intent-1"); },
      operation: async (_agentId, _sessionId, intentId) => {
        assert.equal(intentId, "intent-1");
        return { operationId: "intent-1", sessionId: "session-1", phase: "running", acceptance: "acp", runId: "run-1", outputWatermark: 0 };
      },
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  const result = await tracker.submit("session-1", admission);
  assert.equal(result.phase, "running");
  assert.equal(submits, 1);
});

test("unknown receipt remains uncertain and never silently retries the Prompt", async () => {
  let submits = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => { submits++; throw new WorkspaceApiError("lost", 503, "workspace_unavailable", "query_operation", "intent-1"); },
      operation: async () => { throw new WorkspaceApiError("missing", 404, "not_found", "none"); },
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  const result = await tracker.submit("session-1", admission);
  assert.equal(result.phase, "uncertain");
  assert.equal(result.acceptance, "unknown");
  assert.equal(submits, 1);
});

test("cancel uses only the known Run ID bound to the original Session and intent", async () => {
  const calls: unknown[] = [];
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async (...args) => {
        calls.push(args);
        return { operationId: "intent-1", sessionId: "session-1", phase: "cancelling", acceptance: "acp", runId: "run-1", outputWatermark: 2 };
      },
    },
  });
  await tracker.submit("session-1", admission);
  await assert.rejects(tracker.cancel("session-1", "intent-1"), /Run ID/u);
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  await tracker.cancel("session-1", "intent-1");
  assert.deepEqual(calls, [["agent-1", "session-1", "intent-1", "run-1", undefined]]);
  await assert.rejects(tracker.cancel("session-2", "intent-1"), /Run ID/u);
});

test("lost cancel response reads the original Run without sending Stop twice", async () => {
  let cancels = 0;
  let reads = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async (_agentId, sessionId, intentId) => {
        reads++;
        assert.equal(sessionId, "session-1");
        assert.equal(intentId, "intent-1");
        return { operationId: intentId, sessionId, phase: "cancelling",
          acceptance: "acp", runId: "run-1", outputWatermark: 2 };
      },
      cancel: async (_agentId, sessionId, intentId, expectedRunId) => {
        cancels++;
        assert.deepEqual([sessionId, intentId, expectedRunId],
          ["session-1", "intent-1", "run-1"]);
        throw new WorkspaceApiError("response lost", undefined,
          "workspace_network_error", "retry_read");
      },
    },
  });
  await tracker.submit("session-1", admission);
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  assert.equal((await tracker.cancel("session-1", "intent-1")).phase, "cancelling");
  assert.equal(cancels, 1);
  assert.equal(reads, 1);
});

test("lost cancel response rejects a lookup for another Run", async () => {
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => ({ operationId: "intent-1", sessionId: "session-1",
        phase: "running", acceptance: "acp", runId: "run-2", outputWatermark: 3 }),
      cancel: async () => { throw new WorkspaceApiError("response lost", undefined,
        "workspace_network_error", "retry_read"); },
    },
  });
  await tracker.submit("session-1", admission);
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  await assert.rejects(tracker.cancel("session-1", "intent-1"), /response lost/u);
  assert.equal(tracker.get("session-1", "intent-1")?.runId, "run-1");
});

test("closing a browser tracker releases local state without cancelling ACP work", async () => {
  let cancelled = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: {
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => { cancelled++; return {}; },
    },
  });
  await tracker.submit("session-1", admission);
  tracker.close();
  assert.equal(tracker.get("session-1", "intent-1"), undefined);
  assert.equal(cancelled, 0);
});
