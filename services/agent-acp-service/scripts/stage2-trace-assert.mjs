import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const forbiddenValues = [
  "stage2-model-secret",
  "Create the Stage 2 acceptance evidence file.",
  "stage2-runtime-tool-ok",
  "stage2-evidence.txt",
  "stage2-admin@example.com",
  "stage2-admin-password",
  "stage2-owner@example.com",
  "stage2-owner-password",
  "This prompt must not be admitted.",
];
const forbiddenAttribute = /(?:^|[._])(prompt|secret|tool[._](?:arguments|result))(?:$|[._])/iu;
const key = (span) => `${span.traceID}/${span.spanID}`;
const tag = (span, name) => span.tags?.find((t) => t.key === name)?.value;
const service = (trace, span) => trace.processes?.[span.processID]?.serviceName;

function privateDataAbsent(traces, captureRpcContent = false) {
  for (const trace of traces)
    for (const span of trace.spans ?? []) {
      for (const attribute of span.tags ?? [])
        assert(!forbiddenAttribute.test(attribute.key), "trace exported forbidden attribute");
    }
  const inspected = structuredClone(traces);
  for (const trace of inspected)
    for (const span of trace.spans ?? [])
      for (const event of span.logs ?? []) {
        const field = (name) => event.fields?.find((value) => value.key === name);
        const body = field("antnest.payload.json");
        if (body === undefined) continue;
        assert(captureRpcContent, "RPC content captured while disabled");
        assert(
          ["antnest.request", "antnest.response"].includes(field("event")?.value),
          "unexpected content event",
        );
        assert(
          tag(span, "rpc.method") && tag(span, "span.kind") !== "client",
          "content outside a receiving RPC boundary",
        );
        assert.equal(typeof body.value, "string");
        JSON.parse(body.value);
        body.value = "";
      }
  const encoded = JSON.stringify(inspected);
  for (const forbidden of forbiddenValues)
    assert(!encoded.includes(forbidden), "trace exported forbidden business data");
}

function ancestors(trace, span) {
  const indexed = new Map(trace.spans.map((s) => [key(s), s]));
  const seen = new Set();
  const result = [];
  while (span && !seen.has(key(span))) {
    seen.add(key(span));
    result.push(span);
    const parent = span.references?.find((r) => r.refType === "CHILD_OF");
    span = parent && indexed.get(key(parent));
  }
  return result;
}

function operationChain(trace, chain) {
  const matches = (span, node) =>
    service(trace, span) === node[0] && span.operationName === node[1];
  return trace.spans.some((span) => {
    const path = ancestors(trace, span);
    return (
      matches(span, chain.at(-1)) &&
      chain.toReversed().every((node, i) => path[i] && matches(path[i], node))
    );
  });
}

function inspectTrace(trace, kind) {
  assert(trace?.spans?.length, `${kind} trace missing`);
  const expected = expectations()[kind];
  const services = new Set(trace.spans.map((s) => service(trace, s)));
  for (const name of expected.services) assert(services.has(name), `missing service ${name}`);
  for (const [name, operations] of Object.entries(expected.operations)) {
    for (const operation of operations)
      assert(
        trace.spans.some((s) => service(trace, s) === name && s.operationName === operation),
        `missing ${name}/${operation}`,
      );
  }
  for (const [parent, child] of expected.edges)
    assert(
      trace.spans.some(
        (s) =>
          service(trace, s) === child && service(trace, ancestors(trace, s)[1] ?? {}) === parent,
      ),
      `missing edge ${parent} -> ${child}`,
    );
  for (const [parent, parentOp, child, childOp] of expected.operationEdges)
    assert(
      operationChain(trace, [
        [parent, parentOp],
        [child, childOp],
      ]),
      `missing edge ${parentOp} -> ${childOp}`,
    );
  for (const chain of expected.operationChains)
    assert(operationChain(trace, chain), `missing operation chain ${JSON.stringify(chain)}`);
  return {
    trace_id: trace.traceID,
    kind,
    services: [...services].sort(),
    spans: trace.spans.length,
  };
}

