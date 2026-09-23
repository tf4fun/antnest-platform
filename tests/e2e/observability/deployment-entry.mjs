import assert from "node:assert/strict";
import { inspectHTTPTrace } from "./evidence.mjs";
import { tag } from "./trace-tree.mjs";
import { assertSuccessfulSpan } from "./successful-span.mjs";

export function inspectDeploymentEntry(trace, path) {
  assert(["/status", "/"].includes(path), "unsupported deployment entry");
  const route = path === "/" ? "/{path...}" : path;
  const result = inspectHTTPTrace(trace, {
    rootService: "edge-gateway",
    route,
    status: 200,
    localOnly: path === "/status",
    captureRpcContent: false,
    hops: path === "/" ? [["edge-gateway", "admin-console"]] : [],
  });
  const roles = [
    ["edge-gateway", "server"],
    ...(path === "/"
      ? [
          ["edge-gateway", "client"],
          ["admin-console", "server"],
        ]
      : []),
  ];
  assert.equal(trace.spans.length, roles.length, "unexpected entry spans");
  const chain = [];
  for (const [service, kind] of roles) {
    const matches = trace.spans.filter(
      (span) =>
        trace.processes[span.processID].serviceName === service &&
        tag(span, "span.kind") === kind,
    );
    assert.equal(matches.length, 1, "missing/duplicate entry role");
    const span = matches[0];
    assert.equal(tag(span, "http.request.method"), "GET");
    assert.equal(tag(span, "http.response.status_code"), 200);
    if (kind === "server") assert.equal(tag(span, "http.route"), route);
    else assert.equal(tag(span, "server.address"), "admin-console");
    const parentID = chain.at(-1)?.span_id ?? null;
    assert.deepEqual(
      span.references ?? [],
      parentID
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parentID }]
        : [],
      "entry must have exact direct parentage",
    );
    assertSuccessfulSpan(span);
    chain.push({
      span_id: span.spanID,
      parent_span_id: parentID,
      service,
      kind,
      method: "GET",
      route: kind === "server" ? route : null,
      status: 200,
      duration_ms: span.duration / 1000,
    });
  }
  return { ...result, path, errors: 0, chain };
}
