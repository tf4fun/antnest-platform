import { requestFixture } from "../../e2e/acp-plan/trace-fixture.mjs";

export const replayAgent = "agent_" + "c".repeat(32);
export const replaySession = "22222222-3333-4444-8555-666666666666";
export function replayHistory() {
  const text = (value) => ({ type: "text", text: value });
  const rows = [
    {
      visible: true,
      payload: {
        kind: "user_message",
        messageId: "user-1",
        content: [text("fixture request")],
      },
    },
    {
      visible: false,
      payload: {
        kind: "agent_thought",
        messageId: "hidden-1",
        content: [text("hidden fixture")],
      },
    },
    {
      visible: true,
      payload: {
        kind: "tool_call",
        initial: true,
        toolCallId: "write-1",
        status: "completed",
        argumentsJson: JSON.stringify({
          path: "/workspace/note.txt",
          content: "after",
        }),
        rawOutputJson: JSON.stringify({ written: true }),
        fileJson: JSON.stringify({
          path: "/workspace/note.txt",
          change: { before: "before", after: "after" },
        }),
        content: [text("written")],
        toolKind: "edit",
        title: "Write fixture",
        modelName: "write",
      },
    },
    {
      visible: true,
      payload: {
        kind: "tool_call",
        initial: false,
        toolCallId: "read-1",
        status: "completed",
        argumentsJson: JSON.stringify({ path: "/workspace/note.txt" }),
        rawOutputJson: JSON.stringify({ text: "after" }),
        fileJson: JSON.stringify({
          path: "/workspace/note.txt",
          change: { before: "after", after: "after" },
        }),
        content: [],
        toolKind: "read",
        title: "Read fixture",
        modelName: "read",
      },
    },
    { visible: true, payload: { kind: "usage", used: 10, size: 100 } },
    {
      visible: true,
      payload: {
        kind: "agent_message",
        messageId: "agent-1",
        content: [text("fixture done")],
      },
    },
  ];
  const updates = [
    { sessionUpdate: "session_info_update", title: "Fixture" },
    {
      sessionUpdate: "user_message_chunk",
      messageId: "user-1",
      content: text("fixture request"),
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      status: "completed",
      rawInput: { path: "/workspace/note.txt", content: "after" },
      rawOutput: { written: true },
      content: [
        { type: "content", content: text("written") },
        {
          type: "diff",
          path: "/workspace/note.txt",
          oldText: "before",
          newText: "after",
        },
      ],
      locations: [{ path: "/workspace/note.txt" }],
      kind: "edit",
      title: "Write fixture",
      name: "write",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "read-1",
      status: "completed",
      rawInput: { path: "/workspace/note.txt" },
      rawOutput: { text: "after" },
      content: [],
      locations: [{ path: "/workspace/note.txt" }],
      kind: "read",
      title: "Read fixture",
      name: "read",
    },
    { sessionUpdate: "usage_update", used: 10, size: 100 },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "agent-1",
      content: text("fixture done"),
    },
  ].map((update) => ({ sessionId: replaySession, update }));
  return { rows, updates };
}

export function replayTrace({
  agentId = replayAgent,
  sessionId = replaySession,
  requestId,
  connectionTraceID,
  warning = false,
}) {
  const { trace } = requestFixture("session/load", connectionTraceID);
  trace.traceID = "d".repeat(32);
  for (const span of trace.spans) {
    span.traceID = trace.traceID;
    for (const ref of span.references)
      if (ref.refType === "CHILD_OF") ref.traceID = trace.traceID;
    for (const field of span.tags) {
      if (field.key === "antnest.agent.id") field.value = agentId;
      if (field.key === "antnest.session.id") field.value = sessionId;
    }
  }
  trace.spans[2].tags.push({
    key: "antnest.request.id",
    value: String(requestId),
  });
  if (warning)
    trace.spans[2].warnings = [
      "clock skew adjustment disabled; replay fixture",
    ];
  return trace;
}
