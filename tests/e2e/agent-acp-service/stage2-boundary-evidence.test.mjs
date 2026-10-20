import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentReferences,
  inspectExecutionBoundary,
  inspectTemporalHistory,
  assertNoCredentials,
} from "./stage2-boundary-evidence.mjs";
import { traceTree, traceTopology } from "../observability/trace-tree.mjs";

function temporalHistory(value, encoding = "json/plain") {
  const base64 = (text) => Buffer.from(text).toString("base64");
  return {
    events: [
      {
        activityTaskCompletedEventAttributes: {
          result: {
            payloads: [
              {
                metadata: { encoding: base64(encoding) },
                data: base64(JSON.stringify(value)),
              },
            ],
          },
        },
      },
    ],
  };
}

test("Temporal evidence decodes raw payloads before checking business data and secrets", () => {
  assert.equal(
    inspectTemporalHistory(
      temporalHistory({ agent_id: "agent-test" }),
      "agent-test",
    ),
    1,
  );
  assert.throws(
    () =>
      inspectTemporalHistory(
        temporalHistory({ agent_id: "agent-test", key: "stage2-model-secret" }),
        "agent-test",
      ),
    /credential/u,
  );
  assert.throws(
    () =>
      inspectTemporalHistory(
        temporalHistory({ unrelated: true }),
        "agent-test",
      ),
    /business payload/u,
  );
  assert.throws(
    () =>
      inspectTemporalHistory(
        temporalHistory({}, "binary/encrypted"),
        "agent-test",
      ),
    /encoding/u,
  );
  assert.throws(
    () => inspectTemporalHistory({ events: [] }, "agent-test"),
    /empty/u,
  );
});

test("Agent comparison uses current nested contract, never two undefined legacy fields", () => {
  const agent = {
    runtime: { runtime_revision: "revision" },
    configuration: { template: { revision: 1 } },
  };
  assert.deepEqual(agentReferences(agent), {
    runtime: agent.runtime,
    template: agent.configuration.template,
  });
  assert.throws(() =>
    agentReferences({ runtime_revision: "old", template_revision: 1 }),
  );
  assert.throws(() => agentReferences({ runtime: agent.runtime }));
});

