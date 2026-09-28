import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { assertRPCParent } from "../observability/lifecycle-workflow.mjs";
import { runtimeCommandId } from "./contracts.mjs";

// An explicit graceful Controller replacement, not a general retry exemption.
export function inspectUpdateRestart(trace, tree, expected) {
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
    .filter((s) => s.operationName === "RunActivity:lifecycle.runtime_update")
    .sort((a, b) => a.startTime - b.startTime);
  assert.equal(
    attempts.length,
    2,
    "expected canceled Update and terminal retry",
  );
  const [interrupted, completed] = attempts;
  assert(hasError(interrupted) && !hasError(completed));
  assert.equal(tree.parent(interrupted), tree.parent(completed));
  assert(tree.chain(interrupted).includes(old));
  assert.equal(
    tag(interrupted, "temporalActivityID"),
    tag(completed, "temporalActivityID"),
  );
  assert(tag(interrupted, "temporalActivityID"));
  assert(
    interrupted.startTime + interrupted.duration <=
      old.startTime + old.duration,
  );
  assert(old.startTime + old.duration <= completed.startTime);
  if (expected.updateRestart.fencedBeforeForward) {
    const child = runtimeCommandId(expected.requestId, "runtime_update");
    const interruptedClients = trace.spans.filter(
      (span) =>
        tree.chain(span).includes(interrupted) &&
        span.operationName === "HTTP POST runtime-controller" &&
        tag(span, "antnest.operation.request_id") === child,
    );
    const completedClients = trace.spans.filter(
      (span) =>
        tree.chain(span).includes(completed) &&
        span.operationName === "HTTP POST runtime-controller" &&
        tag(span, "antnest.operation.request_id") === child,
    );
    assert.equal(
      interruptedClients.length,
      1,
      "interrupted Update RPC is missing",
    );
    assert.equal(completedClients.length, 1, "resumed Update RPC is missing");
    const [canceled] = interruptedClients;
    const [delivered] = completedClients;
    assert(hasError(canceled));
    assert.equal(tag(canceled, "antnest.outcome"), "canceled");
    assert.equal(tag(canceled, "error.type"), "canceled");
    assert(
      !trace.spans.some(
        (span) =>
          tree.parent(span) === canceled &&
          tree.service(span) === "runtime-controller",
      ),
      "fenced request reached RC before restart",
    );
    assert(!hasError(delivered));
    const servers = trace.spans.filter(
      (span) =>
        tree.parent(span) === delivered &&
        tree.service(span) === "runtime-controller" &&
        tag(span, "http.route") === "/internal/runtimes/{agent_id}/update",
    );
    const server = one(servers, "resumed Runtime Update server");
    assertRPCParent(tree, server, "agent-controller");
    assert.equal(tag(server, "http.response.status_code"), 200);
    assert(!hasError(server));
    return {
      workflows,
      old,
      resumed,
      interrupted,
      completed,
      errors: new Set([interrupted, canceled]),
      runID,
      phase: "runtime_update",
      oldPhases: [
        "admit_lifecycle",
        "drain",
        "network_fence",
        "runtime_update",
      ],
    };
  }
  const records = expected.updateRestart.records;
  assert.equal(records.length, 2);
  assert.equal(records[0].delivery, "caller_disconnected");
  assert.equal(records[1].delivery, "delivered");
  for (const field of ["request_hash", "response_hash", "target_revision"]) {
    assert(records[0][field]);
    assert.equal(records[0][field], records[1][field]);
  }
  const errors = new Set([interrupted]);
  const child = runtimeCommandId(expected.requestId, "runtime_update");
  for (const [i, r] of records.entries()) {
    assert.equal(r.status, 200);
    assert.equal(r.request_id, child);
    assert.equal(r.agent_id, expected.agentId);
    const [, traceID, spanID] = r.traceparent.split("-");
    assert.equal(traceID, trace.traceID);
    const client = tree.spans.get(spanID);
    assert(client);
    assert(tree.chain(client).includes(attempts[i]));
    assert.equal(tree.service(client), "agent-controller");
    assert.equal(client.operationName, "HTTP POST runtime-controller");
    assert.equal(tag(client, "rpc.method"), "update");
    assert.equal(tag(client, "antnest.operation.request_id"), child);
    assert.equal(tag(client, "antnest.agent.id"), expected.agentId);
    const server = one(
      trace.spans.filter(
        (s) =>
          tree.parent(s) === client &&
          tree.service(s) === "runtime-controller" &&
          tag(s, "http.route") === "/internal/runtimes/{agent_id}/update",
      ),
      "committed Runtime Update server",
    );
    assertRPCParent(tree, server, "agent-controller");
    assert.equal(tag(server, "http.response.status_code"), 200);
    assert(!hasError(server));
    if (i === 0) {
      assert.equal(tag(client, "antnest.outcome"), "canceled");
      assert.equal(tag(client, "error.type"), "canceled");
      assert(hasError(client));
      errors.add(client);
    } else {
      assert.equal(tag(client, "http.response.status_code"), 200);
      assert(!hasError(client));
      assert(
        !trace.spans.some(
          (s) =>
            tree.chain(s).includes(server) &&
            tag(s, "peer.service") === "docker",
        ),
        "terminal replay repeated Docker work",
      );
    }
  }
  return {
    workflows,
    old,
    resumed,
    interrupted,
    completed,
    errors,
    runID,
    phase: "runtime_update",
    oldPhases: ["admit_lifecycle", "drain", "network_fence", "runtime_update"],
  };
}
