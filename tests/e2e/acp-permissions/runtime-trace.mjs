import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectRuntimeInformationRead } from "../observability/runtime-information-read.mjs";
import { inspectRuntimeToolLifecycle } from "../observability/runtime-tool-lifecycle.mjs";
import { requireRuntimeToolInventory } from "../observability/runtime-tool-inventory.mjs";
import { privateACPDiagnosticView } from "../observability/private-acp-diagnostics.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  one,
  expected as expect,
  namedEvent,
  values,
  diagnostics,
} from "../observability/runtime-tool-evidence.mjs";

function inspectWork(trace, tree, proof, name) {
  const children = (parent) =>
    trace.spans.filter((span) => tree.parent(span) === parent);
  const operation = proof.invocation.operation;
  const tool = one(children(operation), "Permissions Runtime Tool");
  const work = one(children(tool), "Permissions Runtime work");
  const managed = name === "mcp__fixture__echo";
  assert.equal(tool.operationName, "runtime.mcp.tool");
  assert.equal(
    work.operationName,
    managed ? "runtime.mcp.stdio" : "runtime.executor",
  );
  assert.equal(
    children(work).length,
    0,
    "unaccounted Permissions work descendant",
  );
  const agentId = tag(proof.invocation.server, "antnest.agent.id");
  const generation = proof.invocation.generation;
  expect(operation, { "mcp.tool.name": name });
  expect(tool, {
    "span.kind": "internal",
    "antnest.agent.id": agentId,
    "antnest.runtime.generation": generation,
    "mcp.tool.name": managed ? "managed" : name,
    "mcp.tool.outcome": "success",
  });
  for (const span of [tool, work]) {
    assert.equal(
      span.processID,
      operation.processID,
      "Permissions work belongs to another Runtime",
    );
    assert.equal(tree.service(span), "antnest-runtime");
    const resource = values(trace.processes[span.processID].tags ?? []);
    assert.equal(resource["antnest.agent.id"], agentId);
    assert.equal(resource["antnest.runtime.generation"], generation);
    assert(
      ["OK", 1].includes(tag(span, "otel.status_code")),
      "Runtime work did not succeed",
    );
    diagnostics(span);
  }
  const complete = (span, event, fields) => {
    assert.equal(
      span.logs?.length,
      1,
      "missing or extra Permissions completion event",
    );
    const entry = namedEvent(span, event);
    expect(
      { tags: entry.fields },
      { level: "INFO", outcome: "success", ...fields },
    );
    assert(Number.isFinite(entry.timestamp));
    return entry;
  };
  const identity = (span) => ({
    "service.name": "antnest-runtime",
    "antnest.agent.id": agentId,
    "antnest.runtime.generation": generation,
    trace_id: trace.traceID,
    span_id: span.spanID,
  });
  if (managed) {
    expect(tool, { "error.type": "" });
    complete(tool, "Managed MCP tool finished", {
      "mcp.server.tool": name,
      "error.type": "",
    });
    expect(work, {
      "span.kind": "client",
      "mcp.tool.name": name,
      "rpc.method": "tools/call",
      "antnest.protocol.outcome": "success",
    });
    assert.equal(
      work.logs?.length ?? 0,
      0,
      "unexpected managed execution event",
    );
  } else {
    assert(["write", "read"].includes(name));
    complete(tool, "Runtime MCP tool completed", {
      ...identity(tool),
      tool: name,
    });
    expect(work, {
      "span.kind": "internal",
      "antnest.agent.id": agentId,
      "antnest.runtime.generation": generation,
      "executor.tool.name": name,
      "executor.exit.classification": "success",
      "executor.outcome": "success",
      "process.exit.code": 0,
    });
    const rawPID = tag(work, "executor.child.pid");
    const pid =
      typeof rawPID === "number"
        ? rawPID
        : typeof rawPID === "string" && /^[1-9][0-9]*$/u.test(rawPID)
          ? Number(rawPID)
          : NaN;
    assert(
      Number.isSafeInteger(pid) && pid > 0,
      "actual Permissions executor PID required",
    );
    for (const field of [
      ...work.tags,
      ...(work.logs ?? []).flatMap((entry) => entry.fields),
    ])
      assert(
        !["process.exit.signal", "executor.exit.signal"].includes(field.key),
        "unexpected executor signal",
      );
    complete(work, "Runtime Executor completed", {
      ...identity(work),
      "error.type": "",
    });
  }
  return [tool, work];
}

