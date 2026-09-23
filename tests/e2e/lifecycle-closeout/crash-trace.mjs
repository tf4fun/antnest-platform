import assert from "node:assert/strict";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import {
  assertRPCParent,
  lifecyclePlans,
} from "../observability/lifecycle-workflow.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";

// The raw trace remains untouched and strictly failed. Only the new process's
// recovery and the surviving Controller workflow can claim complete topology.
export function inspectCrashTrace(trace, expected, secrets = []) {
  assert.equal(expected.kind, "rebuild");
  assert.equal(trace.traceID, expected.traceID);
  const proof = expected.crashRecovery;
  assert(["before-create", "after-start"].includes(proof.phase));
  assert.equal(proof.crash.exit_code, 137);
  assert.equal(proof.crash.oom_killed, false);
  const child = runtimeCommandId(expected.requestId, "runtime_update");
  assert.equal(proof.checkpoint.ac.request_id, expected.requestId);
  assert.equal(proof.checkpoint.rc.request_id, child);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const one = (items, label) => {
    assert.equal(items.length, 1, `missing or duplicate ${label}`);
    return items[0];
  };
  const spans = new Map(trace.spans.map((s) => [s.spanID, s]));
  assert.equal(spans.size, trace.spans.length);
  const service = (s) => trace.processes[s.processID]?.serviceName;
  const instance = (s) =>
    tag(trace.processes[s.processID], "service.instance.id");
  const parents = new Map(),
    missing = [];
  for (const s of trace.spans) {
    assert.equal(s.traceID, trace.traceID);
    assert(service(s));
    const refs = (s.references ?? []).filter((r) => r.refType === "CHILD_OF");
    assert(refs.length <= 1);
    if (refs.length) {
      assert.equal(refs[0].traceID, trace.traceID);
      parents.set(s, spans.get(refs[0].spanID));
      if (!spans.has(refs[0].spanID))
        missing.push({ span_id: s.spanID, parent_id: refs[0].spanID });
    }
  }
  const chain = (s) => {
    const path = [];
    while (s) {
      assert(!path.includes(s), "cyclic ancestry");
      path.push(s);
      s = parents.get(s);
    }
    return path;
  };
  for (const s of trace.spans) chain(s);
  const attempts = trace.spans
    .filter((s) => s.operationName === "RunActivity:lifecycle.runtime_update")
    .sort((a, b) => a.startTime - b.startTime);
  assert(
    attempts.length >= 2 && attempts.length <= 8,
    "unexpected retry count",
  );
  const completed = attempts.at(-1),
    failed = attempts.slice(0, -1);
  assert(!hasError(completed));
  assert(tag(completed, "temporalActivityID"));
  for (const attempt of failed) {
    assert(hasError(attempt));
    assert.equal(
      tag(attempt, "temporalActivityID"),
      tag(completed, "temporalActivityID"),
    );
    assert.equal(parents.get(attempt), parents.get(completed));
  }
  for (const activity of attempts) {
    assert.equal(service(activity), "agent-controller");
    assert.equal(
      tag(activity, "temporalWorkflowID"),
      `agent-rebuild/${expected.requestId}`,
    );
    const client = one(
      trace.spans.filter(
        (s) =>
          chain(s).includes(activity) &&
          service(s) === "agent-controller" &&
          tag(s, "antnest.operation.request_id") !== undefined,
      ),
      "same-child runtime client",
    );
    assert.equal(tag(client, "antnest.agent.id"), expected.agentId);
    assert.equal(tag(client, "antnest.operation.request_id"), child);
    if (failed.includes(activity)) assert(hasError(client));
  }
  const server = one(
    trace.spans.filter(
      (s) =>
        chain(s).includes(completed) &&
        service(s) === "runtime-controller" &&
        tag(s, "http.route") === "/internal/runtimes/{agent_id}/update" &&
        tag(s, "http.response.status_code") === 200,
    ),
    "successful Runtime Update",
  );
  const newInstance = instance(server);
  assert(newInstance, "recovery process identity missing");
  const oldInstances = new Set(
    trace.spans
      .filter(
        (s) =>
          service(s) === "runtime-controller" && instance(s) !== newInstance,
      )
      .map(instance),
  );
  assert(
    oldInstances.size <= 1 && !oldInstances.has(undefined),
    "unknown Runtime process",
  );
  for (const gap of missing) {
    const s = spans.get(gap.span_id);
    assert.equal(service(s), "runtime-controller", "unrelated missing parent");
    assert(oldInstances.has(instance(s)), "recovery process lost parent");
    assert(
      chain(s).every(
        (p) =>
          service(p) === "runtime-controller" && oldInstances.has(instance(p)),
      ),
    );
  }
  const excluded = trace.spans.filter(
    (s) =>
      failed.some((attempt) => chain(s).includes(attempt)) ||
      (service(s) === "runtime-controller" && oldInstances.has(instance(s))),
  );
  const retained = trace.spans.filter((s) => !excluded.includes(s));
  const projection = { ...trace, spans: retained };
  const tree = traceTopology(projection);
  assertRPCParent(tree, server, "agent-controller");
  const workflows = retained.filter((s) =>
    s.operationName.startsWith("RunWorkflow:"),
  );
  const workflow = one(workflows, "surviving Workflow");
  assert.equal(
    tag(workflow, "temporalWorkflowID"),
    `agent-rebuild/${expected.requestId}`,
  );
  assert(tag(workflow, "temporalRunID"));
  for (const a of attempts) {
    assert(chain(a).includes(workflow));
    assert.equal(tag(a, "temporalRunID"), tag(workflow, "temporalRunID"));
  }
  // A target already present is intentionally probed using the old identity.
  // Keep that genuine conflict span in the scoped trace; verify all other errors.
  const conflicts = retained.filter(hasError);
  if (proof.phase === "before-create") {
    assert.equal(conflicts.length, 0);
    // Reuse the full normal lifecycle oracle for source-absent recovery.
    inspectLifecycle(
      projection,
      { ...expected, missingSourceGeneration: 1 },
      secrets,
    );
  } else {
    for (const s of conflicts) {
      assert.equal(service(s), "runtime-controller");
      assert.equal(s.operationName, "runtime.platform.inspect");
      assert.equal(tag(s, "antnest.agent.id"), expected.agentId);
      assert.equal(tag(s, "antnest.runtime.generation"), 1);
      assert.equal(tag(s, "antnest.error.code"), "platform_operation_failed");
      const causes = (s.logs ?? [])
        .flatMap((e) => e.fields ?? [])
        .filter((f) => f.key === "antnest.error.causes");
      assert.equal(causes.length, 1);
      assert.deepEqual(JSON.parse(causes[0].value), [
        "*errors.errorString: runtime identity conflict",
      ]);
      assert(tree.chain(s).includes(server));
    }
    assert.equal(conflicts.length, 1);
    const rpc = (scope, owner, method, route, status = 200) => {
      const s = one(
        retained.filter(
          (s) =>
            tree.chain(s).includes(scope) &&
            service(s) === owner &&
            tag(s, "span.kind") === "server" &&
            tag(s, "http.request.method") === method &&
            tag(s, "http.route") === route &&
            tag(s, "http.response.status_code") === status,
        ),
        route,
      );
      assertRPCParent(
        tree,
        s,
        owner === "admin-console"
          ? "edge-gateway"
          : owner === "agent-controller"
            ? "admin-console"
            : "agent-controller",
      );
      return s;
    };
    const root = one(
      retained.filter((s) => !tree.parent(s)),
      "Gateway root",
    );
    assert.equal(service(root), "edge-gateway");
    assert.equal(tag(root, "http.response.status_code"), 202);
    rpc(
      root,
      "admin-console",
      "POST",
      "/api/admin/agents/{agent_id}/rebuild",
      202,
    );
    const admission = rpc(
      root,
      "agent-controller",
      "POST",
      "/internal/agents/{agent_id}/rebuild",
      202,
    );
    assert.equal(tag(admission, "antnest.agent.id"), expected.agentId);
    assert(tree.chain(workflow).includes(admission));
    for (const phase of ["admit_lifecycle", ...lifecyclePlans.rebuild]) {
      const name = phase === "admit_lifecycle" ? phase : `lifecycle.${phase}`;
      const activity = one(
        retained.filter((s) => s.operationName === `RunActivity:${name}`),
        name,
      );
      assert(tree.chain(activity).includes(workflow));
      assert(!hasError(activity));
      assert.equal(
        tag(activity, "temporalRunID"),
        tag(workflow, "temporalRunID"),
      );
      const tx = retained.filter(
        (s) =>
          tree.chain(s).includes(activity) &&
          service(s) === "agent-controller" &&
          s.operationName === "postgresql transaction" &&
          tag(s, "antnest.transaction.outcome") === "committed",
      );
      assert(
        tx.some((t) =>
          retained.some(
            (s) =>
              tree.chain(s).includes(t) &&
              service(s) === "agent-controller" &&
              tag(s, "db.system.name") === "postgresql" &&
              ["UPDATE", "INSERT"].includes(tag(s, "db.operation.name")),
          ),
        ),
        `${phase}: committed driver write missing`,
      );
      const dependencies =
        {
          drain: [
            [
              "agent-acp-service",
              "POST",
              "/rpc/agent-acp/apply-execution-snapshot",
            ],
            ["agent-acp-service", "POST", "/rpc/agent-acp/settle-agent"],
          ],
          network_fence: [
            [
              "antnest-runtime-egress",
              "GET",
              "/internal/agent-networks/{agent_id}",
            ],
            [
              "antnest-runtime-egress",
              "PUT",
              "/internal/agent-network-attachments/{agent_id}",
            ],
          ],
          runtime_update: [
            [
              "runtime-controller",
              "POST",
              "/internal/runtimes/{agent_id}/update",
            ],
          ],
          network_ensure: [
            [
              "antnest-runtime-egress",
              "PUT",
              "/internal/agent-network-attachments/{agent_id}",
            ],
          ],
        }[phase] ?? [];
      for (const dependency of dependencies) rpc(activity, ...dependency);
    }
    assert(
      !retained.some(
        (s) =>
          tree.chain(s).includes(server) &&
          tag(s, "peer.service") === "docker" &&
          ["POST", "DELETE"].includes(tag(s, "http.request.method")),
      ),
      "recovery repeated Docker mutation",
    );
  }
  return {
    kind: expected.kind,
    trace_id: trace.traceID,
    request_id: expected.requestId,
    agent_id: expected.agentId,
    topology_scope: "completed_recovery",
    spans: trace.spans.length,
    recovery_spans: retained.length,
    attempts: attempts.length,
    strict_trace: "failed",
    crash_diagnostics: {
      excluded_span_ids: excluded.map((s) => s.spanID),
      missing_parents: missing,
      error_spans: trace.spans.filter(hasError).map((s) => s.spanID),
      warnings:
        (trace.warnings ?? []).length +
        trace.spans.reduce((n, s) => n + (s.warnings?.length ?? 0), 0),
    },
  };
}
