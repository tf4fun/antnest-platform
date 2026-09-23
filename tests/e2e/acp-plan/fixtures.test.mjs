import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, phases, first, updated, marker, stepsFor } from "./model.mjs";
import { assertPlanEvents, planUpdates, relevantUpdates } from "./evidence.mjs";
import * as evidence from "./evidence.mjs";

test("model rejects reversed call/result messages and forged caller roles", () => {
  const value = payload("v1-clear", 1);
  [
    value.messages[value.messages.length - 2],
    value.messages[value.messages.length - 1],
  ] = [value.messages.at(-1), value.messages.at(-2)];
  assert.throws(() => decide(value), /order|paired/);
  const wrongRole = payload("v1-clear", 1);
  wrongRole.messages.at(-2).role = "tool";
  assert.throws(() => decide(wrongRole));
});

test("remote result must precede a later plan claiming the work completed", () => {
  for (const version of [1, 2]) {
    const phase = `v${version}-execute`;
    const local = frames(version, updated, phase);
    const start = {
      sessionId: "session",
      update: {
        sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
        toolCallId: "remote",
        status: "in_progress",
        rawInput: stepsFor(phase)[0].arguments,
      },
    };
    const end = {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "remote",
        status: "completed",
      },
    };
    assertPlanEvents(version, phase, [start, end, ...local]);
    assert.throws(
      () =>
        assertPlanEvents(version, phase, [
          start,
          local[0],
          local[1],
          end,
          local[2],
        ]),
      /order|precede/,
    );
  }
});

test("Session history rejects ID reuse across Runs, not progress or separate replay", () => {
  const history = [];
  const firstRun = relevantUpdates(frames(1, first));
  evidence.appendRunEvidence(history, firstRun);
  assert.deepEqual(history, firstRun);
  assert.throws(
    () =>
      evidence.appendRunEvidence(
        history,
        relevantUpdates(frames(1, [], "v1-clear")),
      ),
    /reused/,
  );
  const next = relevantUpdates(frames(1, [], "v1-clear"));
  next[1].toolCallId = "local-2";
  evidence.appendRunEvidence(history, next);
  assert.equal(history.length, 4);
});

function payload(phase, completed = 0) {
  const steps = stepsFor(phase);
  const before = phases.find((item) => phase.endsWith(`-${item.id}`)).before;
  return {
    stream: true,
    tools: ["write", "update_plan"].map((name) => ({ function: { name } })),
    messages: [
      { role: "system", content: "platform guidance" },
      ...(before === undefined
        ? []
        : [
            {
              role: "assistant",
              content: `Conversation plan at Run start (historical snapshot; later successful update_plan calls replace it):\n${JSON.stringify(before)}`,
            },
          ]),
      { role: "user", content: phase },
      ...steps.slice(0, completed).flatMap((step, index) => [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call-${index}`,
              type: "function",
              function: {
                name: step.name,
                arguments: JSON.stringify(step.arguments),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: `call-${index}`, content: step.result },
      ]),
    ],
  };
}

test("model verifies complete action/result sequence and Run-start snapshot", () => {
  for (const version of [1, 2])
    for (const item of phases) {
      const phase = `v${version}-${item.id}`;
      const steps = stepsFor(phase);
      for (let index = 0; index <= steps.length; index++) {
        const result = decide(payload(phase, index));
        assert.equal(result.stage, index);
        if (index < steps.length)
          assert.deepEqual(result.call, {
            name: steps[index].name,
            arguments: steps[index].arguments,
          });
        else assert.equal(result.text, `${phase} verified`);
      }
    }
});

test("model rejects stale/missing/system plan, missing tools and wrong results or call identity", () => {
  const noPlan = payload("v1-clear");
  noPlan.messages.splice(1, 1);
  assert.throws(() => decide(noPlan), /snapshot/);
  for (const mutation of [
    (value) => {
      value.messages[1].content = `Conversation plan at Run start\n${JSON.stringify(first)}`;
    },
    (value) => {
      value.messages[1].role = "system";
    },
    (value) => {
      value.messages.at(-1).content = "unverified result";
    },
    (value) => {
      value.messages.at(-1).tool_call_id = "wrong";
    },
    (value) => {
      value.messages.at(-2).tool_calls[0].function.arguments = "{}";
    },
    (value) => {
      value.tools = [];
    },
  ]) {
    const value = payload("v1-clear", 1);
    mutation(value);
    assert.throws(() => decide(value));
  }
  const cleared = payload("v1-recall");
  cleared.messages[1].content = `Conversation plan at Run start\n${JSON.stringify(updated)}`;
  assert.throws(() => decide(cleared));
  assert.throws(() => decide(payload("unknown")));
});

function frames(version, entries, phase = "v1-create") {
  return [
    {
      sessionUpdate: version === 1 ? "plan" : "plan_update",
      ...(version === 1
        ? { entries }
        : { plan: { type: "items", planId: "current", entries } }),
    },
    {
      sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
      toolCallId: "local-1",
      title: "Update plan",
      kind: "other",
      status: "completed",
      rawInput: { entries },
      content: [
        { type: "content", content: { type: "text", text: "Plan updated." } },
      ],
    },
    {
      sessionUpdate: version === 1 ? "agent_message_chunk" : "agent_message",
      content: { type: "text", text: `${phase} verified` },
    },
  ].map((update) => ({ sessionId: "session", update }));
}

test("oracle verifies exact plans and completion order, including explicit clear", () => {
  for (const version of [1, 2])
    for (const [id, entries] of [
      ["create", first],
      ["clear", []],
    ]) {
      const phase = `v${version}-${id}`;
      assertPlanEvents(version, phase, frames(version, entries, phase));
    }
});

test("oracle rejects absent/duplicate/late plan and mismatched result or stable ID", () => {
  for (const version of [1, 2]) {
    const phase = `v${version}-create`;
    const valid = frames(version, first, phase);
    for (const invalid of [
      [],
      valid.slice(1),
      [...valid, valid[0]],
      [valid[2], valid[0], valid[1]],
      [valid[0], valid[2]],
    ])
      assert.throws(() => assertPlanEvents(version, phase, invalid));
    for (const mutate of [
      (value) => {
        value[1].update.rawInput.entries = [];
      },
      (value) => {
        value[1].update.status = "in_progress";
      },
      (value) => {
        value[1].update.content = [];
      },
      (value) => {
        const p = value[0].update;
        (p.entries ?? p.plan.entries)[0].status = "completed";
      },
    ]) {
      const value = structuredClone(valid);
      mutate(value);
      assert.throws(() => assertPlanEvents(version, phase, value));
    }
    if (version === 2) {
      const value = structuredClone(valid);
      value[0].update.plan.planId = "random";
      assert.throws(() => assertPlanEvents(version, phase, value));
    }
  }
});

test("reply text is not a plan; replay selection preserves full plan and Tool updates", () => {
  const values = frames(1, first);
  assert.equal(planUpdates(values).length, 1);
  assert.equal(relevantUpdates(values).length, 2);
  assert.deepEqual(
    planUpdates([
      {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: marker },
        },
      },
    ]),
    [],
  );
  assert.throws(() => assertPlanEvents(1, "v1-recall", values));
});
