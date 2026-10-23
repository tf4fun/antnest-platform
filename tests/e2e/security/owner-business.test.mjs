import assert from "node:assert/strict";
import test from "node:test";
import { inspectOwnerBusiness } from "./owner-business.mjs";

const agentId = `agent_${"a".repeat(32)}`;
const sessionId = `session_${"b".repeat(32)}`;
const runId = `run_${"c".repeat(32)}`;
const principalId = `user_${"d".repeat(32)}`;
const requestId = `request_${"e".repeat(32)}`;
const answer = "Foreground request completed.";
const createdAt = "2026-10-23T12:34:56.000001Z";
const updatedAt = "2026-10-23T12:34:57.000002Z";

function event(id, sequence, payload, visible = true) {
  return {
    id,
    sequence,
    kind: payload.kind,
    visible,
    payload,
    created_at: updatedAt,
  };
}

function fixture() {
  const outcome = {
    state: "completed",
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "none",
    stop_reason: "end_turn",
    error_class: null,
  };
  const input = [{ type: "text", text: "foreground during review" }];
  const measurement = { inputTokens: 8, outputTokens: 4 };
  return {
    agentId,
    sessionId,
    clientResult: {
      status: "passed",
      agent_id: agentId,
      session_id: sessionId,
    },
    // r.id/request_id/session_id plus the real acp_sessions JOIN columns.
    // The Session schema calls its principal column principal_id.
    runs: [
      {
        id: runId,
        request_id: requestId,
        session_id: sessionId,
        agent_id: agentId,
        principal_id: principalId,
        ...outcome,
      },
    ],
    // Flat AuditDetail from get-execution-audit, not an invented wrapper.
    audit: {
      run_id: runId,
      session_id: sessionId,
      agent_id: agentId,
      principal_id: principalId,
      ...outcome,
      created_at: createdAt,
      updated_at: updatedAt,
      input,
      execution_snapshot: {
        providerConnectionId: "foreground-provider",
        modelProfileId: "foreground-model",
        configurationRevision: 1,
        agentSpecRevision: "foreground-spec",
        executionRevision: "foreground-execution",
      },
      unknown_effect_source: null,
      usage_measurements: [measurement],
    },
    // AuditEvents scopes items by the requested Run. Items themselves have no
    // run_id/session_id; terminal facts are read from runs and AuditDetail.
    events: {
      stream: "execution",
      items: [
        event("message-user", 3, {
          kind: "user_message",
          messageId: "message-user",
          content: structuredClone(input),
        }),
        event("message-usage", 5, {
          kind: "usage",
          used: 12,
          size: 64000,
          measurement: structuredClone(measurement),
        }),
        event("message-answer", 8, {
          kind: "agent_message",
          messageId: "message-answer",
          content: [{ type: "text", text: answer }],
        }),
      ],
      next_cursor: null,
    },
  };
}

function accepted(input) {
  const before = structuredClone(input);
  const result = inspectOwnerBusiness(input);
  assert(result && typeof result === "object");
  assert.equal(result.run_id, runId);
  assert.equal(result.session_id, sessionId);
  assert.equal(result.agent_id, agentId);
  assert.deepEqual(
    input,
    before,
    "business inspection changed its source evidence",
  );
}

test("one actual foreground Run has matching client, SQL, audit and durable message evidence", () => {
  accepted(fixture());
});

test("the unique visible answer may retain multiple text blocks without demanding contiguous Session sequences", () => {
  const input = fixture();
  input.events.items[2].payload.content = [
    { type: "text", text: "Foreground request " },
    { type: "text", text: "completed." },
  ];
  accepted(input);
});

test("a hidden empty agent message cannot be confused with the unique visible final answer", () => {
  const input = fixture();
  input.events.items.splice(
    2,
    0,
    event(
      "message-hidden",
      6,
      {
        kind: "agent_message",
        messageId: "message-hidden",
        content: [],
      },
      false,
    ),
  );
  accepted(input);
});

test("zero, duplicate or non-array SQL results cannot stand in for one admitted Run", () => {
  for (const runs of [null, {}, [], [fixture().runs[0], fixture().runs[0]]]) {
    assert.throws(() => inspectOwnerBusiness({ ...fixture(), runs }));
  }
  const input = fixture();
  input.runs.push({
    ...input.runs[0],
    id: "foreign-run",
    agent_id: "foreign-agent",
    session_id: "foreign-session",
  });
  assert.throws(
    () => inspectOwnerBusiness(input),
    "a second Run was silently filtered away",
  );
});

test("the original client must finish successfully for the expected Agent and Session", () => {
  for (const field of ["agentId", "sessionId"])
    for (const value of ["foreign", "", null, undefined])
      assert.throws(() =>
        inspectOwnerBusiness({ ...fixture(), [field]: value }),
      );
  for (const result of [
    null,
    {},
    { status: "failed", agent_id: agentId, session_id: sessionId },
    { status: "warning", agent_id: agentId, session_id: sessionId },
    { status: "skipped", agent_id: agentId, session_id: sessionId },
    { status: "passed", agent_id: "foreign-agent", session_id: sessionId },
    { status: "passed", agent_id: agentId, session_id: "foreign-session" },
    { status: "passed", session_id: sessionId },
    { status: "passed", agent_id: agentId },
  ]) {
    assert.throws(() =>
      inspectOwnerBusiness({ ...fixture(), clientResult: result }),
    );
  }
});

test("all selected SQL ownership and terminal columns must actually exist", () => {
  for (const field of Object.keys(fixture().runs[0])) {
    const input = fixture();
    delete input.runs[0][field];
    assert.throws(() => inspectOwnerBusiness(input), `missing SQL ${field}`);
  }
});

