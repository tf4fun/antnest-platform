import { workflowFixture } from "./workflow-fixtures.mjs";
import { observabilityResolutionFixture } from "./resolve-evidence-fixtures.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";
import { tag } from "./trace-tree.mjs";

export function workflowObservationFixture(kind = "create", source = "cache") {
  const f = observabilityResolutionFixture(source, "console");
  const route =
    kind === "create"
      ? "/api/admin/agents"
      : `/api/admin/agents/{agent_id}/${kind}`;
  const consoleServer = f.trace.spans.find((s) => s.spanID === "console");
  for (const span of [f.root, f.upstream, consoleServer]) {
    setTag(span, "http.request.method", "POST");
    setTag(span, "http.response.status_code", 202);
  }
  setTag(consoleServer, "http.route", route);
  f.root.operationName = "HTTP POST /api/admin/{path...}";
  f.upstream.operationName = "HTTP POST admin-console";
  consoleServer.operationName = `HTTP POST ${route}`;
  const business = workflowFixture(kind);
  Object.assign(f.trace.processes, business.processes);
  for (const span of business.spans) {
    if (["gateway", "console", "client-console"].includes(span.spanID))
      continue;
    span.startTime += consoleServer.startTime;
    if (span.logs?.length) {
      setTag(span, "rpc.service", "runtime-controller");
      setTag(span, "rpc.system.name", "antnest.http-json");
      setTag(
        span,
        "rpc.method",
        `${tag(span, "http.request.method")} ${tag(span, "http.route")}`,
      );
    }
    f.trace.spans.push(span);
  }
  Object.assign(f.expected, {
    method: "POST",
    status: 202,
    consoleRoute: route,
  });
  return { ...f, kind, requestID: "request-test", agentID: "agent-test" };
}