export function inspectAcpControllerCalls(trace) {
  const routes = {
    "agent_controller.resolve_agent_access": "resolve-agent-access",
    "agent_controller.acquire_run": "acquire-run",
    "agent_controller.finish_run": "finish-run",
  };
  for (const [operation, route] of Object.entries(routes)) {
    const calls = trace.spans.filter(
      (span) => service(trace, span) === "agent-acp-service" && span.operationName === operation,
    );
    assert(calls.length > 0, `missing ACP operation ${operation}`);
    for (const call of calls) {
      assert.notEqual(
        tag(call, "span.kind"),
        "client",
        "adapter operation must not duplicate CLIENT",
      );
      const clients = trace.spans.filter(
        (span) =>
          service(trace, span) === "agent-acp-service" &&
          span.operationName === "HTTP POST agent-controller" &&
          span.references?.some((ref) => ref.refType === "CHILD_OF" && key(ref) === key(call)),
      );
      assert.equal(clients.length, 1, `${operation} must send exactly one HTTP CLIENT`);
      assert.equal(tag(clients[0], "span.kind"), "client");
      const servers = trace.spans.filter(
        (span) =>
          service(trace, span) === "agent-controller" &&
          span.operationName === `HTTP POST /rpc/agent-controller/${route}` &&
          span.references?.some(
            (ref) => ref.refType === "CHILD_OF" && key(ref) === key(clients[0]),
          ),
      );
      assert.equal(
        servers.length,
        1,
        `${operation} must have one receiving SERVER parented by its CLIENT`,
      );
      assert.equal(tag(servers[0], "span.kind"), "server");
    }
  }
}

export function inspectExecutionTraces({ admission, runs, captureRpcContent = false }) {
  privateDataAbsent([admission, ...runs], captureRpcContent);
  assert.equal(runs.length, 1, "Stage 2 must execute exactly one admitted Run");
  const runTrace = runs[0];
  const roots = runTrace.spans.filter(
    (span) => service(runTrace, span) === "agent-acp-service" && span.operationName === "agent.run",
  );
  assert.equal(roots.length, 1, "one Run root required");
  const root = roots[0];
  assert(
    !root.references?.some((ref) => ref.refType === "CHILD_OF"),
    "Run must be an asynchronous root",
  );
  const sources = admission.spans.filter(
    (span) =>
      service(admission, span) === "agent-acp-service" &&
      span.operationName === "acp session/prompt",
  );
  assert(
    root.references?.some(
      (ref) => ref.refType === "FOLLOWS_FROM" && sources.some((source) => key(source) === key(ref)),
    ),
    "Run must link to the exact ACP request",
  );
  assert.equal(tag(root, "antnest.outcome"), "ok", "Run did not complete successfully");
  assert(
    tag(root, "antnest.run.id") && tag(root, "antnest.session.id"),
    "Run correlation IDs missing",
  );
  const traces = [admission, ...runs];
  const merged = { traceID: admission.traceID, spans: [], processes: {} };
  for (const trace of traces) {
    for (const [id, process] of Object.entries(trace.processes))
      merged.processes[`${trace.traceID}/${id}`] = process;
    merged.spans.push(
      ...trace.spans.map((span) => ({ ...span, processID: `${trace.traceID}/${span.processID}` })),
    );
  }
  inspectAcpControllerCalls(merged);
  return {
    ...inspectTrace(merged, "execution"),
    run_traces: runs.map((trace) => trace.traceID),
    causal_links_verified: true,
  };
}

