import assert from "node:assert/strict";
import test from "node:test";
import { storedPrompt } from "./fixtures.mjs";

const url = new URL("./run-business.mjs", import.meta.url);
const { inspectNativeRunBusiness: inspect, collectNativeRunBusiness: collect } =
  await import(url).catch((error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  });
const profiles = ["v1-ws", "v2-ws", "v1-http"];
function fixture() {
  const requests = [],
    all = [],
    items = [];
  for (const profile of profiles)
    for (const [i, step] of [
      "native",
      "continue",
      "mismatch",
      "restored",
    ].entries()) {
      const failed = step === "mismatch",
        n = requests.length;
      const phase = `${profile} ${step}`,
        sessionId = `session-${profile}`;
      const input =
        step === "native"
          ? storedPrompt(profile)
          : [{ type: "text", text: phase }];
      const messageId = `message-${n}`;
      requests.push({
        label: `${profile}:${step}`,
        kind: failed ? "local-failure" : "native",
        phase,
        agentId: "agent",
        sessionId,
        protocolVersion: profile === "v2-ws" ? 2 : 1,
        promptReceipt: {
          requestId: `rpc-${n}`,
          sessionId,
          result:
            profile === "v2-ws"
              ? { messageId }
              : failed
                ? null
                : { stopReason: "end_turn" },
        },
      });
      const summary = {
        run_id: `run-${n}`,
        agent_id: "agent",
        session_id: sessionId,
        principal_id: "owner",
        state: failed ? "failed" : "completed",
        created_at: "2026-10-21T00:00:00Z",
        updated_at: "2026-10-21T00:00:01Z",
      };
      const run = {
        ...summary,
        input,
        terminal_class: summary.state,
        executor_state: "quiescent",
        tool_effect_state: "none",
        unknown_effect_source: null,
        stop_reason: failed ? null : "end_turn",
        error_class: failed ? "model_unsupported_content" : null,
      };
      const events = {
        stream: "execution",
        next_cursor: null,
        items: [
          {
            id: messageId,
            sequence: i * 10 + 1,
            kind: "user_message",
            visible: true,
            payload: {
              kind: "user_message",
              messageId,
              content: structuredClone(input),
            },
          },
        ],
      };
      if (!failed)
        events.items.push(
          {
            id: `usage-${n}`,
            sequence: i * 10 + 2,
            kind: "usage",
            visible: true,
            payload: { kind: "usage", used: 3, size: 8192 },
          },
          {
            id: `reply-${n}`,
            sequence: i * 10 + 3,
            kind: "agent_message",
            visible: true,
            payload: {
              kind: "agent_message",
              messageId: `reply-${n}`,
              content: [
                { type: "text", text: `${profile} native input verified` },
              ],
            },
          },
        );
      items.push(summary);
      all.push({ run, events });
    }
  return {
    agent_ids: ["agent", "empty-agent"],
    principal_id: "owner",
    requests,
    agents: [
      { agent_id: "agent", page: { items, next_cursor: null }, all },
      {
        agent_id: "empty-agent",
        page: { items: [], next_cursor: null },
        all: [],
      },
    ],
  };
}
const api = () => assert.equal(typeof inspect, "function");
test("twelve native Runs are admitted from real audit fields without Trace metadata", () => {
  api();
  const e = fixture(),
    original = structuredClone(e);
  assert.deepEqual(inspect(e), {
    status: "passed",
    runs: 12,
    completed: 9,
    failed: 3,
    profiles: 3,
    other_agent_runs: 0,
  });
  assert.deepEqual(e, original);
});
for (const [name, mutate] of [
  ["missing Run", (e) => e.agents[0].all.pop()],
  [
    "duplicate Run",
    (e) => (e.agents[0].all[1] = structuredClone(e.agents[0].all[0])),
  ],
  [
    "extra list Run",
    (e) =>
      e.agents[0].page.items.push(structuredClone(e.agents[0].page.items[0])),
  ],
  [
    "other Agent executed",
    (e) =>
      e.agents[1].page.items.push(structuredClone(e.agents[0].page.items[0])),
  ],
  ["truncated Run page", (e) => (e.agents[0].page.next_cursor = "more")],
  [
    "truncated event page",
    (e) => (e.agents[0].all[0].events.next_cursor = "more"),
  ],
  [
    "wrong event stream",
    (e) => (e.agents[0].all[0].events.stream = "permissions"),
  ],
  ["foreign Session", (e) => (e.agents[0].all[0].run.session_id = "foreign")],
  [
    "foreign Principal",
    (e) => (e.agents[0].all[0].run.principal_id = "foreign"),
  ],
  ["foreign Agent", (e) => (e.agents[0].all[0].run.agent_id = "foreign")],
  ["mutated list state", (e) => (e.agents[0].page.items[0].state = "running")],
  ["running execution", (e) => (e.agents[0].all[0].run.state = "running")],
  [
    "unsettled executor",
    (e) => (e.agents[0].all[0].run.executor_state = "unknown"),
  ],
  [
    "unknown Tool effect",
    (e) => (e.agents[0].all[0].run.tool_effect_state = "unknown"),
  ],
  [
    "unknown effect source",
    (e) => (e.agents[0].all[0].run.unknown_effect_source = "runtime_mcp"),
  ],
  [
    "wrong terminal class",
    (e) => (e.agents[0].all[0].run.terminal_class = "failed"),
  ],
  [
    "wrong failed class",
    (e) => (e.agents[0].all[2].run.error_class = "internal_error"),
  ],
  [
    "wrong success reason",
    (e) => (e.agents[0].all[0].run.stop_reason = "refusal"),
  ],
  ["missing prompt identity", (e) => e.requests.pop()],
  ["duplicate phase", (e) => (e.requests[1].phase = e.requests[0].phase)],
  ["wrong request Session", (e) => (e.requests[0].sessionId = "foreign")],
  [
    "wrong prompt receipt Session",
    (e) => (e.requests[0].promptReceipt.sessionId = "foreign"),
  ],
  [
    "mismatched input attachment",
    (e) => (e.agents[0].all[0].run.input[1].data = "changed"),
  ],
  ["missing user message", (e) => e.agents[0].all[0].events.items.shift()],
  [
    "mutated user message",
    (e) => (e.agents[0].all[0].events.items[0].payload.content = []),
  ],
  [
    "wrong user message ID",
    (e) => (e.agents[0].all[0].events.items[0].payload.messageId = "foreign"),
  ],
  [
    "missing assistant persistence",
    (e) => e.agents[0].all[0].events.items.pop(),
  ],
  [
    "mutated assistant persistence",
    (e) =>
      (e.agents[0].all[0].events.items.at(-1).payload.content[0].text =
        "other"),
  ],
  [
    "duplicate message identity",
    (e) =>
      (e.agents[0].all[0].events.items[1].id =
        e.agents[0].all[0].events.items[0].id),
  ],
  [
    "duplicate event sequence",
    (e) =>
      (e.agents[0].all[0].events.items[1].sequence =
        e.agents[0].all[0].events.items[0].sequence),
  ],
  [
    "unexpected Tool",
    (e) => (e.agents[0].all[0].events.items[1].kind = "tool_call"),
  ],
  [
    "wrong v2 message receipt",
    (e) => (e.requests[4].promptReceipt.result.messageId = "foreign"),
  ],
])
  test(`native Run business rejects ${name}`, () => {
    api();
    const e = fixture();
    inspect(e);
    mutate(e);
    assert.throws(() => inspect(e));
  });
