import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDurable, assertRecovered, assertReplay } from "./evidence.mjs";
const saved = (phase, recovered = false) => ({
  run: {
    run_id: "run",
    session_id: "s",
    state:
      phase === "finish"
        ? "completed"
        : recovered
          ? "failed"
          : phase === "intent"
            ? "admitting"
            : "running",
    terminal_class:
      phase === "finish"
        ? "completed"
        : recovered && phase === "accept"
          ? "failed"
          : null,
    executor_state:
      phase === "finish" || (recovered && phase === "accept")
        ? "quiescent"
        : null,
    tool_effect_state:
      phase === "finish"
        ? "settled"
        : recovered && phase === "accept"
          ? "none"
          : null,
    stop_reason: phase === "finish" ? "end_turn" : null,
    error_class: recovered
      ? `service_restarted_${phase === "intent" ? "before_execution" : "during_run"}`
      : null,
    execution_snapshot:
      phase === "intent" ? null : { runtime: { revision: "r" } },
  },
  events: {
    items:
      phase === "intent"
        ? []
        : [
            {
              id: "m",
              sequence: 1,
              kind: "user_message",
              visible: true,
              payload: {
                kind: "user_message",
                messageId: "m",
                content: [{ type: "text", text: "hello" }],
              },
            },
            ...(phase === "finish"
              ? [
                  {
                    id: "hidden",
                    sequence: 2,
                    kind: "agent_message",
                    visible: false,
                    payload: {
                      kind: "agent_message",
                      messageId: "hidden",
                      content: [],
                      toolCalls: [{ id: "tool", name: "bash", arguments: {} }],
                    },
                  },
                  {
                    id: "t",
                    sequence: 2,
                    kind: "tool_call",
                    visible: true,
                    payload: {
                      kind: "tool_call",
                      initial: false,
                      toolCallId: "tool",
                      status: "completed",
                      content: [],
                    },
                  },
                  {
                    id: "a",
                    sequence: 3,
                    kind: "agent_message",
                    visible: true,
                    payload: {
                      kind: "agent_message",
                      messageId: "a",
                      content: [{ type: "text", text: "answer" }],
                    },
                  },
                ]
              : []),
          ],
  },
});
test("commit evidence requires durable scoped state and exact recovery classification", () => {
  for (const phase of ["intent", "accept", "finish"]) {
    const a = saved(phase),
      b = saved(phase, phase !== "finish");
    const receipt = {
      phase,
      session_id: "s",
      run_id: "run",
      delivery: "held",
      command_tag: phase === "finish" ? "SELECT 1" : "COMMIT",
      query_hash: "a".repeat(64),
      receipt_id: "receipt",
    };
    assertDurable(a, receipt);
    assertRecovered(a, b, phase);
    assert.throws(() => assertDurable(a, { ...receipt, run_id: "foreign" }));
    assert.throws(() =>
      assertRecovered(a, { ...b, run: { ...b.run, state: "running" } }, phase),
    );
  }
});
test("replay matches current decoded audit payloads in one ordered timeline, including empty history", () => {
  for (const v of [1, 2])
    for (const phase of ["intent", "accept"]) {
      const a = saved(phase, true),
        updates = a.events.items.map((e) => ({
          sessionId: "s",
          update: {
            sessionUpdate: v === 1 ? "user_message_chunk" : "user_message",
            messageId: "m",
            content: v === 1 ? e.payload.content[0] : e.payload.content,
          },
        }));
      if (v === 2)
        updates.push({
          sessionId: "s",
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "_failed",
          },
        });
      assertReplay(v, updates, a, "s");
      assert.throws(() =>
        assertReplay(
          v,
          [
            ...updates,
            {
              sessionId: "s",
              update: {
                sessionUpdate: "agent_message",
                messageId: "invented",
                content: [],
              },
            },
          ],
          a,
          "s",
        ),
      );
      if (phase === "accept") {
        const wrong = structuredClone(updates);
        wrong[0].update.messageId = "changed";
        assert.throws(() => assertReplay(v, wrong, a, "s"));
      }
    }
});
test("Tool replay preserves arguments, raw output, locations, cancellation and usage cost", () => {
  const a = saved("accept", true);
  a.events.items = [
    {
      id: "t",
      sequence: 1,
      visible: true,
      payload: {
        kind: "tool_call",
        initial: false,
        toolCallId: "t",
        status: "cancelled",
        arguments: { command: "x" },
        rawOutput: { effect_state: "unknown" },
        content: [{ type: "text", text: "cancelled" }],
        locations: [],
      },
    },
    {
      id: "u",
      sequence: 2,
      visible: true,
      payload: {
        kind: "usage",
        used: 2,
        size: 10,
        cost: { amount: 1, currency: "USD" },
      },
    },
  ];
  for (const v of [1, 2]) {
    const updates = [
      {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: v === 1 ? "failed" : "cancelled",
          rawInput: { command: "x" },
          rawOutput: { effect_state: "unknown" },
          content: [
            { type: "content", content: { type: "text", text: "cancelled" } },
          ],
          locations: [],
        },
      },
      {
        sessionId: "s",
        update: {
          sessionUpdate: "usage_update",
          used: 2,
          size: 10,
          cost: { amount: 1, currency: "USD" },
        },
      },
      ...(v === 2
        ? [
            {
              sessionId: "s",
              update: {
                sessionUpdate: "state_update",
                state: "idle",
                stopReason: "_failed",
              },
            },
          ]
        : []),
    ];
    assertReplay(v, updates, a, "s");
    const wrong = structuredClone(updates);
    wrong[0].update.rawOutput.effect_state = "settled";
    assert.throws(() => assertReplay(v, wrong, a, "s"));
    assert.throws(() =>
      assertReplay(v, [updates[1], updates[0], ...updates.slice(2)], a, "s"),
    );
  }
});
