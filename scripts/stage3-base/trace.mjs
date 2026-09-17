import assert from "node:assert/strict";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import {
  lifecyclePlans,
  assertRPCParent,
} from "../observability/lifecycle-workflow.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { timingEvidence, hasError } from "../acp-plan/requests.mjs";
import { runtimeCommandId } from "./contracts.mjs";

export function inspectLifecycle(trace, expected, secrets = []) {
  const { kind, requestId, agentId } = expected;
  const settlementOutcome = expected.settlementOutcome ?? "settled";
  assert(
    settlementOutcome === "settled" ||
      (kind === "rebuild" && settlementOutcome === "runtime_barrier_required"),
    "invalid expected settlement outcome",
  );
  assert(lifecyclePlans[kind] && requestId && agentId);
  assert.equal(trace.traceID, expected.traceID);
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const errors = trace.spans.filter(hasError);
  for (const error of errors) assertDockerProbe(trace, tree, error, expected);
  const absence = trace.spans.filter(
    (s) =>
      !hasError(s) &&
      tree.service(s) === "runtime-controller" &&
      tag(s, "peer.service") === "docker" &&
      tag(s, "http.response.status_code") === 404,
  );
  for (const probe of absence) assertDockerProbe(trace, tree, probe, expected);
  assert(
    !trace.spans.some((s) =>
      /^(agent\.run|model\.|mcp\.)/.test(s.operationName),
    ),
    "lifecycle executed a Run",
  );
  const one = (items, label) => {
    assert.equal(items.length, 1, `missing or duplicate ${label}`);
    return items[0];
  };
  const root = one(
    trace.spans.filter((s) => !tree.parent(s)),
    "Gateway root",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), "/api/admin/{path...}");
  assert.equal(tag(root, "http.request.method"), "POST");
  assert.equal(tag(root, "http.response.status_code"), 202);
  const route =
    kind === "create"
      ? "/internal/agents"
      : `/internal/agents/{agent_id}/${kind}`;
  const rpc = (scope, service, method, route, status = 200) =>
    one(
      trace.spans.filter(
        (s) =>
          tree.chain(s).includes(scope) &&
          tree.service(s) === service &&
          tag(s, "span.kind") === "server" &&
          tag(s, "http.request.method") === method &&
          tag(s, "http.route") === route &&
          tag(s, "http.response.status_code") === status,
      ),
      `${service} ${route}`,
    );
  const admitted = rpc(root, "agent-controller", "POST", route, 202);
  assert.equal(tag(admitted, "antnest.agent.id"), agentId);
  assertRPCParent(tree, admitted, "admin-console");
  const consoleServer = one(
    tree
      .chain(admitted)
      .filter(
        (s) =>
          tree.service(s) === "admin-console" &&
          tag(s, "span.kind") === "server",
      ),
    "Console SERVER",
  );
  assert.equal(
    tag(consoleServer, "http.route"),
    route.replace("/internal", "/api/admin"),
  );
  assertRPCParent(tree, consoleServer, "edge-gateway");
  const workflow = one(
    trace.spans.filter(
      (s) =>
        s.operationName ===
          (kind === "create"
            ? "RunWorkflow:CreateAgentWorkflow"
            : "RunWorkflow:LifecycleWorkflow") &&
        tag(s, "temporalWorkflowID") === `agent-${kind}/${requestId}`,
    ),
    "Temporal workflow",
  );
  assert(
    tree.chain(workflow).includes(admitted),
    "workflow detached from admission",
  );
  const phases = [
    kind === "create" ? "admit_agent" : "admit_lifecycle",
    ...lifecyclePlans[kind],
  ];
  let previous,
    settlement = false;
  const activities = phases.map((phase) => {
    const name =
      phase.startsWith("admit_") || kind === "create"
        ? phase
        : `lifecycle.${phase}`;
    const activity = one(
      trace.spans.filter((s) => s.operationName === `RunActivity:${name}`),
      name,
    );
    assert(tree.chain(activity).includes(workflow), "activity detached");
    assert.equal(
      tag(activity, "temporalWorkflowID"),
      `agent-${kind}/${requestId}`,
    );
    if (previous)
      assert(
        activity.startTime >= previous.startTime + previous.duration,
        "lifecycle phases overlap or are out of order",
      );
    previous = activity;
    const transactions = trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-controller" &&
        tree.chain(s).includes(activity) &&
        s.operationName === "postgresql transaction" &&
        tag(s, "db.system.name") === "postgresql" &&
        tag(s, "antnest.transaction.outcome") === "committed",
    );
    assert(
      transactions.some((tx) =>
        trace.spans.some(
          (s) =>
            tree.chain(s).includes(tx) &&
            tree.service(s) === "agent-controller" &&
            tag(s, "span.kind") === "client" &&
            tag(s, "db.system.name") === "postgresql" &&
            ["UPDATE", "INSERT"].includes(tag(s, "db.operation.name")) &&
            /\b(?:UPDATE|INSERT)\b/i.test(tag(s, "db.query.text") ?? ""),
        ),
      ),
      `${name}: missing committed driver write`,
    );
    const dependencies = [];
    if (phase.startsWith("runtime_"))
      dependencies.push([
        "runtime-controller",
        "POST",
        `/internal/runtimes/{agent_id}/${phase.slice(8)}`,
      ]);
    if (
      phase === "admit_agent" ||
      (phase === "admit_lifecycle" && kind === "enable")
    )
      dependencies.push([
        "identity-service",
        "POST",
        "/rpc/identity/resolve-owner-authorization",
      ]);
    const network =
      {
        network_ensure: [
          [
            "PUT",
            kind === "rebuild"
              ? "/internal/agent-network-attachments/{agent_id}"
              : "/internal/agent-networks/{agent_id}",
          ],
        ],
        network_fence: [
          ["GET", "/internal/agent-networks/{agent_id}"],
          ["PUT", "/internal/agent-network-attachments/{agent_id}"],
        ],
        network_restore: [
          ["PUT", "/internal/agent-network-attachments/{agent_id}"],
        ],
        network_release: [
          ["GET", "/internal/agent-networks/{agent_id}"],
          ["POST", "/internal/agent-networks/{agent_id}/release"],
        ],
        ...(kind === "create"
          ? {
              publish: [
                ["PUT", "/internal/agent-network-attachments/{agent_id}"],
              ],
            }
          : {}),
      }[phase] ?? [];
    dependencies.push(
      ...network.map((item) => ["antnest-runtime-egress", ...item]),
    );
    let preceding;
    for (const dependency of dependencies) {
      const server = rpc(activity, ...dependency);
      assertRPCParent(tree, server, "agent-controller");
      if (preceding)
        assert(
          server.startTime >= preceding.startTime + preceding.duration,
          "network commands out of order",
        );
      preceding = server;
      if (phase.startsWith("runtime_")) {
        const command = tree
          .chain(server)
          .find((s) => tag(s, "antnest.operation.request_id"));
        assert.equal(
          tag(command, "antnest.operation.request_id"),
          runtimeCommandId(requestId, phase),
        );
        assert.equal(tag(command, "antnest.agent.id"), agentId);
      }
    }
    if (phase === "drain") {
      const applied = rpc(
        activity,
        "agent-acp-service",
        "POST",
        "/rpc/agent-acp/apply-execution-snapshot",
      );
      const settled = rpc(
        activity,
        "agent-acp-service",
        "POST",
        "/rpc/agent-acp/settle-agent",
      );
      assertRPCParent(tree, applied, "agent-controller");
      assertRPCParent(tree, settled, "agent-controller");
      const publication = tree
        .chain(applied)
        .find(
          (s) =>
            tree.service(s) === "agent-controller" &&
            tag(s, "span.kind") === "client" &&
            tag(s, "antnest.configuration.applied_revision") !== undefined,
        );
      const confirmation = tree
        .chain(settled)
        .find(
          (s) =>
            tree.service(s) === "agent-controller" &&
            tag(s, "span.kind") === "client" &&
            tag(s, "antnest.settlement.outcome") !== undefined,
        );
      for (const key of [
        "antnest.operation.id",
        "antnest.agent.id",
        "antnest.configuration.revision",
        "antnest.settlement.outcome",
      ])
        assert.equal(
          tag(settled, key),
          tag(confirmation, key),
          "settlement request/acknowledgement mismatch",
        );
      assert.equal(
        tag(confirmation, "antnest.settlement.outcome"),
        settlementOutcome,
      );
      assert.equal(tag(confirmation, "antnest.operation.id"), requestId);
      assert.equal(tag(confirmation, "antnest.agent.id"), agentId);
      const revision = tag(
        publication,
        "antnest.configuration.applied_revision",
      );
      assert(Number.isSafeInteger(revision) && revision > 0);
      assert.equal(
        tag(confirmation, "antnest.configuration.revision"),
        revision,
      );
      assert(
        tag(confirmation, "antnest.configuration.applied_revision") >= revision,
      );
      assert(
        settled.startTime >= applied.startTime + applied.duration,
        "settlement preceded publication",
      );
      settlement = true;
    }
    return { phase, span_id: activity.spanID, committed: true };
  });
  const timing = timingEvidence(trace, tree, admitted, tree.parent(admitted));
  return {
    kind,
    trace_id: trace.traceID,
    request_id: requestId,
    agent_id: agentId,
    spans: trace.spans.length,
    activities,
    settlement,
    ...timing,
    platform_probe_errors: errors.length,
    platform_absence_probes: absence.length,
    strict_trace: errors.length ? "failed" : timing.strict_trace,
    timing: {
      controller_start_minus_console_us:
        admitted.startTime - tree.parent(admitted).startTime,
    },
  };
}

