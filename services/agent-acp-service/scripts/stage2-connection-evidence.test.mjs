import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectGatewayConnection } from "./stage2-boundary-evidence.mjs";

function fixture() {
  const connection = {
    traceID: "socket",
    processes: {
      gateway: { serviceName: "edge-gateway" },
      acp: { serviceName: "agent-acp-service" },
    },
    spans: [],
  };
  const add = (id, service, kind, parent) =>
    connection.spans.push({
      traceID: "socket",
      spanID: id,
      operationName: "HTTP GET",
      processID: service,
      tags: [
        { key: "span.kind", value: kind },
        { key: "http.response.status_code", value: 101 },
      ],
      references: parent ? [{ refType: "CHILD_OF", traceID: "socket", spanID: parent }] : [],
    });
  add("gateway", "gateway", "server");
  add("dial", "gateway", "client", "gateway");
  add("acp", "acp", "server", "dial");
  const prompt = { references: [{ refType: "FOLLOWS_FROM", traceID: "socket", spanID: "acp" }] };
  return { connection, prompt };
}

test("ACP request links to the authenticated Gateway WebSocket connection", () => {
  assert.equal(inspectGatewayConnection(fixture()).trace_id, "socket");
});
test("Gateway message links directly to its receiving WebSocket connection", () => {
  const value = fixture();
  value.prompt.references[0].spanID = "gateway";
  assert.equal(inspectGatewayConnection(value).trace_id, "socket");
});
for (const [name, change] of [
  ["wrong connection", (value) => (value.prompt.references[0].spanID = "dial")],
  [
    "non-Gateway upstream",
    (value) => (value.connection.processes.gateway.serviceName = "agent-controller"),
  ],
  ["unparented ACP connection", (value) => (value.connection.spans[2].references = [])],
  ["failed handshake", (value) => (value.connection.spans[2].tags[1].value = 503)],
])
  test(`connection evidence rejects ${name}`, () => {
    const value = fixture();
    change(value);
    assert.throws(() => inspectGatewayConnection(value));
  });
