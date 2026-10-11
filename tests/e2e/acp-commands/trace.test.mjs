import assert from "node:assert/strict";
import test from "node:test";
import {
  commandStrictOutcome,
  inspectCommandTrace,
  selectCommandTrace,
} from "./trace.mjs";
import { fixture } from "./trace-fixtures.mjs";

const inspect = (f) =>
  inspectCommandTrace(f.trace, f.expected, ["PRIVATE"], f.requests ?? []);

function catalogRead(f) {
  for (const [id, method] of [
    ["catalog-discover", "discover"],
    ["catalog-info", "resources/read"],
  ]) {
    f.add(
      `${id}-client`,
      "request",
      "HTTP POST antnest-runtime",
      undefined,
      5,
      {
        "span.kind": "client",
      },
    );
    f.add(
      `${id}-server`,
      `${id}-client`,
      "HTTP POST /mcp",
      "antnest-runtime",
      5,
      {
        "span.kind": "server",
        "rpc.method": method,
      },
    );
    f.add(
      `${id}-operation`,
      `${id}-server`,
      "runtime.mcp.operation",
      "antnest-runtime",
      5,
      {
        "rpc.method": method,
      },
    );
  }
  f.add(
    "catalog-executor",
    "catalog-info-operation",
    "runtime.executor",
    "antnest-runtime",
    5,
  );
  return f;
}

test("Session setup and command completion may refresh Skill metadata without model or tool execution", () => {
  for (const http of [false, true])
    for (const [kind, method] of [
      ["request", "session/new"],
      ["request", "session/load"],
      ["request", "session/resume"],
      ["request", "session/fork"],
      ["command", "session/prompt"],
    ]) {
      const f = catalogRead(fixture(kind, http));
      const previous = f.expected.method;
      f.expected.method = method;
      for (const span of f.trace.spans) {
        if (span.operationName === `acp ${previous}`)
          span.operationName = `acp ${method}`;
        for (const tag of span.tags)
          if (tag.key === "rpc.method" && tag.value === previous)
            tag.value = method;
      }
      const result = inspect(f);
      assert.equal(result.runtime_information_reads, 1);
      assert.equal(result.runtime_tool_calls, 0);
      assert.equal(result.no_model_or_tools, true);
      assert.equal(result.no_model_or_runtime, false);
    }
});

test("Skill catalog refresh cannot hide tool execution, detached calls, extra reads or rejected access", () => {
  for (const http of [false, true])
    for (const mutate of [
      (f) =>
        f.add(
          "hidden-tool",
          "catalog-info-operation",
          "runtime.mcp.tool",
          "antnest-runtime",
        ),
      (f) => {
        f.trace.spans.find(
          (s) => s.spanID === "catalog-info-server",
        ).tags[1].value = "tools/call";
      },
      (f) => {
        f.trace.spans.find(
          (s) => s.spanID === "catalog-info-operation",
        ).tags[0].value = "tools/call";
      },
      (f) => {
        f.trace.spans.find(
          (s) => s.spanID === "catalog-executor",
        ).references[0].spanID = "catalog-discover-operation";
      },
      (f) => {
        f.trace.spans.find(
          (s) => s.spanID === "catalog-info-server",
        ).references[0].spanID = "forward";
      },
      (f) =>
        f.add(
          "extra-read",
          "catalog-info-client",
          "HTTP POST /mcp",
          "antnest-runtime",
          5,
          { "span.kind": "server", "rpc.method": "resources/read" },
        ),
      (f) => f.add("hidden-model", "request", "model.complete"),
      (f) => {
        f.trace.spans = f.trace.spans.filter(
          (span) => span.spanID !== "catalog-discover-operation",
        );
      },
      (f) => {
        f.trace.spans = f.trace.spans.filter(
          (span) => span.processID !== "antnest-runtime",
        );
      },
      (f) => {
        f.expected.rejection = "session_access_denied";
      },
      (f) => {
        f.expected.method = "session/list";
        f.trace.spans[2].tags.find((t) => t.key === "rpc.method").value =
          "session/list";
      },
    ]) {
      const f = catalogRead(fixture("request", http));
      mutate(f);
      assert.throws(() => inspect(f));
    }
});

