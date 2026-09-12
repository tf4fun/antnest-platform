import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { traceTree, tag } from "./trace-tree.mjs";

export const lifecyclePlans = {
  create: ["network_ensure", "runtime_initialize", "publish"],
  rebuild: [
    "drain",
    "network_fence",
    "runtime_update",
    "network_ensure",
    "publish",
  ],
  disable: ["drain", "network_fence", "runtime_disable", "publish"],
  enable: ["network_ensure", "runtime_enable", "network_restore", "publish"],
  delete: [
    "drain",
    "network_fence",
    "runtime_delete",
    "network_release",
    "publish",
  ],
};

function phaseRPC(kind, name) {
  const phase = name.replace("lifecycle.", "");
  if (phase.startsWith("runtime_"))
    return [
      "runtime-controller",
      "POST",
      `/internal/runtimes/{agent_id}/${phase.slice(8)}`,
    ];
  if (
    name === "admit_agent" ||
    (kind === "enable" && name === "admit_lifecycle")
  )
    return [
      "identity-service",
      "POST",
      "/rpc/identity/resolve-owner-authorization",
    ];
  const route = {
    network_fence: ["GET", "/internal/agent-networks/{agent_id}"],
    network_ensure: [
      "PUT",
      kind === "rebuild"
        ? "/internal/agent-network-attachments/{agent_id}"
        : "/internal/agent-networks/{agent_id}",
    ],
    network_restore: ["PUT", "/internal/agent-network-attachments/{agent_id}"],
    network_release: ["POST", "/internal/agent-networks/{agent_id}/release"],
    ...(kind === "create"
      ? { publish: ["PUT", "/internal/agent-network-attachments/{agent_id}"] }
      : {}),
  }[phase];
  return route ? ["antnest-runtime-egress", ...route] : undefined;
}

function phaseDependencies(kind, name, failed) {
  const primary = phaseRPC(kind, name);
  const dependencies = primary ? [primary] : [];
  const phase = name.replace("lifecycle.", "");
  if (phase === "network_fence")
    dependencies.push([
      "antnest-runtime-egress",
      "PUT",
      "/internal/agent-network-attachments/{agent_id}",
    ]);
  if (phase === "network_release")
    dependencies.unshift([
      "antnest-runtime-egress",
      "GET",
      "/internal/agent-networks/{agent_id}",
    ]);
  if (
    !failed &&
    ["runtime_initialize", "runtime_update", "runtime_enable"].includes(phase)
  )
    dependencies.push(["antnest-runtime", "GET", "/status"]);
  return dependencies;
}

function assertRPCParent(tree, server, caller) {
  assert.equal(
    tag(server, "span.kind"),
    "server",
    "RPC boundary must be SERVER",
  );
  const client = tree.parent(server);
  assert(
    client && tag(client, "span.kind") === "client",
    "RPC SERVER needs a direct CLIENT parent",
  );
  assert.equal(
    tree.service(client),
    caller,
    "RPC CLIENT belongs to the wrong service",
  );
  assert.equal(
    tag(client, "http.request.method"),
    tag(server, "http.request.method"),
    "RPC methods disagree",
  );
}

function response(span, direction = "response") {
  const event = span?.logs?.find((entry) =>
    entry.fields?.some(
      (field) =>
        field.key === "event" && field.value === `antnest.${direction}`,
    ),
  );
  const json = event?.fields?.find(
    (field) => field.key === "antnest.payload.json",
  )?.value;
  return json ? JSON.parse(json) : undefined;
}

function rpcMatches(tree, span, [service, method, route]) {
  return (
    tree.service(span) === service &&
    tag(span, "span.kind") === "server" &&
    tag(span, "http.request.method") === method &&
    tag(span, "http.route") === route
  );
}

function successful(span) {
  return (
    Number(tag(span, "http.response.status_code")) === 200 &&
    tag(span, "error") !== true
  );
}

