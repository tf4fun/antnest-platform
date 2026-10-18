import { managedRequestFixture } from "./request-trace.fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";
import { addRunInformationRead } from "../observability/runtime-information-run-fixtures.mjs";
import { set, eventField } from "../acp-progress/trace.fixture.mjs";

const fields = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));
const event = (timestamp, name, values) => ({
  timestamp,
  fields: fields({ event: name, ...values }),
});
export function privateManagedFixture(version = 1, phase = "managed-fresh") {
  const f = privateBoundaryFixture(managedRequestFixture(phase), { version });
  addRunInformationRead(f.trace, { version });
  f.expected.snapshot.runtime_execution_id = "execution_test";
  for (const span of f.trace.spans)
    if (span.operationName === "model.complete")
      set(span, "antnest.runtime.execution_id", "execution_test");
  const fail = f.trace.spans.find((span) => span.spanID === "call");
  if (phase === "managed-exercise") {
    const by = (id) => f.trace.spans.find((span) => span.spanID === id);
    const server = by("server"),
      operation = by("server-operation"),
      tool = by("tool"),
      work = by("stdio");
    for (const [key, value] of Object.entries({
      "antnest.mcp.tool_result.outcome": "tool_error",
      "antnest.outcome": "tool_error",
      "error.type": "mcp_tool_error",
      "otel.status_code": "ERROR",
    }))
      set(fail, key, value);
    eventField(fail.logs[2], "outcome", "tool_error");
    set(server, "antnest.protocol.outcome", "error");
    set(operation, "mcp.operation.outcome", "error");
    set(operation, "antnest.operation.outcome", "error");
    for (const span of [server, operation]) {
      set(span, "error.type", "managed_tool_error");
      set(span, "otel.status_code", "ERROR");
    }
    eventField(operation.logs[0], "mcp.operation.outcome", "error");
    eventField(operation.logs[0], "error.type", "managed_tool_error");
    work.startTime = tool.startTime + 1;
    work.duration = tool.duration - 3;
    set(tool, "mcp.tool.outcome", "error");
    set(work, "antnest.protocol.outcome", "error");
    tool.logs = [
      event(tool.startTime + tool.duration - 1, "Managed MCP tool finished", {
        level: "INFO",
        "mcp.server.tool": "mcp__alpha__fail",
        outcome: "error",
        "error.type": "managed_tool_error",
      }),
    ];
    operation.logs.unshift(
      event(tool.startTime + tool.duration, "antnest.error", {
        "antnest.error.stage": "mcp.dispatch",
        "antnest.error.type": "managed_tool_error",
        "antnest.error.code": "managed_tool_error",
        "antnest.error.message":
          "Tool returned an unsuccessful protocol result",
      }),
    );
    work.logs = [
      event(work.startTime + work.duration - 1, "antnest.error", {
        "antnest.error.stage": "mcp.stdio",
        "antnest.error.type": "managed_tool_error",
        "antnest.error.code": "managed_tool_error",
        "antnest.error.message": "Managed tool returned isError",
      }),
    ];
  }
  return f;
}

export function privateBusyFixture(version = 1) {
  const f = privatePlanRequestFixture({
    version,
    method: "session/prompt",
    denial: "agent_busy",
  });
  Object.assign(f.expected, {
    kind: "request",
    rejection: "agent_busy",
    label: "busy-step-1",
  });
  for (const key of ["error.code", "antnest.error.code"])
    set(f.application, key, "agent_busy");
  eventField(f.application.logs[0], "antnest.error.code", "agent_busy");
  eventField(
    f.application.logs[0],
    "antnest.error.message",
    "Operation reported agent_busy",
  );
  eventField(
    f.application.logs[0],
    "antnest.error.causes",
    JSON.stringify([
      {
        type: "DomainError",
        code: "agent_busy",
        message: "Operation reported agent_busy",
      },
    ]),
  );
  return f;
}
