import { fields } from "./trace-fixtures.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";
import { observabilityResolutionFixture } from "./resolve-evidence-fixtures.mjs";

export function consoleObservationFixture(kind, source = "cache") {
  const f = observabilityResolutionFixture(source, "console");
  const template = kind === "template";
  const method = template ? "POST" : "PUT";
  const status = template ? 201 : 200;
  const route = template
    ? "/api/admin/templates"
    : "/api/admin/agents/{agent_id}/network-policy";
  const consoleServer = f.trace.spans.find((s) => s.spanID === "console");
  for (const span of [f.root, f.upstream, consoleServer]) {
    setTag(span, "http.request.method", method);
    setTag(span, "http.response.status_code", status);
    span.operationName = `HTTP ${method} ${span === consoleServer ? route : span === f.root ? "/api/admin/{path...}" : "admin-console"}`;
  }
  setTag(consoleServer, "http.route", route);
  Object.assign(f.expected, { method, status, consoleRoute: route });
  f.trace.processes.controller = { serviceName: "agent-controller" };
  const add = (
    id,
    processID,
    parent,
    operationName,
    tags,
    offset,
    duration = 1,
  ) => {
    const span = {
      traceID: f.trace.traceID,
      spanID: id,
      processID,
      operationName,
      startTime: consoleServer.startTime + offset,
      duration,
      references: [
        { traceID: f.trace.traceID, spanID: parent, refType: "CHILD_OF" },
      ],
      tags: fields(tags),
      logs: [],
    };
    f.trace.spans.push(span);
    return span;
  };
  const http = {
    "http.request.method": method,
    "http.response.status_code": status,
  };
  add(
    "controller-client",
    "console",
    "console",
    `HTTP ${method} agent-controller`,
    { "span.kind": "client", ...http },
    10,
    700,
  );
  const controllerRoute = template
    ? "/internal/agent-templates"
    : "/internal/agents/{agent_id}/network-policy";
  const controller = add(
    "controller-server",
    "controller",
    "controller-client",
    `HTTP ${method} ${controllerRoute}`,
    {
      "span.kind": "server",
      ...http,
      "http.route": controllerRoute,
      "rpc.service": "agent-controller",
      "rpc.system.name": "antnest.http-json",
      "rpc.method": `${method} ${controllerRoute}`,
    },
    20,
    650,
  );
  const content = () =>
    ["antnest.request", "antnest.response"].map((event) => ({
      fields: fields({
        event,
        "antnest.payload.json": '{"private":"legal-complete-rpc-content"}',
      }),
    }));
  let owner = controller,
    process = "controller";
  if (!template) {
    controller.logs = content();
    f.trace.processes.egress = { serviceName: "antnest-runtime-egress" };
    add(
      "egress-client",
      "controller",
      controller.spanID,
      "HTTP PUT runtime-egress",
      { "span.kind": "client", ...http },
      30,
      600,
    );
    owner = add(
      "egress-server",
      "egress",
      "egress-client",
      "HTTP PUT /internal/agent-policy-assignments/{agent_id}",
      {
        "span.kind": "server",
        ...http,
        "http.route": "/internal/agent-policy-assignments/{agent_id}",
        "rpc.service": "runtime-egress.control",
        "rpc.method": "assign_policy",
      },
      40,
      550,
    );
    owner.logs = content();
    process = "egress";
  }
  const database = {
    "db.system.name": "postgresql",
    "db.namespace": template ? "antnest_controller" : "antnest_egress",
    "server.address": "postgres",
    "server.port": 5432,
  };
  const sql = (id, operation, parent, offset) =>
    add(
      id,
      process,
      parent,
      operation,
      {
        ...database,
        "span.kind": "client",
        "db.operation.name": operation,
        ...(["BEGIN", "COMMIT"].includes(operation)
          ? {}
          : { "db.query.text": `${operation} $1` }),
      },
      offset,
    );
  if (!template)
    for (let i = 0; i < 4; i++)
      sql(`outside-${i}`, "SELECT", owner.spanID, 60 + i * 10);
  add(
    "transaction",
    process,
    owner.spanID,
    "postgresql transaction",
    {
      ...database,
      "span.kind": "internal",
      "antnest.transaction.outcome": "committed",
    },
    100,
    100,
  );
  sql("begin", "BEGIN", "transaction", 110);
  if (template) sql("catalog-write", "INSERT", "transaction", 120);
  else
    for (let i = 0; i < 3; i++)
      sql(`inside-${i}`, "SELECT", "transaction", 120 + i * 10);
  sql("commit", "COMMIT", "transaction", 180);
  return { ...f, kind, values: { database: "antnest_egress" } };
}