test("ordinary execution verifies the explicitly expected read tool after Rebuild", () => {
  const f = fixture("ordinary");
  f.expected.toolName = "read";
  const tool = f.trace.spans
    .find((s) => s.spanID === "call")
    .tags.find((t) => t.key === "tool.name");
  tool.value = "read";
  assert.equal(inspect(f).runtime_tool_calls, 1);
  tool.value = "bash";
  assert.throws(() => inspect(f));
  delete f.expected.toolName;
  assert.equal(inspect(f).runtime_tool_calls, 1);
});
test("command and replay traces verify actual request IDs across WebSocket and HTTP", () => {
  for (const http of [false, true])
    for (const kind of ["command", "request"]) {
      const f = fixture(kind, http),
        result = inspect(f);
      assert.equal(result.runs, kind === "command" ? 1 : 0);
      assert.equal(result.no_model_or_runtime, true);
      f.trace.spans[0].warnings = ["clock skew adjustment disabled"];
      assert.equal(inspect(f).strict_trace, "failed");
    }
  const first = fixture(),
    second = fixture();
  second.trace.traceID = "other";
  second.trace.spans[2].tags.find((t) => t.key === "antnest.request.id").value =
    "3";
  assert.equal(
    selectCommandTrace([first.trace, second.trace], first.expected),
    first.trace.traceID,
  );
  assert.throws(() =>
    selectCommandTrace([first.trace, first.trace], first.expected),
  );
  assert.equal(selectCommandTrace([second.trace], first.expected), undefined);
});
test("command evidence rejects old admission assumptions, missing persistence, execution and identity errors", () => {
  for (const http of [false, true])
    for (const mutate of [
      (f) => {
        f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "write");
      },
      (f) => {
        f.trace.spans.find((s) => s.spanID === "transaction").tags[1].value =
          "rolled_back";
      },
      (f) => {
        f.trace.spans.find((s) => s.spanID === "run").references[0].spanID =
          "root";
      },
      (f) => {
        f.expected.requestId = "foreign";
      },
      (f) => {
        f.expected.sessionId = "foreign";
      },
      (f) => {
        f.expected.agentId = "foreign";
      },
      (f) => {
        f.add("model", "run", "HTTP POST model");
      },
      (f) => {
        f.add("runtime", "run", "HTTP POST /mcp", "antnest-runtime");
      },
      (f) => {
        f.add(
          "management",
          "run",
          "agent_controller.acquire_run",
          "agent-controller",
        );
      },
      (f) => {
        f.add("credential", "run", "agent_controller.resolve_credential");
      },
      (f) => {
        f.trace.spans[0].tags.push({ key: "body", value: "PRIVATE" });
      },
      (f) => {
        f.trace.spans[0].logs = [
          { fields: [{ key: "antnest.payload.json", value: "{}" }] },
        ];
      },
      (f) => {
        f.trace.spans[2].tags.push({ key: "error", value: true });
      },
      (f) => {
        f.trace.spans.push(structuredClone(f.trace.spans[2]));
      },
    ]) {
      const f = fixture("command", http);
      mutate(f);
      assert.throws(() => inspect(f));
    }
  for (const http of [false, true]) {
    const f = fixture("request", http);
    f.add("run", "request", "agent.run");
    assert.throws(() => inspect(f));
  }
});
test("rejections require precise scoped ACP diagnostics with zero execution", () => {
  for (const http of [false, true])
    for (const rejection of [
      "access_denied",
      "session_access_denied",
      "unsupported_resource_content",
      "unsupported_audio_content",
    ]) {
      const f = fixture("request", http);
      f.expected.rejection = rejection;
      assert.throws(() => inspect(f));
      f.trace.spans[2].tags.push(
        { key: "antnest.outcome", value: "rejected" },
        { key: "rpc.response.status_code", value: -32020 },
        { key: "antnest.error.code", value: "-32020" },
      );
      assert.equal(inspect(f).rejection, rejection);
      f.add(
        "other-failure",
        "request",
        "postgresql transaction",
        undefined,
        3,
        { "antnest.outcome": "error" },
      );
      assert.throws(() => inspect(f));
    }
});
test("ordinary prompt correlates model HTTP spans and actual Bash execution after commands", () => {
  const f = fixture("ordinary");
  assert.equal(inspect(f).runtime_tool_calls, 1);
  for (const mutate of [
    (f) => {
      f.requests[0].model_span_id = "model-0";
    },
    (f) => {
      f.requests[1].model_span_id = f.requests[0].model_span_id;
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[0].value = "foreign";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "tool").references[0].spanID =
        "request";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "list").startTime = 100;
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[1].value = "write";
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "tool")
        .tags.push({ key: "error", value: true });
    },
  ]) {
    const f = fixture("ordinary");
    mutate(f);
    assert.throws(() => inspect(f));
  }
});

test("a v1 prompt whose socket closed mid-Run may fail only its own response dispatch", () => {
  const closed = (f) => {
    f.expected.closedBeforeResponse = true;
    f.trace.spans[2].tags.push(
      { key: "error", value: true },
      { key: "antnest.outcome", value: "error" },
      { key: "antnest.operation.phase", value: "acp.dispatch" },
      { key: "antnest.protocol.version", value: "v1" },
    );
    return f;
  };
  assert.equal(inspect(closed(fixture("ordinary"))).runtime_tool_calls, 1);
  const open = closed(fixture("ordinary"));
  delete open.expected.closedBeforeResponse;
  assert.throws(() => inspect(open), /unexpected command\/replay/);
  const v2 = closed(fixture("ordinary"));
  v2.trace.spans[2].tags.find(
    (t) => t.key === "antnest.protocol.version",
  ).value = "v2";
  assert.throws(() => inspect(v2));
  const tool = closed(fixture("ordinary"));
  tool.trace.spans
    .find((s) => s.spanID === "tool")
    .tags.push({ key: "error", value: true });
  assert.throws(() => inspect(tool));
});

test("command strict outcome accepts only the reviewed clock warning class", () => {
  const clock = {
    strict_trace: "failed",
    warning_count: 1,
    warnings: [
      "clock skew adjustment disabled; not applying calculated delta of -82.81µs",
    ],
  };
  const passed = { strict_trace: "passed" };
  assert.deepEqual(commandStrictOutcome([passed]), {
    strict_trace: "passed",
    accepted: true,
  });
  assert.deepEqual(commandStrictOutcome([passed, clock]), {
    strict_trace: "failed",
    clock_warnings_accepted: true,
    accepted: true,
  });
  assert.deepEqual(
    commandStrictOutcome([clock, { ...clock, warnings: ["missing parent"] }]),
    { strict_trace: "failed", accepted: false },
  );
});
