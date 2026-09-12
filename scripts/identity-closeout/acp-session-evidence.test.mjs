import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectSessionTrace,
  assertCompletedRun,
  assertEmptySession,
} from "./acp-session-evidence.mjs";

for (const version of [1, 2])
  test(`v${version}: empty Session permits only its command catalog and idle control state`, () => {
    const catalog = {
      sessionId: "s",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "Also /帮助" }],
      },
    };
    const idle = {
      sessionId: "s",
      update: { sessionUpdate: "state_update", state: "idle" },
    };
    const valid = version === 1 ? [catalog] : [idle, catalog];
    assertEmptySession([catalog], "s", version, "new");
    assertEmptySession(valid, "s", version, "replay");
    assert.throws(() =>
      assertEmptySession([idle, catalog], "s", version, "new"),
    );
    if (version === 2) {
      assert.throws(() =>
        assertEmptySession([catalog], "s", version, "replay"),
      );
      for (const update of [
        { ...idle.update, state: "running" },
        { ...idle.update, stopReason: "end_turn" },
      ])
        assert.throws(
          () =>
            assertEmptySession(
              [{ ...idle, update }, catalog],
              "s",
              version,
              "replay",
            ),
          /rejected prompt entered Session history or execution/,
        );
    }
    for (const type of [
      "user_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "usage_update",
      "config_option_update",
    ])
      assert.throws(() =>
        assertEmptySession(
          [...valid, { sessionId: "s", update: { sessionUpdate: type } }],
          "s",
          version,
          "replay",
        ),
      );
    assert.throws(() => assertEmptySession([], "s", version, "replay"));
    assert.throws(() =>
      assertEmptySession([...valid, catalog], "s", version, "replay"),
    );
    assert.throws(() =>
      assertEmptySession(valid, "foreign", version, "replay"),
    );
    assert.throws(() =>
      assertEmptySession(
        [...valid, { ...idle, update: { ...idle.update, state: "running" } }],
        "s",
        version,
        "replay",
      ),
    );
  });

function traceFixture() {
  const traceID = "a".repeat(32);
  return {
    traceID,
    processes: { edge: { serviceName: "edge-gateway" } },
    spans: [
      {
        spanID: "root",
        processID: "edge",
        operationName: "HTTP GET",
        tags: [
          { key: "http.response.status_code", value: 101 },
          { key: "span.kind", value: "server" },
        ],
        references: [],
      },
      ...[1, 2, 3, 4].map((n) => ({
        spanID: String(n),
        processID: "edge",
        operationName: "HTTP POST identity-service",
        tags: [
          { key: "span.kind", value: "client" },
          { key: "rpc.method", value: "/rpc/identity/resolve-access-token" },
          ...(n === 4 ? [{ key: "error", value: true }] : []),
        ],
        references: [{ refType: "CHILD_OF", traceID, spanID: "root" }],
      })),
    ],
  };
}
test("session traces require complete message-check evidence, not just handshake presence", () => {
  const trace = traceFixture();
  assert.equal(inspectSessionTrace(trace, trace.traceID, []).session_checks, 4);
  for (const mutate of [
    (t) => t.spans.pop(),
    (t) => (t.spans[4].tags = []),
    (t) => (t.spans[4].references = []),
    (t) => (t.spans[4].references[0].traceID = "b".repeat(32)),
    (t) => (t.spans[0].tags = []),
    (t) => (t.spans[4].processID = "unknown"),
    (t) =>
      (t.spans[0].tags.find((tag) => tag.key === "span.kind").value = "client"),
    (t) =>
      (t.spans[4].tags.find((tag) => tag.key === "rpc.method").value =
        "/rpc/identity/local-login"),
  ]) {
    const invalid = traceFixture();
    mutate(invalid);
    assert.throws(() => inspectSessionTrace(invalid, trace.traceID, []));
  }
  assert.throws(() => inspectSessionTrace(trace, "b".repeat(32), []));
  assert.throws(() =>
    inspectSessionTrace(trace, trace.traceID, ["resolve-access-token"]),
  );
});

test("completed Run requires same admission, released authority, no cancellation and one settled Tool", () => {
  const running = { id: "run", admission_id: "admission" };
  const run = {
    ...running,
    state: "completed",
    terminal_class: "completed",
    stop_reason: "end_turn",
    error_class: null,
    cancel_requested_at: null,
    admission_finished_at: "date",
  };
  const tools = [{ state: "completed" }];
  assertCompletedRun(run, running, tools);
  for (const fields of [
    { id: "other" },
    { admission_id: "other" },
    { state: "failed" },
    { terminal_class: "cancelled" },
    { stop_reason: "refusal" },
    { error_class: "lost" },
    { admission_finished_at: null },
    { cancel_requested_at: "date" },
  ])
    assert.throws(() =>
      assertCompletedRun({ ...run, ...fields }, running, tools),
    );
  for (const invalid of [[], [...tools, ...tools], [{ state: "unresolved" }]])
    assert.throws(() => assertCompletedRun(run, running, invalid));
});
