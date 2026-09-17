import assert from "node:assert/strict";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import { assertDockerProbe } from "../stage3-base/trace.mjs";

export function inspectRpcTrace(trace, records, lifecycle, secrets = []) {
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const one = (rows, name) => {
    assert.equal(rows.length, 1, `missing or duplicate ${name}`);
    return rows[0];
  };
  assert(records.length > 0);
  const dropped = [],
    servers = [];
  const publicationAttempts = [];
  let acknowledgementWrites = 0;
  const driver = (scope, service, pattern) =>
    trace.spans.filter(
      (s) =>
        tree.chain(s).includes(scope) &&
        tree.service(s) === service &&
        tag(s, "span.kind") === "client" &&
        tag(s, "db.system.name") === "postgresql" &&
        pattern.test((tag(s, "db.query.text") ?? "").replace(/\s+/g, " ")),
    );
  for (const r of records) {
    const [, id, spanId] = r.traceparent.split("-");
    assert.equal(trace.traceID, id);
    const client = tree.spans.get(spanId);
    assert.equal(tree.service(client), "agent-controller");
    assert.equal(tag(client, "span.kind"), "client");
    assert.equal(client.operationName, "HTTP POST agent-acp-service");
    assert.equal(tag(client, "rpc.method"), r.method.replaceAll("-", "_"));
    assert.equal(tag(client, "antnest.organization.id"), r.organization_id);
    assert.equal(
      tag(client, "antnest.configuration.revision"),
      r.revision ?? r.minimum_revision,
    );
    const server = one(
      trace.spans.filter(
        (s) =>
          tree.parent(s) === client &&
          tree.service(s) === "agent-acp-service" &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.route") === `/rpc/agent-acp/${r.method}`,
      ),
      "applied RPC SERVER",
    );
    assert.equal(tag(server, "http.response.status_code"), 200);
    assert(!hasError(server));
    assert.equal(
      tag(server, "antnest.configuration.revision"),
      r.applied_revision,
    );
    servers.push(server);
    if (r.delivery === "dropped") {
      assert(hasError(client), "injected loss disappeared");
      assert.equal(
        tag(client, "antnest.configuration.applied_revision"),
        undefined,
        "lost response falsely acknowledged",
      );
      dropped.push(client);
    } else {
      assert.equal(r.delivery, "delivered");
      assert(!hasError(client));
      assert.equal(
        tag(client, "antnest.configuration.applied_revision"),
        r.applied_revision,
      );
    }
    if (r.method === "apply-execution-snapshot") {
      const attempt = tree.parent(client);
      assert.equal(tree.service(attempt), "agent-controller");
      assert.equal(
        attempt.operationName,
        "agent_controller.execution_publication",
      );
      assert.equal(tag(attempt, "span.kind"), "internal");
      assert.equal(tag(attempt, "antnest.organization.id"), r.organization_id);
      assert(
        !publicationAttempts.includes(attempt),
        "one attempt counted for two HTTP calls",
      );
      publicationAttempts.push(attempt);
      assert.equal(
        driver(
          attempt,
          "agent-controller",
          /SELECT revision FROM agent_controller.execution_configuration_sync\b/i,
        ).length,
        1,
        "missing current source driver read",
      );
      const acknowledgements = driver(
        attempt,
        "agent-controller",
        /UPDATE agent_controller.execution_configuration_sync\s+SET applied_revision=/i,
      );
      assert.equal(
        acknowledgements.length,
        r.delivery === "delivered" ? 1 : 0,
        "missing or premature acknowledgement SQL",
      );
      assert(
        acknowledgements.every((s) => tree.parent(s) === attempt),
        "acknowledgement not owned by the publication attempt",
      );
      acknowledgementWrites += acknowledgements.length;
      assert.equal(
        tag(attempt, "antnest.configuration.applied_revision"),
        r.delivery === "delivered" ? r.applied_revision : undefined,
      );
      assert.equal(Boolean(hasError(attempt)), r.delivery === "dropped");
      assert(
        driver(server, "agent-acp-service", /\bexecution_configurations\b/)
          .length > 0,
        "missing configuration driver read/write",
      );
      if (r.delivery === "dropped")
        assert(
          driver(
            server,
            "agent-acp-service",
            /^(?:INSERT INTO|UPDATE) execution_configurations\b/i,
          ).length > 0,
          "remote application not durably written",
        );
    } else {
      assert.equal(r.method, "settle-agent");
      for (const s of [client, server]) {
        assert.equal(tag(s, "antnest.operation.id"), r.operation_id);
        assert.equal(tag(s, "antnest.agent.id"), r.agent_id);
      }
      assert.equal(tag(server, "antnest.settlement.outcome"), "settled");
      if (r.delivery === "delivered")
        assert.equal(tag(client, "antnest.settlement.outcome"), "settled");
      assert(
        driver(server, "agent-acp-service", /FROM tool_attempts\b/i).length > 0,
        "settlement skipped durable Runtime protection",
      );
    }
  }
  for (const s of trace.spans)
    assert(
      !/^(agent\.run|model\.|mcp\.)/.test(s.operationName),
      "control RPC executed a Run",
    );
  let activities = [];
  if (lifecycle) {
    assert.equal(trace.traceID, lifecycle.traceID);
    const workflow = one(
      trace.spans.filter(
        (s) =>
          s.operationName === "RunWorkflow:LifecycleWorkflow" &&
          tag(s, "temporalWorkflowID") ===
            `agent-rebuild/${lifecycle.requestId}`,
      ),
      "Rebuild workflow",
    );
    assert(
      tree
        .chain(workflow)
        .some(
          (s) =>
            tree.service(s) === "edge-gateway" &&
            tag(s, "http.response.status_code") === 202,
        ),
      "workflow has no accepted Gateway request",
    );
    activities = trace.spans.filter(
      (s) =>
        s.operationName === "RunActivity:lifecycle.drain" &&
        tree.chain(s).includes(workflow),
    );
    assert.equal(
      activities.length,
      2,
      "expected one failed drain and one retry",
    );
    assert(
      dropped.every((c) => activities.some((a) => tree.chain(c).includes(a))),
    );
    for (const phase of [
      "network_fence",
      "runtime_update",
      "network_ensure",
      "publish",
    ]) {
      const activity = one(
        trace.spans.filter(
          (s) =>
            s.operationName === `RunActivity:lifecycle.${phase}` &&
            tree.chain(s).includes(workflow),
        ),
        phase,
      );
      assert(
        driver(activity, "agent-controller", /\b(?:UPDATE|INSERT)\b/i).length >
          0,
        `${phase} lacks durable advancement`,
      );
    }
  }
  let probes = 0,
    expectedErrors = 0;
  for (const error of trace.spans.filter(hasError)) {
    if (dropped.includes(error)) {
      assert.equal(tag(error, "antnest.error.stage"), "send");
      assert.equal(tag(error, "error.type"), "boundary_error");
      expectedErrors++;
      continue;
    }
    if (
      activities.includes(error) &&
      dropped.some((c) => tree.chain(c).includes(error))
    ) {
      expectedErrors++;
      continue;
    }
    if (
      publicationAttempts.includes(error) &&
      dropped.some((c) => tree.parent(c) === error)
    ) {
      assert.equal(tag(error, "error.type"), "execution_publication_failed");
      assert.equal(tag(error, "antnest.outcome"), "error");
      expectedErrors++;
      continue;
    }
    assert(lifecycle, "unrelated error in publication trace");
    assertDockerProbe(trace, tree, error, { kind: "rebuild", ...lifecycle });
    probes++;
  }
  const timing = timingEvidence(
    trace,
    tree,
    servers[0],
    tree.parent(servers[0]),
  );
  return {
    trace_id: trace.traceID,
    receipts: records.length,
    spans: trace.spans.length,
    expected_loss_errors: expectedErrors,
    platform_probe_errors: probes,
    drain_attempts: activities.length,
    publication_attempts: publicationAttempts.length,
    acknowledgement_writes: acknowledgementWrites,
    evidence_gaps: [],
    ...timing,
    strict_trace: probes ? "failed" : timing.strict_trace,
  };
}
export function inspectClosedPrompt(trace, expected, secrets = []) {
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  assert.equal(tag(request, "rpc.response.status_code"), -32020);
  assert.equal(tag(request, "antnest.outcome"), "rejected");
  for (const s of trace.spans) {
    assert(!/^(agent\.run|model\.|mcp\.)/.test(s.operationName));
    assert.notEqual(tree.service(s), "antnest-runtime");
    if (!hasError(s)) continue;
    assert.equal(tree.service(s), "agent-acp-service");
    assert(tree.chain(s).includes(request));
    assert.equal(tag(s, "antnest.outcome"), "rejected");
    assert.equal(
      tag(s, "antnest.error.code"),
      s === request ? "-32020" : "agent_unavailable",
    );
    if (s !== request) assert.equal(s.operationName, "acp.session.prompt");
  }
  return {
    trace_id: trace.traceID,
    label: expected.label,
    no_execution: true,
    ...timingEvidence(trace, tree, request, forwarded),
  };
}
