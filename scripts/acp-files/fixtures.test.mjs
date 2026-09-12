import assert from "node:assert/strict";
import { test } from "node:test";
import { cases, caseFor, decide, contentMarker } from "./model.mjs";
import { assertFileEvents, inspectReplayTrace } from "./evidence.mjs";

function payload(phase, results = []) {
  return {
    stream: true,
    tools: ["read", "write", "edit"].map((name) => ({ function: { name } })),
    messages: [
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
  };
}

function frames(item, version) {
  const initial = {
    sessionUpdate: "tool_call",
    toolCallId: "one",
    status: "in_progress",
    kind: item.tool === "read" ? "read" : "edit",
    rawInput: item.args,
  };
  const final = {
    sessionUpdate: "tool_call_update",
    toolCallId: "one",
    status: item.error ? "failed" : "completed",
    content: [{ type: "content", content: { type: "text", text: "result" } }],
  };
  if (!item.error) final.locations = [{ path: item.path }];
  if (item.change)
    final.content.push(
      version === 1
        ? {
            type: "diff",
            path: item.path,
            oldText: item.change.before,
            newText: item.change.after,
          }
        : {
            type: "diff",
            changes: [
              {
                path: item.path,
                operation: item.change.before === null ? "add" : "modify",
                fileType: "text",
              },
            ],
            ...(item.change.after === ""
              ? {}
              : {
                  patch: {
                    format: "git_patch",
                    text: "diff --git /workspace/f /workspace/f\n",
                  },
                }),
          },
    );
  return [initial, final].map((update) => ({ update }));
}

test("model selects actual native tools and validates results for all deployed paths", () => {
  assert.equal(cases.length, 8);
  for (const version of [1, 2])
    for (const item of cases) {
      const phase = `v${version}-${item.id}`;
      assert.equal(caseFor(phase), item);
      assert.deepEqual(decide(payload(phase)).call, {
        name: item.tool,
        arguments: item.args,
      });
      const content = JSON.stringify(item.result);
      assert.equal(decide(payload(phase, [content])).text, `${phase} verified`);
      assert.throws(() => decide(payload(phase, ["{}"])), /result/);
      assert.throws(
        () => decide(payload(phase, [content, content])),
        /redispatched/,
      );
    }
});

test("model rejects unknown scenarios, missing tools and metadata leakage", () => {
  assert.throws(() => decide(payload("invalid")));
  assert.throws(() => decide({ ...payload("v1-create"), tools: [] }));
  assert.throws(() => decide({ ...payload("v1-create"), stream: false }));
  const value = { ...cases[0].result, "io.antnest.runtime/file": {} };
  assert.throws(
    () => decide(payload("v1-create", [JSON.stringify(value)])),
    /metadata/,
  );
  assert.throws(
    () =>
      decide(
        payload("v1-create", [
          JSON.stringify({ ...cases[0].result, fileJson: "private" }),
        ]),
      ),
    /metadata/,
  );
});

test("edit context sentinel cannot leak through any model message role", () => {
  for (const role of ["system", "assistant", "tool"]) {
    const value = payload("v1-edit");
    value.messages.unshift({ role, content: contentMarker });
    assert.throws(() => decide(value), /file context/);
  }
});

test("replay evidence requires real lifecycle traces and rejects every execution path", () => {
  const value = {
    traceID: "replay",
    processes: {
      g: { serviceName: "edge-gateway" },
      a: { serviceName: "agent-acp-service" },
      r: { serviceName: "antnest-runtime" },
    },
    spans: [
      { spanID: "1", operationName: "GET /acp", processID: "g" },
      ...["resume", "fork"].map((method, index) => ({
        spanID: String(index + 2),
        operationName: `acp.session.${method}`,
        processID: "a",
        references: [{ refType: "CHILD_OF", spanID: "1" }],
      })),
    ],
  };
  assert.equal(inspectReplayTrace(value).no_execution, true);
  assert.throws(() => inspectReplayTrace(undefined));
  assert.throws(() =>
    inspectReplayTrace({ ...value, spans: value.spans.slice(0, 1) }),
  );
  for (const operationName of [
    "model.complete",
    "mcp.tools.call",
    "mcp.tools.list",
    "mcp.runtime.info",
  ])
    assert.throws(() =>
      inspectReplayTrace({
        ...value,
        spans: [
          ...value.spans,
          { spanID: "extra", operationName, processID: "a" },
        ],
      }),
    );
  assert.throws(() =>
    inspectReplayTrace({
      ...value,
      spans: [
        ...value.spans,
        { spanID: "extra", operationName: "runtime.mcp.tool", processID: "r" },
      ],
    }),
  );
  const leaked = structuredClone(value);
  leaked.spans[1].tags = [{ key: "preview", value: contentMarker }];
  assert.throws(() => inspectReplayTrace(leaked, [contentMarker]));
});

test("oracle distinguishes complete file observations from location-only and errors", () => {
  for (const version of [1, 2])
    for (const item of cases)
      assertFileEvents(version, item, frames(item, version));
  assert.equal(
    cases.find((item) => item.id === "empty-create").change.before,
    null,
  );
  assert.equal(
    cases.find((item) => item.id === "empty-replace").change.before,
    "",
  );
});

test("oracle rejects missing, duplicate, late or misidentified terminal Tool events", () => {
  const item = cases[0];
  const valid = frames(item, 1);
  for (const invalid of [
    [],
    valid.slice(0, 1),
    [...valid, valid[1]],
    [...valid, valid[0]],
  ])
    assert.throws(() => assertFileEvents(1, item, invalid));
  const changed = structuredClone(valid);
  changed[1].update.toolCallId = "different";
  assert.throws(() => assertFileEvents(1, item, changed));
});

test("oracle rejects missing/fragmentary/wrong-path diff and false modifications", () => {
  for (const version of [1, 2]) {
    const item = cases[1];
    const missing = frames(item, version);
    missing[1].update.content = [];
    assert.throws(() => assertFileEvents(version, item, missing));
    const wrong = frames(item, version);
    wrong[1].update.locations = [{ path: "/wrong" }];
    assert.throws(() => assertFileEvents(version, item, wrong));
    for (const id of ["read", "unchanged", "large-write", "failed-edit"]) {
      const noChange = cases.find((value) => value.id === id);
      const forged = frames(noChange, version);
      forged[1].update.content.push({ type: "diff", path: noChange.path });
      assert.throws(() => assertFileEvents(version, noChange, forged));
    }
  }
  const fragment = frames(cases[1], 1);
  fragment[1].update.content[1].oldText = cases[1].args.old_string;
  assert.throws(() => assertFileEvents(1, cases[1], fragment));
});

test("v2 requires a real patch for nonempty representable changes", () => {
  const value = frames(cases[0], 2);
  delete value[1].update.content[1].patch;
  assert.throws(() => assertFileEvents(2, cases[0], value));
  const wrong = frames(cases[0], 2);
  wrong[1].update.content[1].changes[0].operation = "modify";
  assert.throws(() => assertFileEvents(2, cases[0], wrong));
});

test("initial intent cannot contain a successful diff for any ending", () => {
  for (const version of [1, 2])
    for (const item of cases) {
      const value = frames(item, version);
      value[0].update.locations = [{ path: item.path }];
      assertFileEvents(version, item, value);
      value[0].update.content = [{ type: "diff", path: item.path }];
      assert.throws(() => assertFileEvents(version, item, value), /initial/);
    }
});