function reader(e, calls) {
  const responses = new Map();
  for (const agent of e.agents) {
    responses.set(
      `/api/admin/execution-audits?agent_id=${agent.agent_id}&limit=100`,
      agent.page,
    );
    for (const row of agent.all) {
      const path = `/api/admin/execution-audits/${row.run.run_id}`;
      responses.set(path, row.run);
      responses.set(`${path}/events?limit=100`, row.events);
    }
  }
  return async (path) => {
    calls.push(path);
    assert(responses.has(path));
    return structuredClone(responses.get(path));
  };
}
test("native Run collector reads both Agents and every detail/event before preserving a complete receipt", async () => {
  assert.equal(typeof collect, "function");
  const e = fixture(),
    calls = [];
  let saved;
  const result = await collect({
    agentIds: e.agent_ids,
    principalId: e.principal_id,
    requests: e.requests,
    read: reader(e, calls),
    preserve: (value) => {
      saved = structuredClone(value);
    },
  });
  assert.equal(calls.length, 26);
  assert.deepEqual(result, saved);
  inspect(result);
});
test("native audit or archive failure cannot become business success", async () => {
  assert.equal(typeof collect, "function");
  const e = fixture();
  let saved = false;
  await assert.rejects(
    collect({
      agentIds: e.agent_ids,
      principalId: e.principal_id,
      requests: e.requests,
      read: async () => {
        throw new Error("audit unavailable");
      },
      preserve: () => {
        saved = true;
      },
    }),
    /audit unavailable/u,
  );
  assert.equal(saved, true);
  await assert.rejects(
    collect({
      agentIds: e.agent_ids,
      principalId: e.principal_id,
      requests: e.requests,
      read: reader(e, []),
      preserve: () => {
        throw new Error("business archive failed");
      },
    }),
    /business archive failed/u,
  );
});
