import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";

export function inspectPricingTrace(trace, expected, secrets = []) {
  assert.equal(
    trace.traceID,
    expected.traceID,
    "wrong pricing response Trace ID",
  );
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  assert.equal(
    trace.spans.filter(hasError).length,
    0,
    "pricing command failed",
  );
  const server = (service, route) => {
    const matches = trace.spans.filter(
      (s) =>
        tree.service(s) === service &&
        tag(s, "span.kind") === "server" &&
        tag(s, "http.route") === route &&
        tag(s, "http.request.method") === "POST",
    );
    assert.equal(
      matches.length,
      1,
      "missing or duplicate pricing command server",
    );
    assert.equal(tag(matches[0], "http.response.status_code"), 201);
    return matches[0];
  };
  const controller = server("agent-controller", expected.route);
  const console = server("admin-console", expected.publicRoute);
  const edge = server("edge-gateway", "/api/admin/{path...}");
  assert.equal(tree.parent(edge), undefined);
  const forwarded = tree.parent(controller),
    consoleForwarded = tree.parent(console);
  assert.equal(tree.service(forwarded), "admin-console");
  assert.equal(tag(forwarded, "span.kind"), "client");
  assert.equal(tree.parent(forwarded), console);
  assert.equal(tree.service(consoleForwarded), "edge-gateway");
  assert.equal(tag(consoleForwarded, "span.kind"), "client");
  assert.equal(tree.parent(consoleForwarded), edge);
  const transactions = trace.spans.filter(
    (s) =>
      tree.service(s) === "agent-controller" &&
      tree.chain(s).includes(controller) &&
      s.operationName === "postgresql transaction" &&
      tag(s, "db.system.name") === "postgresql" &&
      tag(s, "antnest.transaction.outcome") === "committed",
  );
  const writes = trace.spans.filter(
    (s) =>
      tree.service(s) === "agent-controller" &&
      tag(s, "span.kind") === "client" &&
      tag(s, "db.system.name") === "postgresql" &&
      ["INSERT", "UPDATE"].includes(tag(s, "db.operation.name")) &&
      /\bmodel_profiles\b/.test(tag(s, "db.query.text") ?? "") &&
      transactions.some((tx) => tree.chain(s).includes(tx)),
  );
  assert(writes.length, "missing committed current Model price write");
  return {
    trace_id: trace.traceID,
    route: expected.route,
    persistence: true,
    database_writes: writes.length,
    gateway_console_ancestry: true,
    ...timingEvidence(trace, tree, controller, forwarded),
  };
}