function absenceResponse(span, agentID, resource, code) {
  return (
    agentID &&
    Number(tag(span, "http.response.status_code")) === 404 &&
    response(span)?.code === code &&
    response(span, "request")?.path ===
      `/internal/${resource}/${encodeURIComponent(agentID)}`
  );
}

function settledNetwork(tree, descendants, kind, name, agentID) {
  const phase = name.replace("lifecycle.", "");
  if (!["network_fence", "network_release"].includes(phase)) return undefined;
  return descendants.find((span) => {
    if (
      !rpcMatches(tree, span, [
        "antnest-runtime-egress",
        "GET",
        "/internal/agent-networks/{agent_id}",
      ])
    )
      return false;
    if (
      kind === "delete" &&
      absenceResponse(
        span,
        agentID,
        "agent-networks",
        "agent_network_not_found",
      )
    )
      return true;
    const body = response(span);
    const states =
      phase === "network_release"
        ? ["quarantined"]
        : kind === "delete"
          ? ["active", "quarantined"]
          : ["active"];
    return (
      successful(span) &&
      body?.agent_id === agentID &&
      body?.attachment_state === "closed" &&
      states.includes(body?.state)
    );
  });
}

function assertRuntimeFailure(tree, descendants, agentID, requestID) {
  const childID =
    "acr_" +
    createHash("sha256")
      .update(`${requestID}\0runtime_initialize`)
      .digest("hex")
      .slice(0, 32);
  const commands = descendants.filter((span) =>
    rpcMatches(tree, span, [
      "runtime-controller",
      "POST",
      "/internal/runtimes/{agent_id}/initialize",
    ]),
  );
  const failedResult = (span) =>
    successful(span) &&
    response(span)?.agent_id === agentID &&
    response(span)?.request_id === childID &&
    response(span)?.kind === "initialize_runtime" &&
    response(span)?.state === "failed" &&
    response(span)?.error_code;
  const rejected = commands.find(
    (span) =>
      Number(tag(span, "http.response.status_code")) >= 400 &&
      tag(tree.parent(span), "antnest.operation.request_id") === childID,
  );
  const journal = descendants.find(
    (span) =>
      rpcMatches(tree, span, [
        "runtime-controller",
        "GET",
        "/internal/runtime-operations/{request_id}",
      ]) &&
      failedResult(span) &&
      response(span, "request")?.path ===
        `/internal/runtime-operations/${childID}` &&
      rejected &&
      span.startTime >= rejected.startTime + rejected.duration,
  );
  assert(
    rejected && journal,
    "Runtime failure requires a rejected command and authoritative failed journal",
  );
  assertRPCParent(tree, rejected, "agent-controller");
  assertRPCParent(tree, journal, "agent-controller");
}

function runtimeAbsent(tree, descendants, agentID) {
  const proof = descendants.find((span) => {
    if (
      !rpcMatches(tree, span, [
        "runtime-controller",
        "GET",
        "/internal/runtimes/{agent_id}",
      ])
    )
      return false;
    if (absenceResponse(span, agentID, "runtimes", "runtime_not_found"))
      return true;
    const body = response(span);
    return (
      successful(span) &&
      body?.agent_id === agentID &&
      body?.lifecycle_state === "deleted" &&
      body?.health === "absent"
    );
  });
  if (proof) assertRPCParent(tree, proof, "agent-controller");
  return Boolean(proof);
}

function hasProjection(tree, descendants) {
  const transactions = descendants.filter(
    (span) =>
      tree.service(span) === "agent-controller" &&
      span.operationName === "postgresql transaction" &&
      tag(span, "error") !== true,
  );
  return transactions.some((transaction) => {
    const queries = descendants.filter(
      (span) =>
        tree.parent(span) === transaction &&
        tree.service(span) === "agent-controller" &&
        tag(span, "error") !== true,
    );
    return (
      queries.some((span) => span.operationName === "COMMIT") &&
      queries.some(
        (span) =>
          ["INSERT", "UPDATE", "DELETE"].includes(span.operationName) &&
          tag(span, "db.query.text"),
      )
    );
  });
}