// Permission cancellation occurs before Tool dispatch. Keep Run/wait policy in
// the owning inspector; only parsed, completed Runtime exchanges can own their
// connection cleanup here. Shared consumers retain their original policies.
export function inspectPermissionRuntime(trace, expected, request, run) {
  const tree = traceTopology(trace);
  assert.equal(expected.boundary, "private-acp");
  assert.match(
    expected.phase ?? "",
    /^v[12]-(once|once-again|deny|always|follow|reject|reject-follow|chat|read-hint|judge-safe|judge-ask|cancel|reconnect)$/u,
  );
  for (const span of [request, run]) {
    assert.strictEqual(
      tree.spans.get(span?.spanID),
      span,
      "foreign Permissions Runtime owner",
    );
    assert.equal(tree.service(span), "agent-acp-service");
  }
  assert.equal(request.processID, run.processID);
  assert(tree.chain(run).includes(request));
  expect(request, {
    "rpc.method": "session/prompt",
    "span.kind": "server",
    "antnest.agent.id": expected.agentId,
    "antnest.session.id": expected.sessionId,
    "antnest.protocol.version": `v${expected.protocolVersion}`,
  });
  expect(run, { "antnest.session.id": expected.sessionId });
  const executionId = tag(run, "antnest.runtime.execution_id");
  assert(typeof executionId === "string" && executionId.length > 0);
  const acp = (name) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === name,
    );
  const info = one(
    acp("mcp.runtime.info"),
    "Permissions information preparation",
  );
  const lists = acp("mcp.tools.list"),
    calls = acp("mcp.tools.call");
  const chat = expected.phase.endsWith("chat");
  assert.equal(
    lists.length,
    chat ? 0 : 1,
    "incorrect Permissions Runtime catalogue inventory",
  );
  assert.equal(
    calls.length,
    /deny|reject|cancel|chat/.test(expected.phase) ? 0 : 1,
    "incorrect Permissions Runtime effect inventory",
  );
  for (const owner of [info, ...lists, ...calls]) {
    assert.strictEqual(
      tree.parent(owner),
      run,
      "Runtime operation not directly owned by Run",
    );
    assert.equal(
      owner.processID,
      run.processID,
      "Runtime operation uses another ACP process",
    );
  }
  const reads = trace.spans.filter(
    (span) => span.operationName === "mcp.runtime.info.read",
  );
  const preparation = one(
    reads.filter((span) => tree.parent(span) === info),
    "parsed Permissions Run information",
  );
  const runRead = inspectRuntimeInformationRead(trace, preparation);
  assert.equal(runRead.agentId, expected.agentId);
  assert.equal(
    runRead.executionId,
    executionId,
    "read differs from pinned Runtime execution",
  );
  const afterRun = reads.filter((span) => span !== preparation);
  assert(
    afterRun.length <= 1,
    "extra information read outside Permissions Run",
  );
  const proofs = [runRead];
  if (afterRun.length) {
    assert.equal(
      expected.protocolVersion,
      1,
      "v2 cannot refresh v1 Skill catalogue",
    );
    assert.strictEqual(
      tree.parent(afterRun[0]),
      request,
      "refresh detached from original request",
    );
    const lastInternalStart = Math.max(
      run.startTime,
      ...trace.spans
        .filter(
          (span) =>
            span.processID === run.processID && tree.chain(span).includes(run),
        )
        .map((span) => span.startTime),
    );
    assert(
      afterRun[0].startTime >= lastInternalStart,
      "refresh precedes final Run operations",
    );
    const closed =
      expected.closedBeforeResponse === true &&
      tag(request, "antnest.outcome") === "error";
    if (closed) assert.equal(expected.phase, "v1-reconnect");
    const post = inspectRuntimeInformationRead(trace, afterRun[0], {
      requestOutcome: closed ? "closed-v1-response" : "success",
    });
    assert.equal(post.agentId, expected.agentId);
    proofs.push(post);
  }
  const spans = new Set([info, ...proofs.flatMap((proof) => proof.spans)]);
  const toolProofs = [];
  for (const owner of [...lists, ...calls]) {
    const identity = { agentId: expected.agentId, executionId };
    const proof = inspectRuntimeToolLifecycle(trace, owner, identity);
    requireRuntimeToolInventory(trace, owner, identity, proof);
    assert.equal(
      proof.parsedOutcome,
      "success",
      "Permissions Runtime result failed",
    );
    // All preparation and work belongs to the same pinned Runtime instance.
    assert.equal(
      proof.invocation.server.processID,
      runRead.resource.server.processID,
    );
    assert.equal(proof.invocation.generation, runRead.resource.generation);
    const members = [
      owner,
      ...proof.clients,
      ...proof.servers,
      ...proof.exchanges.map((pair) => pair.operation),
    ];
    if (calls.includes(owner)) {
      const name = expected.phase.includes("judge-")
        ? "mcp__fixture__echo"
        : expected.phase.endsWith("read-hint")
          ? "read"
          : "write";
      expect(owner, {
        "tool.name": name,
        "mcp.source_id": "runtime",
        "antnest.run.id": tag(run, "antnest.run.id"),
      });
      members.push(...inspectWork(trace, tree, proof, name));
    }
    for (const member of members) {
      assert(!spans.has(member), "Runtime evidence reused across exchanges");
      spans.add(member);
    }
    toolProofs.push(proof);
  }
  for (const span of trace.spans)
    if (
      tree.service(span) === "antnest-runtime" ||
      (tree.service(span) === "agent-acp-service" &&
        (span.operationName === "HTTP POST antnest-runtime" ||
          tag(span, "peer.service") === "antnest-runtime"))
    )
      assert(spans.has(span), "unowned Permissions Runtime span");
  const neutralDiagnostics = [...proofs, ...toolProofs].flatMap(
    (proof) => proof.neutralDiagnostics,
  );
  for (const span of spans)
    assertSessionSuccess(
      privateACPDiagnosticView(trace, span, neutralDiagnostics, spans),
    );
  return {
    spans,
    prepared: [info, ...lists],
    runRead,
    toolLifecycles: toolProofs,
    informationReads: proofs.length,
    postPromptInformationReads: afterRun.length,
    catalogReads: lists.length,
    toolCalls: calls.length,
    neutralDiagnostics,
    timeObservations: [...proofs, ...toolProofs].flatMap(
      (proof) => proof.timeObservations,
    ),
  };
}
