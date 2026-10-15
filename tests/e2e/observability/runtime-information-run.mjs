import assert from "node:assert/strict";
import { inspectRuntimeInformationRead } from "./runtime-information-read.mjs";
import { inspectRuntimeToolLifecycle } from "./runtime-tool-lifecycle.mjs";
import { tag, traceTopology } from "./trace-tree.mjs";

const one = (spans, label) => {
  assert.equal(spans.length, 1, `missing or duplicate ${label}`);
  return spans[0];
};
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished Run preparation span",
  );
  return span.startTime + span.duration;
};
const within = (child, owner) => {
  assert(
    child.startTime >= owner.startTime && end(child) <= end(owner),
    "preparation outside owning Run lifetime",
  );
};
const fields = (span) => [
  ...(span.tags ?? []),
  ...(span.logs ?? []).flatMap((event) => event.fields ?? []),
];
const cancelled = (span) =>
  fields(span).some(
    ({ key, value }) =>
      (key.endsWith(".outcome") && ["canceled", "cancelled"].includes(value)) ||
      (key === "event" && value === "antnest.cancelled") ||
      (key === "http.transport.error.type" &&
        value === "client_disconnected") ||
      (key === "antnest.cancellation.type" && value !== ""),
  );

/** Read proof is owned by its Run preparation or a separate v1 completion refresh. */
export function inspectRunInformationReads(
  trace,
  { request, run, closedBeforeResponse = false },
) {
  const tree = traceTopology(trace);
  for (const span of [request, run]) {
    assert.equal(tree.spans.get(span?.spanID), span, "foreign Run read owner");
    assert.equal(tree.service(span), "agent-acp-service");
  }
  assert.equal(tag(request, "rpc.method"), "session/prompt");
  assert.equal(tag(request, "span.kind"), "server");
  assert.equal(run.operationName, "agent.run");
  assert.equal(
    run.processID,
    request.processID,
    "Run uses another ACP process",
  );
  assert(
    tree.chain(run).includes(request),
    "Run detached from original prompt",
  );
  const agentId = tag(request, "antnest.agent.id");
  const sessionId = tag(request, "antnest.session.id");
  const executionId = tag(run, "antnest.runtime.execution_id");
  for (const value of [agentId, sessionId, executionId])
    assert(
      typeof value === "string" && value.length > 0,
      "Run read identity missing",
    );
  assert.equal(
    tag(run, "antnest.session.id"),
    sessionId,
    "Run read Session differs from original prompt",
  );
  const protocol = tag(request, "antnest.protocol.version");
  assert(["v1", "v2"].includes(protocol), "unknown Run read protocol");
  const acp = (name) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === name,
    );
  const info = one(acp("mcp.runtime.info"), "Run information preparation");
  const list = one(acp("mcp.tools.list"), "Run tool preparation");
  for (const prep of [info, list]) {
    assert.equal(
      tree.parent(prep),
      run,
      "preparation not directly owned by original Run",
    );
    assert.equal(
      prep.processID,
      run.processID,
      "preparation uses another ACP process",
    );
    within(prep, run);
  }
  const preparationObservations = [];
  if (end(info) > list.startTime) {
    // Both preparations have already been bound directly to this same Run and
    // ACP process. Keep the original Node endpoint difference as an observation;
    // this does not change either preparation's own events or read/tool proof.
    const resource = {};
    for (const { key, value } of trace.processes[info.processID].tags ?? []) {
      assert(!Object.hasOwn(resource, key), "ambiguous preparation resource");
      resource[key] = value;
    }
    assert(
      typeof resource["host.name"] === "string" &&
        resource["host.name"].length > 0 &&
        Number.isSafeInteger(resource["process.pid"]) &&
        resource["process.pid"] > 0 &&
        typeof resource["service.instance.id"] === "string" &&
        resource["service.instance.id"].length > 0,
      "missing actual preparation process identity",
    );
    assert(
      [info, list, run].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && end(info) - list.startTime < 1000,
      "tool listing preceded information close outside deferred same-Node sub-ms boundary",
    );
    preparationObservations.push({
      trace_id: trace.traceID,
      run_span_id: run.spanID,
      span_id: info.spanID,
      next_span_id: list.spanID,
      parent_span_id: run.spanID,
      process_id: info.processID,
      host_name: resource["host.name"],
      process_pid: resource["process.pid"],
      service_instance_id: resource["service.instance.id"],
      boundary: "run-information-before-tool-list",
      raw_left_us: end(info),
      raw_right_us: list.startTime,
      raw_difference_us: end(info) - list.startTime,
      raw_span_start_us: info.startTime,
      raw_next_start_us: list.startTime,
      raw_parent_start_us: run.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  }
  const reads = trace.spans.filter(
    (span) => span.operationName === "mcp.runtime.info.read",
  );
  const runRead = inspectRuntimeInformationRead(
    trace,
    one(
      reads.filter((span) => tree.parent(span) === info),
      "parsed Run information read",
    ),
  );
  assert.equal(runRead.agentId, agentId, "Run read belongs to another Agent");
  assert.equal(
    runRead.executionId,
    executionId,
    "Run read differs from pinned execution",
  );
  const afterRun = reads.filter((span) => span !== runRead.read);
  assert(
    afterRun.length <= 1,
    "extra information read outside Run preparation",
  );
  let postPromptRead;
  if (afterRun.length) {
    assert.equal(
      protocol,
      "v1",
      "v2 prompt cannot refresh the v1 Skill catalog",
    );
    assert.equal(
      tree.parent(afterRun[0]),
      request,
      "post-prompt refresh not owned by original request",
    );
    assert(
      afterRun[0].startTime >= end(run),
      "post-prompt refresh preceded Run completion",
    );
    postPromptRead = inspectRuntimeInformationRead(trace, afterRun[0], {
      requestOutcome:
        closedBeforeResponse === true &&
        tag(request, "antnest.outcome") === "error"
          ? "closed-v1-response"
          : "success",
    });
    assert.equal(
      postPromptRead.agentId,
      agentId,
      "post-prompt refresh belongs to another Agent",
    );
    // The refresh uses the current directory binding, independently of the
    // completed Run's pinned execution. Each proof still binds its own Runtime.
  }
  const proofs = [runRead, ...(postPromptRead ? [postPromptRead] : [])];
  const spans = new Set(proofs.flatMap((proof) => proof.spans));

  // Account for the remaining Runtime exchanges separately. Their errors and
  // cancellation cannot borrow a read's parsed-result and owned-close proof.
  const targetClients = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      (span.operationName === "HTTP POST antnest-runtime" ||
        tag(span, "peer.service") === "antnest-runtime"),
  );
  const toolOwners = [list, ...acp("mcp.tools.call")];
  const toolClients = new Set();
  const toolServers = new Set();
  const toolProtocolSpans = new Set();
  const toolProofs = [];
  const ownedToolCancellations = new Set();
  for (const owner of toolOwners) {
    assert.equal(
      owner.processID,
      run.processID,
      "tool inventory belongs to another ACP process",
    );
    assert(tree.chain(owner).includes(run), "tool inventory detached from Run");
    const proof = inspectRuntimeToolLifecycle(trace, owner, {
      agentId,
      executionId,
    });
    toolProofs.push(proof);
    for (const client of proof.clients) {
      assert(!spans.has(client), "tool inventory borrowed information read");
      toolClients.add(client);
    }
    for (const { server, operation } of proof.exchanges) {
      toolServers.add(server);
      toolProtocolSpans.add(server);
      toolProtocolSpans.add(operation);
    }
    for (const span of proof.ownedCancellations)
      ownedToolCancellations.add(span);
  }

  for (const client of targetClients)
    assert(
      spans.has(client) || toolClients.has(client),
      "unowned Runtime CLIENT outside read/tool inventories",
    );
  for (const span of trace.spans) {
    if (spans.has(span)) continue;
    if (tree.service(span) === "antnest-runtime") {
      if (
        span.operationName === "runtime.mcp.operation" ||
        span.operationName === "HTTP POST /mcp"
      )
        assert(
          toolProtocolSpans.has(span),
          "unproven Runtime protocol boundary inside tool inventory",
        );
      assert(
        tree.chain(span).some((ancestor) => toolServers.has(ancestor)),
        "unowned Runtime work outside exact read/tool inventories",
      );
      assert.notEqual(
        tag(span, "rpc.method"),
        "resources/read",
        "unproven resource read inside tool inventory",
      );
    }
    assert(
      !cancelled(span) || ownedToolCancellations.has(span),
      "unowned cancellation cannot borrow information read cleanup",
    );
  }
  return {
    runRead,
    postPromptRead,
    spans,
    prepared: [info, list],
    informationReads: proofs.length,
    postPromptInformationReads: postPromptRead ? 1 : 0,
    toolLifecycles: toolProofs,
    neutralDiagnostics: [...proofs, ...toolProofs].flatMap(
      (proof) => proof.neutralDiagnostics,
    ),
    timeObservations: [
      ...preparationObservations,
      ...[...proofs, ...toolProofs].flatMap((proof) => proof.timeObservations),
    ],
  };
}
