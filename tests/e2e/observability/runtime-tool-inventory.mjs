import assert from "node:assert/strict";
import { tag } from "./trace-tree.mjs";
import {
  one,
  expected,
  runtimeToolEvidence,
} from "./runtime-tool-evidence.mjs";

// Fixed topology and identity only. Parsed-result or cancellation semantics
// still require their owning inspector; membership never neutralizes an error.
export function inspectRuntimeToolInventory(trace, owner, identity) {
  const { agentId, executionId } = identity;
  for (const value of [agentId, executionId])
    assert(typeof value === "string" && value.length > 0);
  const evidence = runtimeToolEvidence(trace, owner, identity);
  const { tree, children, process, sameProcess } = evidence;
  assert.equal(
    tree.spans.get(owner?.spanID),
    owner,
    "foreign tool inventory owner",
  );
  assert(["mcp.tools.list", "mcp.tools.call"].includes(owner.operationName));
  process(owner, "agent-acp-service");
  const method =
    owner.operationName === "mcp.tools.list" ? "tools/list" : "tools/call";
  expected(owner, {
    "span.kind": "internal",
    "antnest.runtime.execution.id": executionId,
    "antnest.mcp.method": method,
  });
  const clients = children(owner).filter(
    (span) =>
      span.operationName === "HTTP POST antnest-runtime" ||
      tag(span, "peer.service") === "antnest-runtime",
  );
  assert.equal(
    clients.length,
    2,
    "tool inventory requires discovery and invocation",
  );
  const exchanges = clients.map((client) => {
    sameProcess(client, owner, "agent-acp-service");
    assert.equal(client.operationName, "HTTP POST antnest-runtime");
    expected(client, {
      "span.kind": "client",
      "http.request.method": "POST",
      "peer.service": "antnest-runtime",
    });
    const server = one(children(client), "inventory Runtime SERVER");
    process(server, "antnest-runtime");
    assert.equal(server.operationName, "HTTP POST /mcp");
    const rpc = tag(server, "rpc.method"),
      generation = tag(server, "antnest.runtime.generation");
    assert(["discover", method].includes(rpc));
    assert(typeof generation === "string" && generation.length > 0);
    expected(server, {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/mcp",
      "antnest.agent.id": agentId,
      "antnest.runtime.execution.id": executionId,
    });
    const operation = one(children(server), "inventory Runtime operation");
    sameProcess(operation, server, "antnest-runtime");
    assert.equal(operation.operationName, "runtime.mcp.operation");
    expected(operation, {
      "span.kind": "internal",
      "rpc.method": rpc,
      "antnest.agent.id": agentId,
      "antnest.runtime.execution.id": executionId,
      "antnest.runtime.generation": generation,
    });
    return { client, server, operation, method: rpc, generation };
  });
  const discovery = one(
    exchanges.filter((pair) => pair.method === "discover"),
    "inventory discovery",
  );
  const invocation = one(
    exchanges.filter((pair) => pair.method === method),
    "inventory invocation",
  );
  sameProcess(discovery.server, invocation.server, "antnest-runtime");
  assert.equal(
    discovery.generation,
    invocation.generation,
    "tool inventory changed Runtime generation",
  );
  return {
    ...evidence,
    owner,
    method,
    clients,
    servers: exchanges.map((pair) => pair.server),
    exchanges,
    discovery,
    invocation,
  };
}

function sameMembers(actual, expectedMembers, name) {
  assert(Array.isArray(actual), "missing tool inventory " + name);
  assert.equal(
    actual.length,
    expectedMembers.length,
    "incomplete tool inventory " + name,
  );
  assert.equal(
    new Set(actual).size,
    actual.length,
    "duplicate tool inventory " + name,
  );
  assert(
    actual.every((item) => expectedMembers.includes(item)),
    "foreign tool inventory " + name,
  );
}

// A call inspector supplies policy, never an escape from the full raw inventory.
export function requireRuntimeToolInventory(trace, owner, identity, proof) {
  assert(
    proof && typeof proof === "object" && typeof proof.then !== "function",
    "synchronous tool inventory receipt required",
  );
  const actual = inspectRuntimeToolInventory(trace, owner, identity);
  assert.strictEqual(proof.owner, owner, "borrowed tool inventory owner");
  assert.equal(proof.method, actual.method);
  sameMembers(proof.clients, actual.clients, "CLIENTs");
  sameMembers(proof.servers, actual.servers, "SERVERs");
  assert(
    Array.isArray(proof.exchanges) &&
      proof.exchanges.length === actual.exchanges.length,
    "incomplete tool exchange inventory",
  );
  sameMembers(
    proof.exchanges.map((pair) => pair.client),
    actual.clients,
    "exchange CLIENTs",
  );
  for (const pair of proof.exchanges) {
    const raw = actual.exchanges.find((entry) => entry.client === pair.client);
    for (const key of ["server", "operation", "method", "generation"])
      assert.strictEqual(pair[key], raw[key], "foreign tool exchange " + key);
  }
  assert.strictEqual(
    proof.discovery,
    one(
      proof.exchanges.filter((pair) => pair.method === "discover"),
      "receipt discovery",
    ),
  );
  assert.strictEqual(
    proof.invocation,
    one(
      proof.exchanges.filter((pair) => pair.method === actual.method),
      "receipt invocation",
    ),
  );
  const members = new Set([
    owner,
    ...actual.clients,
    ...actual.servers,
    ...actual.exchanges.map((pair) => pair.operation),
  ]);
  assert(
    proof.ownedCancellations instanceof Set,
    "tool cancellation inventory required",
  );
  for (const span of proof.ownedCancellations)
    assert(members.has(span), "foreign tool cancellation claim");
  assert(
    Array.isArray(proof.neutralDiagnostics) &&
      Array.isArray(proof.timeObservations),
    "tool observations required",
  );
  if (
    tag(owner, "antnest.mcp.caller_cancelled") === true ||
    tag(owner, "antnest.mcp.tool_result.outcome") === "not_received"
  )
    assert.equal(
      proof.neutralDiagnostics.length,
      0,
      "unparsed caller cancellation cannot claim successful cleanup",
    );
  for (const observation of [
    ...proof.neutralDiagnostics,
    ...proof.timeObservations,
  ]) {
    assert.equal(
      observation.trace_id,
      trace.traceID,
      "foreign tool observation Trace",
    );
    const span = actual.tree.spans.get(observation.span_id);
    assert(members.has(span), "foreign tool observation span");
    if (proof.neutralDiagnostics.includes(observation)) {
      assert(
        Number.isInteger(observation.event_index) &&
          observation.event_index >= 0,
      );
      assert.equal(
        span.logs?.[observation.event_index]?.timestamp,
        observation.event_timestamp_us,
        "tool diagnostic is not an original event",
      );
    } else {
      assert.equal(observation.tool_span_id, owner.spanID);
      assert.equal(observation.process_id, span.processID);
    }
  }
  return proof;
}