export function assertDockerProbe(trace, tree, error, expected) {
  // Historical ERROR probes remain strict failures; current absence still needs allocation proof.
  assert.equal(
    tree.service(error),
    "runtime-controller",
    "unexpected lifecycle error",
  );
  assert.equal(error.operationName, "HTTP GET docker");
  assert.equal(tag(error, "span.kind"), "client");
  assert.equal(tag(error, "peer.service"), "docker");
  assert.equal(tag(error, "http.request.method"), "GET");
  assert.equal(tag(error, "http.response.status_code"), 404);
  if (hasError(error)) {
    assert.equal(tag(error, "antnest.error.code"), "404");
    assert.equal(tag(error, "error.type"), "protocol_error");
  } else {
    assert.equal(tag(error, "antnest.outcome"), "absent");
    assert.equal(tag(error, "antnest.error.code"), undefined);
    assert.equal(tag(error, "error.type"), undefined);
    assert([undefined, "UNSET"].includes(tag(error, "otel.status_code")));
    assert(
      !(error.logs ?? []).some((log) =>
        log.fields?.some(
          (f) => f.key === "event" && f.value === "antnest.error",
        ),
      ),
    );
  }
  const platform = tree.parent(error);
  assert.equal(tree.service(platform), "runtime-controller");
  assert.equal(tag(platform, "antnest.agent.id"), expected.agentId);
  assert.equal(tag(platform, "antnest.outcome"), "completed");
  assert.equal(tag(platform, "antnest.platform"), "docker");
  const storage = platform.operationName === "runtime.platform.ensure_storage";
  assert(
    storage
      ? expected.kind === "create"
      : ["create", "enable", "rebuild"].includes(expected.kind) &&
          platform.operationName === "runtime.platform.create",
  );
  const phase = {
    create: "runtime_initialize",
    enable: "runtime_enable",
    rebuild: "runtime_update",
  }[expected.kind];
  const command = tree
    .chain(platform)
    .find((s) => tag(s, "antnest.operation.request_id"));
  assert.equal(
    tag(command, "antnest.operation.request_id"),
    runtimeCommandId(expected.requestId, phase),
  );
  const following = trace.spans.filter(
    (s) =>
      tree.parent(s) === platform &&
      s.startTime >= error.startTime + error.duration &&
      tree.service(s) === "runtime-controller" &&
      tag(s, "peer.service") === "docker" &&
      !hasError(s),
  );
  const allocated = following.find(
    (s) =>
      tag(s, "http.request.method") === "POST" &&
      tag(s, "http.response.status_code") === 201,
  );
  assert(allocated, "absence probe has no successful allocation");
  assert(
    following.some(
      (s) =>
        s.startTime >= allocated.startTime + allocated.duration &&
        tag(s, "http.request.method") === (storage ? "GET" : "POST") &&
        tag(s, "http.response.status_code") === (storage ? 200 : 204),
    ),
    "allocation has no successful verification/start",
  );
}