function assertReadOnly(tree, descendants, name) {
  assert(
    descendants.some(
      (span) =>
        tree.service(span) === "agent-controller" &&
        span.operationName === "SELECT" &&
        tag(span, "db.query.text") &&
        tag(span, "error") !== true,
    ),
    `${name} has no successful authoritative read`,
  );
  assert(
    !descendants.some(
      (span) =>
        ["INSERT", "UPDATE", "DELETE"].includes(span.operationName) ||
        (["client", "server"].includes(tag(span, "span.kind")) &&
          ["POST", "PUT", "PATCH", "DELETE"].includes(
            tag(span, "http.request.method"),
          )),
    ),
    `${name} repeats side effects`,
  );
}

export function inspectWorkflow(
  trace,
  requestID,
  {
    kind = "create",
    outcome = "completed",
    agentID,
    allowRetries = false,
  } = {},
) {
  assert(lifecyclePlans[kind], "unsupported lifecycle");
  assert(
    ["completed", "runtime_start_failed"].includes(outcome),
    "unsupported lifecycle outcome",
  );
  const failed = outcome === "runtime_start_failed";
  if (failed) assert.equal(kind, "create");
  const tree = traceTree(trace);
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "workflow must have one business root");
  const [root] = roots;
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server", "Gateway root must be SERVER");
  assert.equal(tag(root, "http.request.method"), "POST");
  assert.equal(tag(root, "http.response.status_code"), 202);
  const route =
    kind === "create"
      ? "/internal/agents"
      : `/internal/agents/{agent_id}/${kind}`;
  const admissions = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-controller" &&
      tag(span, "http.route") === route,
  );
  assert.equal(admissions.length, 1, "one Controller admission is required");
  assert.equal(tag(admissions[0], "http.response.status_code"), 202);
  agentID ??= tag(admissions[0], "antnest.agent.id");
  assertRPCParent(tree, admissions[0], "admin-console");
  const consoleServer = tree
    .chain(admissions[0])
    .find(
      (span) =>
        tree.service(span) === "admin-console" &&
        tag(span, "span.kind") === "server",
    );
  assert(consoleServer, "Console SERVER missing");
  assertRPCParent(tree, consoleServer, "edge-gateway");
  if (agentID) assert.equal(tag(admissions[0], "antnest.agent.id"), agentID);
  const workflows = trace.spans.filter(
    (span) =>
      span.operationName ===
        (kind === "create"
          ? "RunWorkflow:CreateAgentWorkflow"
          : "RunWorkflow:LifecycleWorkflow") &&
      tag(span, "temporalWorkflowID") === `agent-${kind}/${requestID}`,
  );
  assert(workflows.length, "official SDK workflow span missing");
  for (const workflow of workflows) {
    assert(
      tree.chain(workflow).includes(root),
      "workflow detached from Gateway",
    );
    assert(
      tree.chain(workflow).includes(admissions[0]),
      "workflow detached from admission",
    );
    assert(
      tree
        .chain(workflow)
        .some((span) => tree.service(span) === "admin-console"),
      "Console forwarding missing from workflow ancestry",
    );
  }
  assert.equal(
    workflows.some((span) => tag(span, "error") === true),
    failed,
    "workflow outcome mismatch",
  );
  assert(
    !trace.spans.some(
      (span) => span.operationName === "recover Agent lifecycle operation",
    ),
    "legacy executor is still involved",
  );
  const stageName = (phase) =>
    kind === "create" ? phase : `lifecycle.${phase}`;
  const stages = failed
    ? lifecyclePlans.create.slice(0, 2)
    : lifecyclePlans[kind];
  if (failed)
    assert(
      !trace.spans.some((span) => span.operationName === "RunActivity:publish"),
      "failed creation published",
    );
  const phases = [
    kind === "create" ? "admit_agent" : "admit_lifecycle",
    ...stages.map(stageName),
  ];
  let runtimeAbsenceProven = false;
  const activities = phases.map((name) => {
    const matches = trace.spans.filter(
      (span) => span.operationName === `RunActivity:${name}`,
    );
    if (!allowRetries)
      assert.equal(matches.length, 1, `happy path must execute ${name} once`);
    else assert(matches.length, `${name} missing`);
    const succeeded = matches.filter((span) => tag(span, "error") !== true);
    assert(succeeded.length >= 1, `${name} must complete`);
    if (!allowRetries)
      assert.equal(succeeded.length, 1, `${name} must complete once`);
    if (matches.length > 1) {
      for (const key of [
        "temporalWorkflowID",
        "temporalRunID",
        "temporalActivityID",
      ]) {
        assert(tag(matches[0], key), `${name} retry identity missing`);
        assert(
          matches.every((span) => tag(span, key) === tag(matches[0], key)),
          `${name} retry identity mismatch`,
        );
      }
    }
    const [activity] = succeeded.sort((a, b) => a.startTime - b.startTime);
    for (const attempt of matches)
      assert(
        tree.chain(attempt).some((span) => workflows.includes(span)),
        `${name} detached`,
      );
    const children = (attempt) =>
      trace.spans.filter((span) => tree.chain(span).includes(attempt));
    // Cross-attempt evidence is valid only after a business commit, followed by read-only replay.
    const committingAttempt = matches
      .filter((attempt) => hasProjection(tree, children(attempt)))
      .sort((a, b) => a.startTime - b.startTime)
      .at(-1);
    const evidenceAttempt = committingAttempt ?? activity;
    const descendants = children(evidenceAttempt);
    for (const replay of succeeded.filter(
      (attempt) => attempt !== evidenceAttempt,
    )) {
      assert(
        replay.startTime >=
          evidenceAttempt.startTime + evidenceAttempt.duration,
        `${name} replay precedes committed evidence`,
      );
      assertReadOnly(tree, children(replay), name);
    }
    const absentDelete =
      kind === "delete" &&
      name === "lifecycle.runtime_delete" &&
      runtimeAbsenceProven;
    if (absentDelete) {
      assertReadOnly(tree, descendants, name);
    } else
      assert(
        hasProjection(tree, descendants),
        `${name} has no committed Controller business projection`,
      );
    const settled = settledNetwork(tree, descendants, kind, name, agentID);
    if (settled) assertRPCParent(tree, settled, "agent-controller");
    const failureStage = failed && name === "runtime_initialize";
    if (failureStage)
      assertRuntimeFailure(tree, descendants, agentID, requestID);
    const dependencies =
      settled || absentDelete || failureStage
        ? []
        : phaseDependencies(kind, name, failed);
    let previous;
    for (const dependency of dependencies) {
      const rpc = descendants
        .filter(
          (span) => rpcMatches(tree, span, dependency) && successful(span),
        )
        .sort((left, right) => left.startTime - right.startTime)
        .find((span) => !previous || span.startTime >= previous.startTime);
      assert(rpc, `${name} missing successful RPC ${dependency.join(" ")}`);
      assertRPCParent(
        tree,
        rpc,
        dependency[0] === "antnest-runtime"
          ? "runtime-controller"
          : "agent-controller",
      );
      if (dependency[0] === "antnest-runtime")
        assert(
          tree.chain(rpc).includes(previous),
          "Runtime status is not verified by the Runtime operation",
        );
      previous = rpc;
    }
    runtimeAbsenceProven ||= runtimeAbsent(tree, descendants, agentID);
    return {
      name,
      span_id: activity.spanID,
      attempts: matches.length,
      start: activity.startTime,
      end: Math.max(...matches.map((span) => span.startTime + span.duration)),
      services: [...new Set(descendants.map(tree.service))].sort(),
    };
  });
  for (let index = 1; index < activities.length; index++)
    assert(
      activities[index].start >= activities[index - 1].end,
      "resource activities must execute in order",
    );
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    root: root.operationName,
    activities,
    missing_parents: 0,
    warnings: 0,
  };
}
