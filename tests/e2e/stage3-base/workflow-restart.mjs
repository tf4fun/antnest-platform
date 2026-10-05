import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { assertRPCParent } from "../observability/lifecycle-workflow.mjs";

// An explicit graceful Controller replacement, not a general retry exemption.
export function inspectWorkflowRestart(trace, tree, expected) {
  assert.equal(expected.kind, "rebuild");
  const one = (items, label) => {
    assert.equal(items.length, 1, `missing or duplicate ${label}`);
    return items[0];
  };
  const workflows = trace.spans.filter((s) =>
    s.operationName.startsWith("RunWorkflow:"),
  );
  assert.equal(
    workflows.length,
    2,
    "restart requires both original Workflow spans",
  );
  const old = one(
    workflows.filter(
      (s) => tag(s, "antnest.temporal.workflow.span_end") === "worker_shutdown",
    ),
    "stopped Workflow",
  );
  const resumed = one(
    workflows.filter(
      (s) => tag(s, "antnest.temporal.workflow.span_end") === "workflow_return",
    ),
    "returned Workflow",
  );
  const runID = tag(old, "temporalRunID");
  assert(runID, "Workflow Run identity missing");
  for (const workflow of workflows) {
    assert.equal(workflow.operationName, "RunWorkflow:LifecycleWorkflow");
    assert.equal(tree.service(workflow), "agent-controller");
    assert.equal(tag(workflow, "span.kind"), "server");
    assert.equal(
      tag(workflow, "temporalWorkflowID"),
      `agent-rebuild/${expected.requestId}`,
    );
    assert.equal(tag(workflow, "temporalRunID"), runID);
    assert(
      !hasError(workflow),
      "worker shutdown was misrepresented as workflow failure",
    );
  }
  assert.equal(
    tree.parent(old),
    tree.parent(resumed),
    "replacement lost original Workflow admission parent",
  );
  const attempts = trace.spans
    .filter((s) => s.operationName === "RunActivity:lifecycle.drain")
    .sort((a, b) => a.startTime - b.startTime);
  assert.equal(
    attempts.length,
    2,
    "expected one interrupted drain and one retry",
  );
  const [interrupted, completed] = attempts;
  assert(
    hasError(interrupted) && !hasError(completed),
    "incorrect drain retry outcomes",
  );
  assert.equal(
    tag(interrupted, "otel.status_description"),
    "agent-acp-service dependency failed with dependency_unavailable",
  );
  assert.equal(
    tree.parent(interrupted),
    tree.parent(completed),
    "retry rewrote durable scheduling parent",
  );
  assert(tree.chain(interrupted).includes(old), "old drain parent missing");
  const activityID = tag(interrupted, "temporalActivityID");
  assert(activityID, "drain Activity identity missing");
  for (const activity of attempts) {
    assert.equal(tag(activity, "temporalActivityID"), activityID);
    assert.equal(tag(activity, "temporalRunID"), runID);
    assert.equal(
      tag(activity, "temporalWorkflowID"),
      `agent-rebuild/${expected.requestId}`,
    );
    assert.equal(tree.service(activity), "agent-controller");
  }
  assert(
    interrupted.startTime + interrupted.duration <=
      old.startTime + old.duration,
    "shutdown parent ended before its interrupted Activity",
  );
  assert(
    old.startTime + old.duration <= completed.startTime,
    "drain retry preceded worker shutdown",
  );
  const inside = (s) => tree.chain(s).includes(interrupted);
  for (const span of trace.spans.filter(inside))
    assert(
      ["agent-controller", "agent-acp-service"].includes(tree.service(span)),
      "interrupted drain reached a mutation service",
    );
  assert.equal(
    trace.spans.filter(
      (s) =>
        inside(s) &&
        tree.service(s) === "agent-acp-service" &&
        tag(s, "span.kind") === "server",
    ).length,
    2,
    "unexpected RPC during interrupted drain",
  );
  const server = one(
    trace.spans.filter(
      (s) =>
        inside(s) &&
        tree.service(s) === "agent-acp-service" &&
        tag(s, "http.route") === "/rpc/agent-acp/settle-agent",
    ),
    "interrupted settlement SERVER",
  );
  assertRPCParent(tree, server, "agent-controller");
  const client = tree.parent(server);
  assert.equal(tag(server, "span.kind"), "server");
  assert.equal(tag(server, "http.request.method"), "POST");
  assert.equal(tag(server, "http.response.status_code"), undefined);
  assert.equal(tag(server, "antnest.outcome"), "disconnected");
  assert.equal(tag(server, "error.type"), "stream_interrupted");
  assert.equal(client.operationName, "HTTP POST agent-acp-service");
  assert.equal(tag(client, "rpc.method"), "settle_agent");
  assert.equal(tag(client, "server.address"), "agent-acp-control");
  assert.equal(tag(client, "antnest.operation.id"), expected.requestId);
  assert.equal(tag(client, "antnest.agent.id"), expected.agentId);
  assert.equal(tag(client, "antnest.outcome"), "canceled");
  assert.equal(tag(client, "error.type"), "canceled");
  assert.equal(tag(client, "antnest.error.code"), "canceled");
  assert.equal(tag(client, "antnest.settlement.outcome"), undefined);
  const errors = new Set([interrupted, client, server]);
  for (const span of errors)
    assert(hasError(span), "restart error disappeared");
  const revision = tag(client, "antnest.configuration.revision");
  assert(Number.isSafeInteger(revision) && revision > 0);
  for (const activity of attempts) {
    const applied = one(
      trace.spans.filter(
        (s) =>
          tree.chain(s).includes(activity) &&
          tree.service(s) === "agent-acp-service" &&
          tag(s, "http.route") === "/rpc/agent-acp/apply-execution-snapshot",
      ),
      "drain publication SERVER",
    );
    assertRPCParent(tree, applied, "agent-controller");
    assert.equal(tag(applied, "http.response.status_code"), 200);
    assert.equal(tag(applied, "antnest.configuration.revision"), revision);
    assert.equal(
      tag(tree.parent(applied), "antnest.configuration.applied_revision"),
      revision,
    );
    assert.equal(
      tag(tree.parent(applied), "antnest.configuration.revision"),
      revision,
    );
    if (activity === interrupted)
      assert(
        applied.startTime + applied.duration <= server.startTime,
        "interrupted settlement preceded publication",
      );
  }
  return { workflows, old, resumed, interrupted, completed, errors, runID };
}
