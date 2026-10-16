import { requestFixture } from "./trace-fixture.mjs";
import { privateBoundaryFixture } from "./private-boundary.fixture.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";

export function privatePlanRequestFixture({
  version = 1,
  method = "session/load",
  denial,
  catalog,
} = {}) {
  const original = requestFixture(method);
  const inputSessionID = method === "session/new" ? null : "session";
  const operation = `acp.session.${method === "session/load" ? "resume" : method.split("/")[1]}`;
  const application = original.add(
    "application",
    "request",
    operation,
    undefined,
    3,
    {
      "span.kind": "internal",
      "agent.id": "agent",
      "antnest.agent.id": "agent",
      ...(inputSessionID
        ? { "session.id": inputSessionID, "antnest.session.id": inputSessionID }
        : {}),
    },
  );
  original.trace.spans.find((span) => span.spanID === "request").duration = 100;
  const f = privateBoundaryFixture(original, { version });
  Object.assign(f.expected, { inputSessionID, ...(denial ? { denial } : {}) });
  if (method === "session/new" && denial) {
    delete f.expected.sessionId;
    f.request.tags = f.request.tags.filter(
      (field) => field.key !== "antnest.session.id",
    );
  } else if (
    (method === "session/fork" || method === "session/new") &&
    !denial
  ) {
    f.expected.sessionId =
      method === "session/fork" ? "forked-session" : "new-session";
    f.field(f.request, "antnest.session.id", f.expected.sessionId);
  }
  if (denial) {
    f.expected.rejectionReceipt = {
      rpcCode: -32020,
      code: denial,
      retryable: false,
    };
    const code = denial === "access_denied" ? denial : undefined;
    const message = code
      ? "Agent access was denied"
      : "DomainError: unregistered message omitted";
    for (const [key, value] of Object.entries({
      "error.type": "DomainError",
      "antnest.outcome": "rejected",
      "antnest.operation.phase": operation,
      ...(code ? { "error.code": code, "antnest.error.code": code } : {}),
    }))
      f.field(application, key, value);
    application.logs = [
      {
        timestamp: application.startTime,
        fields: Object.entries({
          event: "antnest.error",
          "antnest.error.stage": operation,
          "antnest.operation.phase": operation,
          "antnest.error.type": "DomainError",
          ...(code ? { "antnest.error.code": code } : {}),
          "antnest.error.message": message,
          "antnest.error.cause_types": "[]",
          "antnest.error.causes": JSON.stringify([
            { type: "DomainError", ...(code ? { code } : {}), message },
          ]),
        }).map(([key, value]) => ({ key, value })),
      },
    ];
    for (const [key, value] of Object.entries({
      "error.type": "RequestError",
      "antnest.outcome": "rejected",
      "antnest.operation.phase": "acp.dispatch",
      "error.code": "-32020",
      "antnest.error.code": "-32020",
      "rpc.response.status_code": -32020,
      "antnest.error.origin_trace_id": f.trace.traceID,
      "antnest.error.origin_span_id": application.spanID,
    }))
      f.field(f.request, key, value);
  }
  const read = catalog
    ? addCompletedRead(f.trace, f.request, "http", f.expected.agentId, {
        preserveRequest: true,
        runtimeOutcome: "success",
        clientOutcome: "success",
        ...catalog,
      })
    : undefined;
  return { ...f, application, catalog: read };
}
