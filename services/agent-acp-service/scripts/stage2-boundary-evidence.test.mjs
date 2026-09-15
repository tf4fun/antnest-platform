import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentReferences,
  inspectExecutionBoundary,
  inspectTemporalHistory,
} from "./stage2-boundary-evidence.mjs";
import { traceTree, traceTopology } from "../../../scripts/observability/trace-tree.mjs";

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
    inspectTemporalHistory(temporalHistory({ agent_id: "agent-test" }), "agent-test"),
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
    () => inspectTemporalHistory(temporalHistory({ unrelated: true }), "agent-test"),
    /business payload/u,
  );
  assert.throws(
    () => inspectTemporalHistory(temporalHistory({}, "binary/encrypted"), "agent-test"),
    /encoding/u,
  );
  assert.throws(() => inspectTemporalHistory({ events: [] }, "agent-test"), /empty/u);
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
  assert.throws(() => agentReferences({ runtime_revision: "old", template_revision: 1 }));
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
      references: parent ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }] : [],
    };
    trace.spans.push(span);
    return span;
  };
  const source = make("run");
  add(source, "client", "prompt scenario", "antnest-stage2-client");
  add(source, "prompt", "acp session/prompt", "agent-acp-service", "client", {
    "antnest.session.id": "session-id",
    "rpc.method": "session/prompt",
  });
  add(source, "submission", "acp.session.prompt", "agent-acp-service", "prompt");
  const run = make("run");
  add(run, "run", "agent.run", "agent-acp-service", "submission", {
    "antnest.run.id": "run-id",
    "antnest.session.id": "session-id",
  });
  add(run, "model", "HTTP POST model", "agent-acp-service", "run", { "span.kind": "client" });
  add(run, "mcp", "HTTP POST antnest-runtime", "agent-acp-service", "run", {
    "span.kind": "client",
  });
  add(run, "tool", "tools/call", "antnest-runtime", "mcp", {
    "span.kind": "server",
    "rpc.method": "tools/call",
  });
  add(run, "sql", "INSERT", "agent-acp-service", "run", {
    "db.system.name": "postgresql",
    "db.operation.name": "insert",
  });
  run.spans.push(...source.spans);
  Object.assign(run.processes, source.processes);
  return { source: run, run };
}
test("execution proves a descendant Run, model call, Runtime request and ACP persistence without Controller", () => {
  assert.equal(inspectExecutionBoundary(fixture()).run_id, "run-id");
});
test("HTTP and WebSocket prompts use the RPC method and exact ancestry, not a hardcoded span title", () => {
  const value = fixture();
  value.source.spans.find((span) => span.spanID === "prompt").operationName = "HTTP POST /v1/acp";
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
      source.spans.find((span) => span.spanID === "prompt").tags[0].value = "another-session";
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
      run.spans[4].tags[1].value = "select";
    },
  ],
  [
    "secret inside captured payload",
    ({ run }) => {
      run.spans[0].logs = [
        {
          fields: [{ key: "antnest.payload.json", value: '{"credential":"stage2-model-secret"}' }],
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