for (const [field, values] of [
  ["id", ["foreign-run", "", null]],
  ["request_id", ["", null]],
  ["session_id", ["foreign-session", "", null]],
  ["agent_id", ["foreign-agent", "", null]],
  ["principal_id", ["foreign-principal", "", null]],
  [
    "state",
    ["admitting", "running", "failed", "cancelled", "unresolved", null],
  ],
  ["terminal_class", ["failed", "cancelled", "unresolved", null]],
  ["executor_state", ["cancellation_requested", "unknown", null]],
  ["tool_effect_state", ["settled", "unknown", null]],
  ["stop_reason", ["max_tokens", "max_turn_requests", "refusal", null]],
  ["error_class", ["provider_unavailable", "", undefined]],
]) {
  test(`SQL ${field} must prove this single completed foreground Run`, () => {
    for (const value of values) {
      const input = fixture();
      input.runs[0][field] = value;
      assert.throws(() => inspectOwnerBusiness(input));
    }
  });
}

test("AuditDetail must bind the actual SQL Run, Session, Agent and Session principal", () => {
  for (const field of ["run_id", "session_id", "agent_id", "principal_id"]) {
    for (const value of ["foreign", "", null, undefined]) {
      const input = fixture();
      input.audit[field] = value;
      assert.throws(() => inspectOwnerBusiness(input), `wrong audit ${field}`);
    }
  }
  for (const audit of [null, {}, { audit: fixture().audit }]) {
    assert.throws(() => inspectOwnerBusiness({ ...fixture(), audit }));
  }
});

test("AuditDetail independently confirms every terminal fact instead of trusting only the SQL state", () => {
  for (const [field, value] of [
    ["state", "running"],
    ["terminal_class", "failed"],
    ["executor_state", "unknown"],
    ["tool_effect_state", "settled"],
    ["stop_reason", "refusal"],
    ["error_class", "provider_unavailable"],
  ]) {
    const input = fixture();
    input.audit[field] = value;
    assert.throws(() => inspectOwnerBusiness(input));
    delete input.audit[field];
    assert.throws(() => inspectOwnerBusiness(input), `missing audit ${field}`);
  }
});

test("the complete execution event page is required rather than a permission page or an unfinished cursor", () => {
  for (const change of [
    (input) => {
      input.events = null;
    },
    (input) => {
      input.events.stream = "permissions";
    },
    (input) => {
      delete input.events.stream;
    },
    (input) => {
      input.events.items = null;
    },
    (input) => {
      input.events.next_cursor = "more-events";
    },
    (input) => {
      delete input.events.next_cursor;
    },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => inspectOwnerBusiness(input));
  }
});

test("an unexecuted or partial message history cannot satisfy completed Run facts", () => {
  for (const keep of [
    () => false,
    (item) => item.kind !== "user_message",
    (item) => item.kind !== "agent_message",
    (item) => item.kind === "usage",
  ]) {
    const input = fixture();
    input.events.items = input.events.items.filter(keep);
    assert.throws(() => inspectOwnerBusiness(input));
  }
});

test("the durable user message must be visible, unique and retain the audited input", () => {
  for (const change of [
    (input) => {
      input.audit.input = [{ type: "text", text: "another request" }];
      input.events.items[0].payload.content = structuredClone(
        input.audit.input,
      );
    },
    (input) => {
      input.events.items[0].visible = false;
    },
    (input) => {
      input.events.items[0].payload.content = [
        { type: "text", text: "another request" },
      ];
    },
    (input) => {
      input.events.items[0].payload.messageId = "foreign-user-message";
    },
    (input) => {
      input.events.items.unshift(
        event("second-user", 1, {
          kind: "user_message",
          messageId: "second-user",
          content: structuredClone(input.audit.input),
        }),
      );
    },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => inspectOwnerBusiness(input));
  }
});

test("only one visible durable agent message with the exact completed foreground text counts as execution", () => {
  for (const change of [
    (input) => {
      input.events.items[2].visible = false;
    },
    (input) => {
      input.events.items[2].payload.content = [];
    },
    (input) => {
      input.events.items[2].payload.content = [
        { type: "text", text: "not the completed request" },
      ];
    },
    (input) => {
      input.events.items[2].payload.messageId = "foreign-agent-message";
    },
    (input) => {
      input.events.items.push(
        event("second-answer", 10, {
          kind: "agent_message",
          messageId: "second-answer",
          content: [{ type: "text", text: answer }],
        }),
      );
    },
    (input) => {
      input.events.items.push(
        event("different-answer", 10, {
          kind: "agent_message",
          messageId: "different-answer",
          content: [{ type: "text", text: "different response" }],
        }),
      );
    },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => inspectOwnerBusiness(input));
  }
});

test("audit events preserve their real metadata, payload kind and strictly increasing unique Session sequence", () => {
  for (const change of [
    (items) => {
      items[1].id = items[0].id;
    },
    (items) => {
      items[0].id = "";
    },
    (items) => {
      items[0].sequence = 0;
    },
    (items) => {
      items[1].sequence = items[0].sequence;
    },
    (items) => {
      items[2].sequence = items[0].sequence - 1;
    },
    (items) => {
      items[2].sequence = Number.MAX_SAFE_INTEGER + 1;
    },
    (items) => {
      items[1].payload.kind = "agent_message";
    },
    (items) => {
      items[2].visible = "true";
    },
    (items) => {
      delete items[0].created_at;
    },
    (items) => {
      const user = items[0];
      const response = items[2];
      items[0] = { ...response, sequence: 3 };
      items[2] = { ...user, sequence: 8 };
    },
  ]) {
    const input = fixture();
    change(input.events.items);
    assert.throws(() => inspectOwnerBusiness(input));
  }
});
