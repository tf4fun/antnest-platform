import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseAgentExecutionState,
  parseExecutionObservation,
  parseIntentObservation,
  parseLearningChanges,
  parseLearningStatus,
} from "../src/adapters/acp-http.ts";
import { learningStatusSchema } from "../src/protocol/learning-status.ts";

interface SharedGoldenHelpers {
  loadGolden(area: string, file: string): unknown;
  withFutureFields(value: unknown): unknown;
}

const { loadGolden, withFutureFields } = (await import(
  new URL("../../../../../tests/support/contracts/golden.mjs", import.meta.url).href
)) as SharedGoldenHelpers;

const respond = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const clone = (value: unknown): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>;

test("workspace execution golden decodes and tolerates extensions", async () => {
  const document = loadGolden("agent-acp", "workspace-execution.running.json");
  const baseline = await parseExecutionObservation(respond(document));
  const extended = await parseExecutionObservation(respond(withFutureFields(document)));
  assert.deepEqual(extended, baseline);
  assert.equal(baseline.sessionId, "session1");
  assert.equal(baseline.appendVersion, 1);
  assert.equal(baseline.activeRunId, "run1");
});

test("workspace intent golden decodes and tolerates extensions", async () => {
  const document = loadGolden("agent-acp", "workspace-intent.running.json");
  const baseline = await parseIntentObservation(respond(document));
  const extended = await parseIntentObservation(respond(withFutureFields(document)));
  assert.deepEqual(extended, baseline);
  assert.equal(baseline.kind, "receipt");
  if (baseline.kind === "receipt") {
    assert.equal(baseline.receipt.intentId, "intent1");
    assert.equal(baseline.receipt.sessionId, "session1");
    assert.equal(baseline.receipt.phase, "running");
  }
});

test("learning status golden decodes and tolerates extensions", async () => {
  const document = loadGolden("skill-learning", "learning-status.blocked.json");
  const baseline = await parseLearningStatus(respond(document), "agent-1");
  const extended = await parseLearningStatus(respond(withFutureFields(document)), "agent-1");
  assert.deepEqual(extended, baseline);
  assert.equal(baseline.agentId, "agent-1");
  assert.equal(baseline.blocked?.reason, "model_unavailable");
});

test("learning changes golden decodes and tolerates extensions", async () => {
  const document = loadGolden("skill-learning", "learning-changes.empty.json");
  const baseline = await parseLearningChanges(respond(document), "agent-1");
  const extended = await parseLearningChanges(respond(withFutureFields(document)), "agent-1");
  assert.deepEqual(extended, baseline);
  assert.equal(baseline.items.length, 0);
});

test("learning status schema stays strict on direct unknown members", () => {
  const document = loadGolden("skill-learning", "learning-status.blocked.json");
  assert.equal(learningStatusSchema.safeParse(withFutureFields(document)).success, false);
});

test("invalid known fields reject even with extensions", async () => {
  const intent = loadGolden("agent-acp", "workspace-intent.running.json");
  const observation = loadGolden("agent-acp", "workspace-execution.running.json");
  const status = loadGolden("skill-learning", "learning-status.blocked.json");
  const page = loadGolden("skill-learning", "learning-changes.empty.json");

  const unknownPhase = clone(intent);
  unknownPhase.phase = "sideways";
  await assert.rejects(parseIntentObservation(respond(withFutureFields(unknownPhase))));

  const runningError = clone(intent);
  runningError.errorClass = "runtime_unreachable";
  await assert.rejects(parseIntentObservation(respond(withFutureFields(runningError))));

  const fraction = clone(observation);
  fraction.appendVersion = 1.5;
  await assert.rejects(parseExecutionObservation(respond(withFutureFields(fraction))));

  const noReceipts = clone(observation);
  delete noReceipts.recentReceipts;
  await assert.rejects(parseExecutionObservation(respond(withFutureFields(noReceipts))));

  const badReason = clone(status);
  (badReason.blocked as Record<string, unknown>).reason = "unknown_reason";
  await assert.rejects(parseLearningStatus(respond(withFutureFields(badReason)), "agent-1"));

  await assert.rejects(
    parseLearningStatus(respond(withFutureFields(status)), "agent-2"),
  );

  const badCursor = clone(page);
  badCursor.nextCursor = 42;
  await assert.rejects(parseLearningChanges(respond(withFutureFields(badCursor)), "agent-1"));
});

test("agent execution state decodes ready and rejects foreign or inconsistent state", async () => {
  const ready = {
    agent_id: "agent-1",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    availability: "ready",
    active_session_id: null,
    unavailable_reason: null,
  };
  const baseline = await parseAgentExecutionState(respond(ready), "agent-1");
  const extended = await parseAgentExecutionState(respond(withFutureFields(ready)), "agent-1");
  assert.deepEqual(extended, baseline);

  await assert.rejects(
    parseAgentExecutionState(respond(withFutureFields({ ...ready, agent_id: "agent-2" })), "agent-1"),
  );
  await assert.rejects(
    parseAgentExecutionState(
      respond(withFutureFields({ ...ready, active_session_id: "session-1" })),
      "agent-1",
    ),
  );
});
