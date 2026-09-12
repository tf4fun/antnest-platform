import assert from "node:assert/strict";
import { test } from "node:test";
import { nativePrompt, providerContent } from "./fixtures.mjs";
import { decide, createModelFixture } from "./model.mjs";
import { inspectNativeTrace } from "./evidence.mjs";

function payload() {
  return {
    stream: true,
    model: "native-model",
    messages: [{ role: "user", content: providerContent("v1-ws") }],
  };
}

test("model oracle verifies all native bytes and original part order", () => {
  assert.equal(nativePrompt("v1-ws").length, 7);
  assert.equal(decide(payload()).text, "v1-ws native input verified");
  for (const mutate of [
    (p) => {
      p.messages[0].content[1].image_url.url += "wrong";
    },
    (p) => {
      p.messages[0].content[2].input_audio.data = "wrong";
    },
    (p) => {
      p.messages[0].content[4].file.file_data = "wrong";
    },
    (p) => {
      p.messages[0].content.reverse();
    },
    (p) => {
      p.messages[0].content.pop();
    },
    (p) => {
      p.model = "text-model";
    },
  ]) {
    const p = payload();
    mutate(p);
    assert.throws(() => decide(p));
  }
});

test("continuation cannot drop native history or reexecute a Tool", () => {
  const p = payload();
  p.messages.push({
    role: "assistant",
    content: "v1-ws native input verified",
  });
  p.messages.push({ role: "user", content: "v1-ws continue" });
  assert.equal(decide(p).phase, "v1-ws continue");
  const missing = structuredClone(p);
  missing.messages.shift();
  assert.throws(() => decide(missing));
  p.messages.push({ role: "tool", content: "unexpected" });
  assert.throws(() => decide(p));
});

function traceFixture() {
  const trace = { traceID: "trace", processes: {}, spans: [] };
  function add(id, service, name, parent, tags = {}) {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      spanID: id,
      processID: service,
      operationName: name,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: "trace", spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  }
  add("edge", "edge-gateway", "HTTP GET");
  add("prompt", "agent-acp-service", "acp.session.prompt", "edge");
  add("admit", "agent-acp-service", "agent_controller.acquire_run", "prompt");
  add("admitted", "agent-controller", "rpc", "admit");
  add("run", "agent-acp-service", "agent.run", "prompt", {
    "run.id": "run",
    "admission.id": "admission",
  });
  add("db", "agent-acp-service", "postgres.transaction", "run");
  add("write", "agent-acp-service", "postgres.query", "run");
  for (const name of ["mcp.runtime.info", "mcp.tools.list"]) {
    add(name, "agent-acp-service", name, "run", {
      "admission.id": "admission",
    });
    add(`${name}-runtime`, "antnest-runtime", "HTTP POST", name);
  }
  add("model", "agent-acp-service", "model.complete", "run", {
    "admission.id": "admission",
  });
  add("finish", "agent-acp-service", "agent_controller.finish_run", "run", {
    "admission.id": "admission",
    "run.terminal_class": "completed",
    "run.tool_effect_state": "none",
  });
  add("finished", "agent-controller", "rpc", "finish");
  return trace;
}
const expected = {
  runs: 1,
  modelRequests: [{ trace_id: "trace", model_span_id: "model" }],
};
test("trace oracle requires correlated model, admission closure and Runtime preparation", () => {
  assert.equal(inspectNativeTrace(traceFixture(), expected).runs, 1);
  for (const id of [
    "edge",
    "admit",
    "admitted",
    "run",
    "db",
    "write",
    "finish",
    "finished",
    "model",
    "mcp.runtime.info-runtime",
    "mcp.tools.list",
  ]) {
    const trace = traceFixture();
    trace.spans = trace.spans.filter((s) => s.spanID !== id);
    assert.throws(() => inspectNativeTrace(trace, expected), id);
  }
  const detached = traceFixture();
  detached.spans.find((s) => s.spanID === "model").references = [];
  assert.throws(() => inspectNativeTrace(detached, expected));
  const duplicate = traceFixture();
  duplicate.spans.push(duplicate.spans.at(-1));
  assert.throws(() => inspectNativeTrace(duplicate, expected));
  const tool = traceFixture();
  tool.spans.find((s) => s.spanID === "model").operationName = "mcp.tools.call";
  assert.throws(() => inspectNativeTrace(tool, expected));
  assert.throws(() =>
    inspectNativeTrace(traceFixture(), expected, ["admission"]),
  );
});

test("failed native attempt requires a failed closure but not a message transaction", () => {
  const trace = traceFixture();
  trace.spans = trace.spans.filter((s) => s.spanID !== "db");
  const terminal = trace.spans
    .find((s) => s.spanID === "finish")
    .tags.find((t) => t.key === "run.terminal_class");
  terminal.value = "failed";
  const failed = { runs: 1, modelRequests: [], localFailures: 1 };
  assert.equal(inspectNativeTrace(trace, failed).local_failures, 1);
  terminal.value = "completed";
  assert.throws(() => inspectNativeTrace(trace, failed));
});

test("zero-run evidence still requires the actual restore or denied operation", () => {
  const trace = traceFixture();
  trace.spans = trace.spans.slice(0, 2);
  const replay = {
    runs: 0,
    modelRequests: [],
    methods: ["acp.session.resume", "acp.session.fork"],
  };
  assert.throws(() => inspectNativeTrace(trace, replay));
  trace.spans[1].operationName = "acp.session.resume";
  trace.spans.push({
    ...trace.spans[1],
    spanID: "fork",
    operationName: "acp.session.fork",
  });
  assert.equal(inspectNativeTrace(trace, replay).runs, 0);
});

test("reference sentinel records even a failed or ignored fetch attempt", async () => {
  const server = createModelFixture();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = async () => (await fetch(`${base}/status`)).json();
    assert.equal((await status()).referenceRequests, 0);
    await fetch(`${base}/reference`);
    assert.equal((await status()).referenceRequests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
