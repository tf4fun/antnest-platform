import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectRpcTrace, inspectClosedPrompt } from "./trace.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
function fixture() {
  const trace = { traceID: "1".repeat(32), processes: {}, spans: [] };
  const add = (id, parent, service, name, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    const span = {
      traceID: trace.traceID,
      spanID: id,
      processID: service,
      operationName: name,
      startTime: 1,
      duration: 1,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
    };
    trace.spans.push(span);
    return span;
  };
  add("root", null, "agent-controller", "publish");
  const records = ["dropped", "delivered"].map((delivery, i) => {
    add(
      `attempt${i}`,
      "root",
      "agent-controller",
      "agent_controller.execution_publication",
      {
        "span.kind": "internal",
        "antnest.organization.id": "org",
        ...(i
          ? { "antnest.configuration.applied_revision": 7 }
          : {
              "otel.status_code": "ERROR",
              "error.type": "execution_publication_failed",
              "antnest.outcome": "error",
            }),
      },
    );
    add(`source${i}`, `attempt${i}`, "agent-controller", "SELECT", {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.query.text":
        "SELECT revision FROM agent_controller.execution_configuration_sync WHERE organization_id=$1",
    });
    add(
      `client${i}`,
      `attempt${i}`,
      "agent-controller",
      "HTTP POST agent-acp-service",
      {
        "span.kind": "client",
        "rpc.method": "apply_execution_snapshot",
        "antnest.organization.id": "org",
        "antnest.configuration.revision": 7,
        ...(i
          ? { "antnest.configuration.applied_revision": 7 }
          : {
              "otel.status_code": "ERROR",
              "antnest.error.stage": "send",
              "error.type": "boundary_error",
            }),
      },
    );
    add(
      `server${i}`,
      `client${i}`,
      "agent-acp-service",
      "HTTP POST /rpc/agent-acp/apply-execution-snapshot",
      {
        "span.kind": "server",
        "http.request.method": "POST",
        "http.route": "/rpc/agent-acp/apply-execution-snapshot",
        "http.response.status_code": 200,
        "antnest.organization.id": "org",
        "antnest.configuration.revision": 7,
      },
    );
    add(`db${i}`, `server${i}`, "agent-acp-service", i ? "SELECT" : "UPDATE", {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": i ? "SELECT" : "UPDATE",
      "db.query.text": i
        ? "SELECT configuration FROM execution_configurations WHERE organization_id = $1"
        : "UPDATE execution_configurations SET revision=$1",
    });
    return {
      method: "apply-execution-snapshot",
      organization_id: "org",
      revision: 7,
      applied_revision: 7,
      traceparent: `00-${trace.traceID}-client${i}-01`,
      delivery,
    };
  });
  add("ack", "attempt1", "agent-controller", "UPDATE", {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "UPDATE",
    "db.query.text":
      "UPDATE agent_controller.execution_configuration_sync SET applied_revision=GREATEST(applied_revision, $2)",
  });
  return { trace, records, add };
}
test("actual lost and delivered HTTP attempts require owning ACP server and real persistence", () => {
  const f = fixture();
  assert.equal(
    inspectRpcTrace(f.trace, f.records, undefined, ["PRIVATE"]).receipts,
    2,
  );
  f.trace.spans[0].warnings = ["clock warning"];
  assert.equal(inspectRpcTrace(f.trace, f.records).strict_trace, "failed");
});
test("RPC proof rejects fake commit, missing/foreign HTTP parent, premature ack and unrelated errors", () => {
  for (const mutate of [
    (f) => {
      f.records[0].traceparent = "00-" + f.trace.traceID + "-foreign-01";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "db0");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "server0").references[0].spanID =
        "root";
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "client0")
        .tags.push({ key: "antnest.configuration.applied_revision", value: 7 });
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "client1")
        .tags.push({ key: "otel.status_code", value: "ERROR" });
    },
    (f) => {
      f.add("run", "root", "agent-acp-service", "agent.run");
    },
    (f) => {
      f.trace.spans[0].tags.push({ key: "body", value: "PRIVATE" });
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      inspectRpcTrace(f.trace, f.records, undefined, ["PRIVATE"]),
    );
  }
});
test("publication requires its own source and acknowledgement SQL; foreign or premature writes fail", () => {
  for (const mutate of [
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "ack");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "ack").references[0].spanID =
        "root";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "ack").references[0].spanID =
        "attempt0";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "source1");
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "attempt0")
        .tags.push({ key: "antnest.configuration.applied_revision", value: 7 });
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "attempt1")
        .tags.push({ key: "otel.status_code", value: "ERROR" });
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspectRpcTrace(f.trace, f.records));
  }
});
function settled() {
  const f = fixture();
  f.trace.spans = f.trace.spans.filter(
    (s) =>
      !["ack", "attempt0", "attempt1", "source0", "source1"].includes(s.spanID),
  );
  const set = (s, k, v) => {
    s.tags = s.tags.filter((t) => t.key !== k);
    s.tags.push({ key: k, value: v });
  };
  set(f.trace.spans[0], "http.response.status_code", 202);
  f.trace.spans[0].processID = "edge-gateway";
  f.trace.processes["edge-gateway"] = { serviceName: "edge-gateway" };
  f.add(
    "workflow",
    "root",
    "agent-controller",
    "RunWorkflow:LifecycleWorkflow",
    { temporalWorkflowID: "agent-rebuild/operation" },
  );
  for (let i = 0; i < 2; i++) {
    f.add(
      `drain${i}`,
      "workflow",
      "agent-controller",
      "RunActivity:lifecycle.drain",
      i ? {} : { "otel.status_code": "ERROR" },
    );
    const client = f.trace.spans.find((s) => s.spanID === `client${i}`),
      server = f.trace.spans.find((s) => s.spanID === `server${i}`),
      db = f.trace.spans.find((s) => s.spanID === `db${i}`);
    client.references[0].spanID = `drain${i}`;
    set(client, "rpc.method", "settle_agent");
    set(server, "http.route", "/rpc/agent-acp/settle-agent");
    for (const s of [client, server]) {
      set(s, "antnest.agent.id", "agent");
      set(s, "antnest.operation.id", "operation");
    }
    set(server, "antnest.settlement.outcome", "settled");
    if (i) set(client, "antnest.settlement.outcome", "settled");
    set(
      db,
      "db.query.text",
      "SELECT EXISTS (SELECT 1 FROM tool_attempts AS attempt JOIN runs ON true)",
    );
    Object.assign(f.records[i], {
      method: "settle-agent",
      minimum_revision: 7,
      agent_id: "agent",
      operation_id: "operation",
    });
    delete f.records[i].revision;
  }
  for (const phase of [
    "network_fence",
    "runtime_update",
    "network_ensure",
    "publish",
  ]) {
    f.add(
      phase,
      "workflow",
      "agent-controller",
      `RunActivity:lifecycle.${phase}`,
    );
    f.add(`${phase}-write`, phase, "agent-controller", "UPDATE", {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.query.text": "UPDATE agent_controller.operations SET phase=$1",
    });
  }
  f.lifecycle = {
    traceID: f.trace.traceID,
    requestId: "operation",
    agentId: "agent",
  };
  return f;
}
test("settlement loss requires the exact Rebuild retry, durable protection and advancement", () => {
  const check = (f) => inspectRpcTrace(f.trace, f.records, f.lifecycle);
  assert.equal(check(settled()).drain_attempts, 2);
  for (const mutate of [
    (f) => (f.records[1].operation_id = "other"),
    (f) => (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "db0")),
    (f) =>
      (f.trace.spans = f.trace.spans.filter(
        (s) => s.spanID !== "publish-write",
      )),
    (f) =>
      f.add(
        "extra",
        "workflow",
        "agent-controller",
        "RunActivity:lifecycle.drain",
      ),
    (f) =>
      (f.trace.spans.find((s) => s.spanID === "client0").references[0].spanID =
        "workflow"),
  ]) {
    const f = settled();
    mutate(f);
    assert.throws(() => check(f));
  }
});
test("closed-Agent prompt is rejected at the actual request without any execution", () => {
  const fixture = () => {
    const f = requestFixture("session/prompt");
    Object.assign(f.expected, {
      requestId: "2",
      kind: "request",
      transport: "websocket",
    });
    f.trace.spans[2].tags.push(
      ...Object.entries({
        "antnest.request.id": "2",
        "rpc.response.status_code": -32020,
        "antnest.outcome": "rejected",
        "antnest.error.code": "-32020",
      }).map(([key, value]) => ({ key, value })),
    );
    f.add("denied", "request", "acp.session.prompt", undefined, 3, {
      "antnest.outcome": "rejected",
      "antnest.error.code": "agent_unavailable",
    });
    return f;
  };
  const check = (f) => inspectClosedPrompt(f.trace, f.expected);
  assert.equal(check(fixture()).no_execution, true);
  for (const mutate of [
    (f) => (f.expected.requestId = "other"),
    (f) => f.add("run", "request", "agent.run"),
    (f) => f.add("tool", "request", "tool", "antnest-runtime"),
    (f) =>
      (f.trace.spans
        .at(-1)
        .tags.find((t) => t.key === "antnest.error.code").value = "agent_busy"),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => check(f));
  }
});