export function inspectLifecycleTraces({
  admission,
  workers,
  requestID,
  agentID,
  captureRpcContent = false,
}) {
  privateDataAbsent([admission, ...workers], captureRpcContent);
  inspectTrace(admission, "lifecycle");
  const accepted = admission.spans.filter(
    (s) =>
      service(admission, s) === "agent-controller" &&
      s.operationName === "HTTP POST /internal/agents" &&
      tag(s, "http.response.status_code") === 202 &&
      tag(s, "antnest.lifecycle.kind") === "create" &&
      tag(s, "antnest.agent.id") === agentID,
  );
  assert.equal(accepted.length, 1, "one exact admission required");
  const phases = ["network_ensure", "runtime_initialize", "publish"];
  const roots = [];
  for (const trace of workers) {
    const candidates = trace.spans.filter(
      (s) =>
        service(trace, s) === "agent-controller" &&
        s.operationName === "recover Agent lifecycle operation",
    );
    assert.equal(candidates.length, 1, "one worker root per trace required");
    const root = candidates[0];
    assert.equal(tag(root, "antnest.lifecycle.request_id"), requestID);
    assert.equal(tag(root, "antnest.lifecycle.kind"), "create");
    assert.equal(tag(root, "antnest.agent.id"), agentID);
    assert(root.duration > 0 && tag(root, "error") !== true, "worker failed or incomplete");
    assert(
      trace.spans.every((s) => s.traceID === root.traceID),
      "mixed trace IDs",
    );
    assert(
      !root.references?.some((r) => r.refType === "CHILD_OF"),
      "worker must be asynchronous root",
    );
    const phase = tag(root, "antnest.lifecycle.phase");
    assert(phases.includes(phase), `unexpected phase ${phase}`);
    if (phase === "runtime_initialize") {
      const call = descendant(trace, root, "agent-controller", "HTTP POST runtime-controller");
      const server = descendant(
        trace,
        call,
        "runtime-controller",
        "runtime.lifecycle.initialize_runtime",
      );
      descendant(trace, server, "runtime-controller", "runtime.platform.create");
    } else {
      const call =
        phase === "network_ensure"
          ? descendant(trace, root, "agent-controller", "HTTP PUT runtime-egress")
          : root;
      descendant(
        trace,
        call,
        "antnest-runtime-egress",
        phase === "network_ensure"
          ? "HTTP PUT /internal/agent-networks/{agent_id}"
          : "HTTP PUT /internal/agent-network-attachments/{agent_id}",
      );
    }
    roots.push(root);
  }
  assert.deepEqual(
    [...new Set(roots.map((s) => tag(s, "antnest.lifecycle.phase")))].sort(),
    [...phases].sort(),
    "incomplete phases",
  );
  roots.sort(
    (a, b) =>
      tag(a, "antnest.lifecycle.recovery.attempt") - tag(b, "antnest.lifecycle.recovery.attempt"),
  );
  for (const [i, root] of roots.entries()) {
    assert.equal(
      tag(root, "antnest.lifecycle.recovery.attempt"),
      i + 1,
      "missing/duplicate attempt",
    );
    const links = new Set(root.references.filter((r) => r.refType === "FOLLOWS_FROM").map(key));
    assert(links.has(key(accepted[0])), "worker not linked to exact admission");
    if (i) assert(links.has(key(roots[i - 1])), "worker not linked to previous attempt");
  }
  const last = roots.at(-1);
  const orderedPhases = roots.map((root) => tag(root, "antnest.lifecycle.phase"));
  assert.deepEqual(
    orderedPhases.filter((phase, i) => i === 0 || phase !== orderedPhases[i - 1]),
    phases,
    "reordered lifecycle phases",
  );
  assert.equal(tag(last, "antnest.lifecycle.phase"), "publish");
  assert.equal(tag(last, "antnest.lifecycle.recovery.terminal"), true);
  assert.equal(tag(last, "antnest.lifecycle.recovery.state"), "completed");
  return {
    ...inspectTrace(admission, "lifecycle"),
    phase_traces: roots.length,
    worker_traces: roots.map((s) => ({
      trace_id: s.traceID,
      span_id: s.spanID,
      phase: tag(s, "antnest.lifecycle.phase"),
      attempt: tag(s, "antnest.lifecycle.recovery.attempt"),
    })),
    causal_links_verified: true,
  };
}

function descendant(trace, parent, owner, operation) {
  const found = trace.spans.find(
    (s) =>
      service(trace, s) === owner &&
      s.operationName === operation &&
      ancestors(trace, s)
        .slice(1)
        .some((p) => key(p) === key(parent)),
  );
  assert(found, `missing descendant ${owner}/${operation}`);
  return found;
}

async function main() {
  const [base, traceId, kind, requestID, agentID] = process.argv.slice(2);
  const captureRpcContent = process.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT === "true";
  assert(
    base && traceId && ["lifecycle", "execution"].includes(kind),
    "Jaeger URL, trace ID and kind required",
  );
  if (kind === "lifecycle")
    assert(requestID && agentID, "lifecycle request and Agent IDs required");
  const read = async (path) => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, "Jaeger request failed");
    return (await response.json()).data;
  };
  const query = new URLSearchParams({
    service: "agent-controller",
    operation: "recover Agent lifecycle operation",
    lookback: "1h",
    limit: "100",
    tags: JSON.stringify({ "antnest.lifecycle.request_id": requestID }),
  });
  let last;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    let admission, workers;
    try {
      [admission] = await read(`/api/traces/${traceId}`);
      if (kind === "lifecycle") workers = await read(`/api/traces?${query}`);
      else {
        const runQuery = new URLSearchParams({
          service: "agent-acp-service",
          operation: "agent.run",
          lookback: "1h",
          limit: "100",
        });
        workers = (await read(`/api/traces?${runQuery}`)).filter((trace) =>
          trace.spans.some(
            (span) =>
              span.operationName === "agent.run" &&
              span.references?.some(
                (ref) => ref.refType === "FOLLOWS_FROM" && ref.traceID === traceId,
              ),
          ),
        );
      }
    } catch (error) {
      last = error;
      await delay(1000);
      continue;
    }
    privateDataAbsent([admission, ...workers].filter(Boolean), captureRpcContent);
    try {
      assert.equal(admission?.traceID, traceId, "admission/execution trace ID mismatch");
      const result =
        kind === "lifecycle"
          ? inspectLifecycleTraces({ admission, workers, requestID, agentID, captureRpcContent })
          : inspectExecutionTraces({ admission, runs: workers, captureRpcContent });
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    } catch (error) {
      last = error;
    }
    await delay(1000);
  }
  throw new Error(`incomplete ${kind} trace: ${last?.message}`);
}

