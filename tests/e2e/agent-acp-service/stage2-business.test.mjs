import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./stage2-business.mjs", import.meta.url);
const { assertStage2BusinessInventory } = await import(url).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
    throw error;
  return {};
});
const scenarios = [
  "create",
  "same-run-credential-rotation",
  "controller-offline-execution",
  "rebuild-active-execution",
  "disable-enable",
  "acp-crash-records-interruption-without-replay",
  "identity-revocation",
  "delete-and-retain-execution-audit",
  "authenticated-audit-consumer",
];
function fixture() {
  const events = [
    { sessionUpdate: "tool_call", toolCallId: "tool" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Stage 2 Runtime Tool execution completed.",
      },
    },
  ];
  return {
    agentId: "agent",
    scenarios,
    auditReads: 48,
    audits: Array.from({ length: 7 }, (_, i) => ({
      agent_id: "agent",
      session_id: `session-${i}`,
      run_id: `run-${i}`,
      state: i === 6 ? "failed" : "completed",
    })),
    interrupted: {
      run_id: "run-6",
      state: "failed",
      error_class: "service_restarted_during_run",
    },
    modelCalls: {
      requests: Array.from({ length: 13 }, (_, i) => ({
        request_number: i + 1,
        has_tool_result: i !== 10 && (i < 10 ? i % 2 === 1 : i === 12),
      })),
      attempts: Array.from({ length: 13 }, (_, i) => ({
        status: i === 10 ? 499 : 200,
      })),
    },
    private: {
      connections: [
        {
          agentId: "agent",
          version: 2,
          closed: true,
          evidence: Array.from({ length: 5 }, (_, i) => ({
            method: "session/prompt",
            outcome: "succeeded",
            sessionId: `session-${i}`,
            requestParams: { sessionId: `session-${i}` },
            completion: {
              ack: { messageId: `user-${i}` },
              events: [
                { sessionUpdate: "user_message", messageId: `user-${i}` },
                { sessionUpdate: "state_update", state: "running" },
                {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "tool",
                  status: "completed",
                },
                {
                  sessionUpdate: "agent_message",
                  messageId: "reply",
                  content: [
                    {
                      type: "text",
                      text: "Stage 2 Runtime Tool execution completed.",
                    },
                  ],
                },
                {
                  sessionUpdate: "state_update",
                  state: "idle",
                  stopReason: "end_turn",
                },
              ].map((update) => ({ sessionId: `session-${i}`, update })),
            },
          })),
        },
      ],
      http: [
        {
          agentId: "agent",
          version: 1,
          closed: true,
          evidence: [
            {
              method: "session/prompt",
              outcome: "succeeded",
              sessionId: "session-5",
              requestParams: { sessionId: "session-5" },
              completion: {
                result: { stopReason: "end_turn" },
                events: structuredClone(events),
              },
            },
          ],
        },
      ],
    },
    management: [{ kind: "create" }, { kind: "rebuild" }],
    workflows: ["create", "rebuild", "disable", "enable", "delete"].map(
      (k) => `agent-${k}/original`,
    ),
  };
}
test("Stage 2 business inventory uses original SDK completions and persisted audits without collected Trace", () => {
  assert.equal(typeof assertStage2BusinessInventory, "function");
  const value = fixture(),
    before = structuredClone(value);
  assert.equal(assertStage2BusinessInventory(value).runtime_writes, 6);
  assert.deepEqual(value, before);
});
for (const [name, mutate] of [
  ["missing completion", (f) => f.private.http[0].evidence.pop()],
  [
    "missing Tool",
    (f) => f.private.http[0].evidence[0].completion.events.splice(1, 1),
  ],
  [
    "failed prompt",
    (f) =>
      (f.private.http[0].evidence[0].completion.result.stopReason =
        "cancelled"),
  ],
  [
    "foreign Session",
    (f) => (f.private.http[0].evidence[0].sessionId = "other"),
  ],
  ["foreign audit", (f) => (f.audits[0].agent_id = "other")],
  ["running audit", (f) => (f.audits[0].state = "running")],
  [
    "extra model replay",
    (f) => f.modelCalls.requests.push(f.modelCalls.requests[0]),
  ],
  ["model failure", (f) => (f.modelCalls.attempts[0].status = 503)],
  ["omitted workflow", (f) => f.workflows.pop()],
  ["omitted scenario", (f) => (f.scenarios = f.scenarios.slice(1))],
  ["omitted audit read", (f) => f.auditReads--],
  ["unjoined connection", (f) => (f.private.http[0].closed = false)],
])
  test(`Stage 2 still blocks ${name} without Trace`, () => {
    assert.equal(typeof assertStage2BusinessInventory, "function");
    const value = fixture();
    mutate(value);
    assert.throws(() => assertStage2BusinessInventory(value));
  });