function fixture() {
  const make = (traceID) => ({ traceID, spans: [], processes: {} });
  const add = (trace, id, name, service, parent, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    const span = {
      traceID: trace.traceID,
      spanID: id,
      processID: service,
      operationName: name,
      duration: 10,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
    };
    trace.spans.push(span);
    return span;
  };
  const source = make("run");
  add(source, "client", "prompt scenario", "antnest-stage2-client");
  add(source, "prompt", "acp session/prompt", "agent-acp-service", "client", {
    "antnest.session.id": "session-id",
    "antnest.agent.id": "agent-id",
    "rpc.method": "session/prompt",
  });
  add(
    source,
    "submission",
    "acp.session.prompt",
    "agent-acp-service",
    "prompt",
  );
  const run = make("run");
  add(run, "run", "agent.run", "agent-acp-service", "submission", {
    "antnest.run.id": "run-id",
    "antnest.session.id": "session-id",
  });
  add(run, "model", "HTTP POST model", "agent-acp-service", "run", {
    "span.kind": "client",
  });
  add(run, "mcp", "HTTP POST antnest-runtime", "agent-acp-service", "run", {
    "span.kind": "client",
  });
  add(run, "tool", "tools/call", "antnest-runtime", "mcp", {
    "span.kind": "server",
    "rpc.method": "tools/call",
  });
  add(run, "sql", "INSERT", "agent-acp-service", "run", {
    "db.system.name": "postgresql",
    "db.operation.name": "INSERT",
    "span.kind": "client",
    "db.query.text": "INSERT INTO runs (id) VALUES ($1)",
  });
  run.spans.push(...source.spans);
  Object.assign(run.processes, source.processes);
  add(
    run,
    "runtime-operation",
    "runtime.mcp.operation",
    "antnest-runtime",
    "tool",
    {
      "span.kind": "internal",
      "rpc.method": "tools/call",
      "mcp.tool.name": "write",
    },
  );
  add(
    run,
    "runtime-write",
    "runtime.mcp.tool",
    "antnest-runtime",
    "runtime-operation",
    {
      "span.kind": "internal",
      "mcp.tool.name": "write",
    },
  );
  return { source: run, run };
}
test("execution proves a descendant Run, model call, Runtime request and ACP persistence without Controller", () => {
  const actual = inspectExecutionBoundary(fixture());
  assert.equal(actual.run_id, "run-id");
  assert.equal(actual.agent_id, "agent-id");
  assert.equal(actual.runtime_tool_calls, 1);
});
test("execution binds the original Run Agent to its submitting Prompt", () => {
  const value = fixture();
  value.run.spans
    .find((span) => span.spanID === "run")
    .tags.push({ key: "antnest.agent.id", value: "foreign" });
  assert.throws(() => inspectExecutionBoundary(value));
});
test("Stage2 rejects a different Runtime Tool pretending to be the required write", () => {
  const value = fixture();
  value.run.spans
    .find((span) => span.spanID === "runtime-operation")
    .tags.find((row) => row.key === "mcp.tool.name").value = "read";
  assert.throws(() => inspectExecutionBoundary(value));
});
test("Stage2 binds the write operation and Tool to the original Runtime receiver", () => {
  const value = fixture();
  value.run.spans.find(
    (span) => span.spanID === "runtime-operation",
  ).references[0].spanID = "mcp";
  assert.throws(() => inspectExecutionBoundary(value));
});
test("Stage2 secret checks include original session and workload credentials in decoded history", () => {
  const secret = "actual-stage2-credential-example";
  assert.throws(() => assertNoCredentials({ leaked: secret }, [secret]));
  assert.throws(() =>
    inspectTemporalHistory(
      temporalHistory({ agent_id: "agent-test", secret }),
      "agent-test",
      [secret],
    ),
  );
});
test("HTTP and WebSocket prompts use the RPC method and exact ancestry, not a hardcoded span title", () => {
  const value = fixture();
  value.source.spans.find((span) => span.spanID === "prompt").operationName =
    "HTTP POST /v1/acp";
  assert.equal(inspectExecutionBoundary(value).prompt_span_id, "prompt");
});
test("topology diagnostics do not remove the strict warning failure or alter the original trace", () => {
  const { run } = fixture();
  run.spans[0].warnings = ["clock skew adjustment disabled"];
  const before = JSON.stringify(run);
  assert.doesNotThrow(() => traceTopology(run));
  assert.throws(() => traceTree(run), /warnings require review/u);
  assert.equal(JSON.stringify(run), before);
});
for (const [name, change] of [
  [
    "reverse Controller request",
    ({ run }) => {
      run.processes.controller = { serviceName: "agent-controller" };
      run.spans[1].processID = "controller";
    },
  ],
  [
    "missing parent",
    ({ run }) => {
      run.spans[2].references[0].spanID = "missing";
    },
  ],
  [
    "wrong prompt link",
    ({ run }) => {
      run.spans[0].references[0].spanID = "client";
    },
  ],
  [
    "valid prompt from another Session",
    ({ source }) => {
      source.spans.find((span) => span.spanID === "prompt").tags[0].value =
        "another-session";
    },
  ],
  [
    "Runtime health request instead of a Tool call",
    ({ run }) => {
      run.spans[3].operationName = "HTTP GET /status";
      run.spans[3].tags = [{ key: "span.kind", value: "server" }];
    },
  ],
  [
    "missing model",
    ({ run }) => {
      run.spans.splice(1, 1);
    },
  ],
  [
    "missing runtime",
    ({ run }) => {
      run.spans.splice(3, 1);
    },
  ],
  [
    "missing persistence",
    ({ run }) => {
      run.spans.splice(4, 1);
    },
  ],
  [
    "database read alone instead of execution persistence",
    ({ run }) => {
      run.spans[4].operationName = "SELECT";
      run.spans[4].tags[1].value = "SELECT";
    },
  ],
  [
    "legacy lowercase database operation",
    ({ run }) => {
      run.spans[4].tags[1].value = "insert";
    },
  ],
  [
    "database wrapper instead of the driver operation",
    ({ run }) => {
      run.spans[4].operationName = "postgresql transaction";
    },
  ],
  [
    "database span without CLIENT kind",
    ({ run }) => {
      run.spans[4].tags.find((field) => field.key === "span.kind").value =
        "internal";
    },
  ],
  [
    "database span without native query metadata",
    ({ run }) => {
      run.spans[4].tags = run.spans[4].tags.filter(
        (field) => field.key !== "db.query.text",
      );
    },
  ],
  [
    "secret inside captured payload",
    ({ run }) => {
      run.spans[0].logs = [
        {
          fields: [
            {
              key: "antnest.payload.json",
              value: '{"credential":"stage2-model-secret"}',
            },
          ],
        },
      ];
    },
  ],
])
  test(`rejects ${name}`, () => {
    const value = fixture();
    change(value);
    assert.throws(() => inspectExecutionBoundary(value));
  });