function expectations() {
  return {
    lifecycle: {
      services: ["agent-controller", "identity-service"],
      operations: {
        "agent-controller": ["HTTP POST /internal/agents", "HTTP POST identity-service"],
        "identity-service": ["HTTP POST /rpc/identity/resolve-owner-authorization"],
      },
      edges: [["agent-controller", "identity-service"]],
      operationEdges: [],
      operationChains: [
        [
          ["agent-controller", "HTTP POST /internal/agents"],
          ["agent-controller", "HTTP POST identity-service"],
          ["identity-service", "HTTP POST /rpc/identity/resolve-owner-authorization"],
        ],
      ],
    },
    execution: {
      services: ["agent-acp-service", "agent-controller", "identity-service", "antnest-runtime"],
      operations: {
        "agent-acp-service": [
          "HTTP POST agent-controller",
          "acp session/prompt",
          "agent_controller.resolve_agent_access",
          "acp.session.prompt",
          "agent.run",
          "agent_controller.acquire_run",
          "model.complete",
          "mcp.tools.list",
          "mcp.tools.call",
          "agent_controller.finish_run",
        ],
        "agent-controller": [
          "HTTP POST /rpc/agent-controller/resolve-agent-access",
          "HTTP POST identity-service",
          "HTTP POST /rpc/agent-controller/acquire-run",
          "HTTP POST /rpc/agent-controller/finish-run",
        ],
        "identity-service": ["HTTP POST /rpc/identity/resolve-principal"],
        "antnest-runtime": [
          "HTTP POST /mcp",
          "runtime.mcp.operation",
          "runtime.mcp.tool",
          "runtime.executor",
        ],
      },
      edges: [
        ["agent-acp-service", "agent-controller"],
        ["agent-controller", "identity-service"],
        ["agent-acp-service", "antnest-runtime"],
      ],
      operationEdges: [
        [
          "agent-acp-service",
          "HTTP POST agent-controller",
          "agent-controller",
          "HTTP POST /rpc/agent-controller/resolve-agent-access",
        ],
        [
          "agent-controller",
          "HTTP POST /rpc/agent-controller/resolve-agent-access",
          "agent-controller",
          "HTTP POST identity-service",
        ],
        [
          "agent-controller",
          "HTTP POST identity-service",
          "identity-service",
          "HTTP POST /rpc/identity/resolve-principal",
        ],
      ],
      operationChains: [
        [
          ["agent-acp-service", "agent_controller.resolve_agent_access"],
          ["agent-acp-service", "HTTP POST agent-controller"],
          ["agent-controller", "HTTP POST /rpc/agent-controller/resolve-agent-access"],
          ["agent-controller", "HTTP POST identity-service"],
          ["identity-service", "HTTP POST /rpc/identity/resolve-principal"],
        ],
        [
          ["agent-acp-service", "agent_controller.acquire_run"],
          ["agent-acp-service", "HTTP POST agent-controller"],
          ["agent-controller", "HTTP POST /rpc/agent-controller/acquire-run"],
          ["agent-controller", "HTTP POST identity-service"],
          ["identity-service", "HTTP POST /rpc/identity/resolve-principal"],
        ],
        [
          ["agent-acp-service", "agent_controller.finish_run"],
          ["agent-acp-service", "HTTP POST agent-controller"],
          ["agent-controller", "HTTP POST /rpc/agent-controller/finish-run"],
        ],
      ],
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
