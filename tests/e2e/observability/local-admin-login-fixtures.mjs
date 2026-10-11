import { fields } from "./trace-fixtures.mjs";
import { observabilityResolutionFixture } from "./resolve-evidence-fixtures.mjs";

export function sessionOptions(trace) {
  const f = observabilityResolutionFixture("rpc");
  return {
    expected: f.expected,
    collection: { ...f, traces: new Map([[f.expected.traceID, trace]]) },
  };
}

export function fixture(stage = "login") {
  if (stage === "session") {
    const { trace } = observabilityResolutionFixture("rpc");
    const names = {
      "resolve-client": "client",
      "resolve-server": "identity",
      sql: "sql-0",
    };
    for (const span of trace.spans) {
      span.logs ??= [];
      span.spanID = names[span.spanID] ?? span.spanID;
      for (const ref of span.references)
        ref.spanID = names[ref.spanID] ?? ref.spanID;
    }
    const order = ["root", "client", "identity", "decision", "sql-0"];
    trace.spans.sort(
      (a, b) => order.indexOf(a.spanID) - order.indexOf(b.spanID),
    );
    return trace;
  }
  const traceID = "a".repeat(32);
  const route = "/api/session/login";
  const rpc = "/rpc/identity/local-login";
  const span = (id, service, kind, parent, name, tags = {}) => ({
    traceID,
    spanID: id,
    processID: service,
    operationName: name,
    duration: 1,
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
    tags: fields({ "span.kind": kind, ...tags }),
    logs: [],
  });
  const spans = [
    span("root", "edge", "server", null, "HTTP", {
      "http.route": route,
      "http.request.method": "POST",
      "http.response.status_code": 200,
    }),
    span("client", "edge", "client", "root", "HTTP POST", {
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "server.address": "identity-service",
    }),
    span("identity", "identity", "server", "client", "HTTP POST", {
      "http.route": rpc,
      "rpc.method": "local_login",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    }),
  ];
  spans[2].logs = ["antnest.request", "antnest.response"].map((event) => ({
    fields: fields({ event, "antnest.payload.json": "{}" }),
  }));
  spans.push(
    span("tx", "identity", "internal", "identity", "postgresql transaction", {
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    }),
  );
  const operations = [
    "SELECT",
    "BEGIN",
    "SELECT",
    "SELECT",
    "SELECT",
    "INSERT",
    "INSERT",
    "COMMIT",
  ];
  operations.forEach((operation, index) =>
    spans.push(
      span(
        `sql-${index}`,
        "identity",
        "client",
        index > 0 ? "tx" : "identity",
        operation,
        {
          "db.system.name": "postgresql",
          "db.operation.name": operation,
          "db.query.text": `${operation} /* fixture ${index} */`,
        },
      ),
    ),
  );
  return {
    traceID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans,
  };
}
