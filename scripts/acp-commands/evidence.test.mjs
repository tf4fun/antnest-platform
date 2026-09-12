import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCatalog,
  assertOrdinaryTool,
  assertTranscript,
  inspectCommandTrace,
} from "./evidence.mjs";

test("ordinary Tool evidence follows each protocol and requires an actual result before reply", () => {
  for (const version of [1, 2]) {
    const result = {
      exit_code: 0,
      stdout: "phase",
      stderr: "",
      truncated: false,
      effect_state: "settled",
    };
    const frames = [
      {
        update: {
          sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
          toolCallId: "t",
          status: "in_progress",
        },
      },
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: JSON.stringify(result) },
            },
          ],
        },
      },
      {
        update: {
          sessionUpdate:
            version === 1 ? "agent_message_chunk" : "agent_message",
        },
      },
    ];
    assertOrdinaryTool(frames, version, "phase");
    for (const override of [
      { exit_code: 1 },
      { stdout: "", stderr: "phase" },
      { truncated: true },
      { effect_state: "unknown" },
    ]) {
      const broken = structuredClone(frames);
      broken[1].update.content[0].content.text = JSON.stringify({
        ...result,
        ...override,
      });
      assert.throws(() => assertOrdinaryTool(broken, version, "phase"));
    }
    for (const broken of [
      [],
      frames.slice(1),
      [frames[0], frames[2], frames[1]],
      [...frames.slice(0, 2), frames[1], frames[2]],
      [
        frames[0],
        { update: { ...frames[1].update, toolCallId: "other" } },
        frames[2],
      ],
      [frames[0], { update: { ...frames[1].update, content: [] } }, frames[2]],
      [
        {
          update: {
            ...frames[0].update,
            sessionUpdate: version === 1 ? "tool_call_update" : "tool_call",
          },
        },
        ...frames.slice(1),
      ],
    ]) {
      assert.throws(() => assertOrdinaryTool(broken, version, "phase"));
    }
  }
});

const catalog = {
  sessionId: "s",
  update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "help", description: "Show commands /帮助" }],
  },
};
test("catalog is complete and belongs to the requested Session", () => {
  assertCatalog([catalog], "s");
  for (const frames of [
    [],
    [catalog, catalog],
    [{ ...catalog, sessionId: "foreign" }],
    [{ ...catalog, update: { ...catalog.update, availableCommands: [] } }],
    [
      {
        ...catalog,
        update: {
          ...catalog.update,
          availableCommands: [{ name: "fake", description: "fake" }],
        },
      },
    ],
  ]) {
    assert.throws(() => assertCatalog(frames, "s"));
  }
});

test("transcript compares block identity and order, excluding derived notifications", () => {
  const expected = [
    { role: "user", content: [{ type: "text", text: "/help" }] },
    { role: "assistant", content: [{ type: "text", text: "help reply" }] },
  ];
  for (const version of [1, 2]) {
    const frames = expected.map((message) => ({
      sessionId: "s",
      update: {
        sessionUpdate:
          message.role === "user"
            ? version === 1
              ? "user_message_chunk"
              : "user_message"
            : version === 1
              ? "agent_message_chunk"
              : "agent_message",
        messageId: message.role,
        content: version === 1 ? message.content[0] : message.content,
      },
    }));
    assertTranscript([...frames, catalog], "s", expected);
    for (const broken of [
      frames.slice(1),
      [...frames, frames[1]],
      frames.toReversed(),
      [{ ...frames[0], sessionId: "foreign" }, frames[1]],
    ]) {
      assert.throws(() => assertTranscript(broken, "s", expected));
    }
    const attachment = {
      type: "resource",
      resource: { uri: "file:///notes.txt", text: "private" },
    };
    const withFile = structuredClone(frames);
    if (version === 1)
      withFile.splice(1, 0, {
        ...frames[0],
        update: { ...frames[0].update, content: attachment },
      });
    else withFile[0].update.content.push(attachment);
    assertTranscript(withFile, "s", [
      { ...expected[0], content: [...expected[0].content, attachment] },
      expected[1],
    ]);
    assert.throws(() =>
      assertTranscript(frames, "s", [
        { ...expected[0], content: [...expected[0].content, attachment] },
        expected[1],
      ]),
    );
  }
});

function fixture() {
  const spans = [];
  const add = (spanID, parent, operationName, processID = "a", tags = []) =>
    spans.push({
      spanID,
      operationName,
      processID,
      tags,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: "trace", spanID: parent }]
        : [],
    });
  add("gateway", null, "GET /acp", "g");
  add("prompt", "gateway", "acp.session.prompt");
  add("acquire", "prompt", "agent_controller.acquire_run");
  add("run", "gateway", "agent.run", "a", [
    { key: "admission.id", value: "admit" },
    { key: "run.id", value: "run-id" },
  ]);
  add("write", "run", "postgres.transaction");
  add("finish", "run", "agent_controller.finish_run", "a", [
    { key: "admission.id", value: "admit" },
  ]);
  add("controller", "finish", "POST /internal/rpc", "c");
  return {
    traceID: "trace",
    spans,
    processes: {
      g: { serviceName: "edge-gateway" },
      a: { serviceName: "agent-acp-service" },
      c: { serviceName: "agent-controller" },
      r: { serviceName: "antnest-runtime" },
    },
  };
}
const command = { runs: 1, methods: ["acp.session.prompt"] };
test("command trace proves admission, persistence, closure and no model/Runtime", () => {
  const result = inspectCommandTrace(fixture(), command);
  assert.equal(result.runs, 1);
  assert.equal(result.no_model_or_runtime, true);
});
test("trace oracle rejects incomplete, duplicated, orphaned or executing command paths", () => {
  for (const mutate of [
    (t) => {
      t.spans = [];
    },
    (t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "write");
    },
    (t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "finish");
    },
    (t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "acquire");
    },
    (t) => {
      t.spans.find((s) => s.spanID === "run").references = [];
    },
    (t) => {
      t.spans.find((s) => s.spanID === "write").references[0].spanID =
        "gateway";
    },
    (t) => {
      t.spans.find((s) => s.spanID === "finish").tags[0].value = "foreign";
    },
    (t) => {
      t.spans.push({ ...t.spans[2] });
    },
    (t) => {
      t.spans.push({
        ...t.spans[4],
        spanID: "model",
        operationName: "model.complete",
      });
    },
    (t) => {
      t.spans.push({ ...t.spans[4], spanID: "runtime", processID: "r" });
    },
    (t) => {
      t.spans.push({
        ...t.spans[4],
        spanID: "credential",
        operationName: "agent_controller.resolve_credential",
      });
    },
    (t) => {
      t.spans[0].tags = [{ key: "body", value: "PRIVATE" }];
    },
  ]) {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectCommandTrace(trace, command, ["PRIVATE"]));
  }
  assert.throws(() => inspectCommandTrace(undefined, command));
});
test("non-execution traces still require actual restore/rejection methods and Gateway ancestry", () => {
  const trace = fixture();
  trace.spans = trace.spans.slice(0, 2);
  trace.spans[1].operationName = "acp.session.resume";
  const expected = { runs: 0, methods: ["acp.session.resume"] };
  assert.equal(inspectCommandTrace(trace, expected).runs, 0);
  assert.throws(() =>
    inspectCommandTrace(trace, { ...expected, methods: ["acp.session.fork"] }),
  );
  trace.spans[1].references = [];
  assert.throws(() => inspectCommandTrace(trace, expected));
});
