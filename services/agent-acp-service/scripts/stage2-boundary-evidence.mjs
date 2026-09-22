import assert from "node:assert/strict";
import { tag, traceTopology } from "../../../scripts/observability/trace-tree.mjs";

export function agentReferences(agent) {
  assert.equal(typeof agent.runtime?.runtime_revision, "string", "Agent Runtime revision missing");
  assert(agent.runtime.runtime_revision.length > 0);
  assert.equal(
    typeof agent.configuration?.template?.revision,
    "number",
    "Agent Template revision missing",
  );
  return { runtime: agent.runtime, template: agent.configuration.template };
}

export function assertNoCredentials(trace) {
  const encoded = JSON.stringify(trace);
  for (const marker of [
    "stage2-model-secret",
    "stage2-model-replacement",
    "stage2-admin-password",
    "stage2-owner-password",
  ])
    assert(!encoded.includes(marker), "synthetic credential leaked into trace");
}

export function inspectTemporalHistory(history, agentId) {
  assert(history.events?.length > 0, "Temporal history evidence is empty");
  const payloads = [];
  const visit = (value) => {
    if (value === null || typeof value !== "object") return;
    if (typeof value.metadata?.encoding === "string") {
      const encoding = Buffer.from(value.metadata.encoding, "base64").toString();
      assert(
        ["json/plain", "binary/plain", "binary/null"].includes(encoding),
        `uninspected Temporal payload encoding: ${encoding}`,
      );
      if (encoding !== "binary/null") {
        const decoded = Buffer.from(value.data ?? "", "base64").toString();
        payloads.push(encoding === "json/plain" ? JSON.parse(decoded) : decoded);
      }
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(history);
  assert(
    JSON.stringify(payloads).includes(agentId),
    "Temporal history must contain decoded business payloads",
  );
  assertNoCredentials(history);
  assertNoCredentials(payloads);
  return payloads.length;
}

export function inspectExecutionBoundary({ source, run }) {
  const tree = traceTopology(run);
  traceTopology(source);
  assertNoCredentials(run);
  assertNoCredentials(source);
  const roots = run.spans.filter((span) => span.operationName === "agent.run");
  assert.equal(roots.length, 1, "exactly one Run required");
  const [root] = roots;
  assert.equal(source.traceID, run.traceID, "execution must retain its submitting trace");
  assert(
    tag(root, "antnest.run.id") && tag(root, "antnest.session.id"),
    "Run and Session correlation required",
  );
  const prompt = tree
    .chain(root)
    .find(
      (span) =>
        tag(span, "rpc.method") === "session/prompt" && tree.service(span) === "agent-acp-service",
    );
  assert(
    prompt && tag(prompt, "antnest.session.id") === tag(root, "antnest.session.id"),
    "Run must descend from exact ACP prompt",
  );
  const withinRun = run.spans.filter((span) => tree.chain(span).includes(root));
  assert(
    withinRun.every(
      (span) => !["agent-controller", "identity-service"].includes(tree.service(span)),
    ),
    "execution must not depend on Controller or Identity",
  );
  assert(
    withinRun.some(
      (span) => span.operationName === "HTTP POST model" && tag(span, "span.kind") === "client",
    ),
    "model request missing",
  );
  const runtime = withinRun.filter(
    (span) => tree.service(span) === "antnest-runtime" && tag(span, "span.kind") === "server",
  );
  assert(runtime.length > 0, "Runtime request missing");
  assert(
    runtime.some((span) => tag(span, "rpc.method") === "tools/call"),
    "Runtime Tool call missing",
  );
  for (const span of runtime) {
    const parent = tree.parent(span);
    assert(
      parent &&
        tree.service(parent) === "agent-acp-service" &&
        tag(parent, "span.kind") === "client",
      "Runtime must receive a propagated ACP CLIENT span",
    );
  }
  assert(
    withinRun.some(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        tag(span, "db.system.name") === "postgresql" &&
        tag(span, "span.kind") === "client" &&
        ["INSERT", "UPDATE"].includes(tag(span, "db.operation.name")) &&
        span.operationName === tag(span, "db.operation.name") &&
        typeof tag(span, "db.query.text") === "string" &&
        tag(span, "db.query.text").length > 0,
    ),
    "ACP persistence missing",
  );
  return {
    trace_id: run.traceID,
    run_id: tag(root, "antnest.run.id"),
    session_id: tag(root, "antnest.session.id"),
    spans: run.spans.length,
    prompt_span_id: prompt.spanID,
  };
}

export function inspectLifecycleBoundary(trace, kind) {
  const tree = traceTopology(trace);
  assertNoCredentials(trace);
  const workflows = trace.spans.filter(
    (span) =>
      span.operationName ===
      (kind === "create" ? "RunWorkflow:CreateAgentWorkflow" : "RunWorkflow:LifecycleWorkflow"),
  );
  assert(workflows.length, "Temporal Workflow missing");
  for (const workflow of workflows)
    assert(
      tree
        .chain(workflow)
        .some(
          (span) =>
            tree.service(span) === "agent-controller" &&
            tag(span, "http.response.status_code") === 202,
        ),
      "Workflow detached from accepting request",
    );
  if (kind === "rebuild") {
    const settle = trace.spans.filter(
      (span) => tag(span, "http.route") === "/rpc/agent-acp/settle-agent",
    );
    assert(settle.length > 0, "Agent settlement RPC missing");
    for (const span of settle) assert.equal(tree.service(tree.parent(span)), "agent-controller");
  }
  assert(
    !trace.spans.some((span) => span.operationName === "recover Agent lifecycle operation"),
    "legacy worker span remains",
  );
  return { trace_id: trace.traceID, kind, spans: trace.spans.length };
}

export function inspectAuditBoundary(trace) {
  const tree = traceTopology(trace);
  assertNoCredentials(trace);
  const servers = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      ["list_execution_audits", "get_execution_audit", "list_execution_events"].includes(
        tag(span, "rpc.method"),
      ),
  );
  assert.equal(servers.length, 1, "exactly one ACP audit RPC required");
  let downstream = servers[0];
  for (const upstream of ["admin-console", "edge-gateway"]) {
    const client = tree.parent(downstream);
    assert.equal(tree.service(client), upstream, "audit RPC has wrong caller");
    assert.equal(tag(client, "span.kind"), "client");
    const server = tree.chain(client).find((span) => tag(span, "span.kind") === "server");
    assert.equal(tree.service(server), upstream, "audit caller has no owning HTTP request");
    downstream = server;
  }
  assert.equal(
    tree.parent(downstream),
    undefined,
    "Gateway must be the actual external entrypoint",
  );
  assert(
    trace.spans.every(
      (span) =>
        !["agent.run", "HTTP POST model"].includes(span.operationName) &&
        !["antnest-runtime", "agent-controller"].includes(tree.service(span)),
    ),
    "audit read invoked execution or Controller",
  );
  return {
    trace_id: trace.traceID,
    method: tag(servers[0], "rpc.method"),
    spans: trace.spans.length,
  };
}

export function inspectGatewayConnection({ connection, prompt }) {
  const tree = traceTopology(connection);
  assertNoCredentials(connection);
  const link = prompt.references?.find(
    (ref) => ref.refType === "FOLLOWS_FROM" && ref.traceID === connection.traceID,
  );
  assert(link, "ACP message has no connection link");
  const receivers = connection.spans.filter(
    (span) => tree.service(span) === "agent-acp-service" && tag(span, "span.kind") === "server",
  );
  assert.equal(receivers.length, 1, "one ACP connection receiver required");
  const receiver = receivers[0];
  assert.equal(tag(receiver, "span.kind"), "server");
  assert.equal(tag(receiver, "http.response.status_code"), 101);
  const client = tree.parent(receiver);
  assert.equal(tree.service(client), "edge-gateway");
  assert.equal(tag(client, "span.kind"), "client");
  const gateway = tree.chain(client).find((span) => tag(span, "span.kind") === "server");
  assert.equal(tree.service(gateway), "edge-gateway");
  assert.equal(tag(gateway, "http.response.status_code"), 101);
  assert(
    [receiver.spanID, gateway.spanID].includes(link.spanID),
    "message must link to a receiving connection span",
  );
  return { trace_id: connection.traceID, spans: connection.spans.length };
}
