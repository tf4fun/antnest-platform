import { readFileSync } from "node:fs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { privateHTTPFixture } from "../acp-commands/trace-fixtures.mjs";
import {
  addRunInformationRead,
  addPostPromptInformationRead,
} from "../observability/runtime-information-run-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { addFailedV1RunResponse } from "../observability/failed-run-response-fixture.mjs";

// Read the actual owning repository query so a hand-written abbreviated CTE
// cannot become the only evidence for durable Run completion.
const source = readFileSync(
  new URL(
    "../../../services/agent-acp-service/src/adapters/postgres/execution-repository.ts",
    import.meta.url,
  ),
  "utf8",
);
export const actualFinishQuery = source.match(
  /public async finish[\s\S]*?`([^`]+)`/u,
)[1];
const owningSource = (name) =>
  readFileSync(
    new URL(
      `../../../services/agent-acp-service/src/adapters/postgres/${name}.ts`,
      import.meta.url,
    ),
    "utf8",
  );
const actualAppendQuery = owningSource("run-event-repository").match(
  /`(INSERT INTO session_messages\([\s\S]*?\$8\))`/u,
)[1];
const actualSessionQuery = owningSource("session-repository").match(
  /`(SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id,[\s\S]*?FROM acp_sessions WHERE id = \$1)`/u,
)[1];
const fields = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));

export function nativeTraceFixture({
  version = 1,
  http = false,
  sameSpan = false,
  failed = false,
} = {}) {
  let f = http
    ? privateHTTPFixture("request", { method: "session/prompt", sameSpan })
    : requestFixture("session/prompt");
  const { trace, expected } = f;
  const add = (...args) => {
    const resources = { ...trace.processes };
    const span = f.add(...args);
    Object.assign(trace.processes, resources);
    return span;
  };
  Object.assign(expected, {
    requestId: http ? "2" : "3",
    kind: failed ? "local-failure" : "native",
    version,
    phase: `v${version}-${http ? "http" : "ws"} ${failed ? "mismatch" : "native"}`,
  });
  const request = trace.spans.find((span) => span.spanID === "request");
  setTag(request, "antnest.request.id", expected.requestId);
  const run = add("run", "request", "agent.run", undefined, 3, {
    "span.kind": "internal",
    "antnest.run.id": "run",
    "antnest.request.id": "request_internal_run_intent",
    "run.terminal_class": failed ? "failed" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "none",
    "antnest.operation.phase": "execute",
    "antnest.outcome": failed ? "failed" : "ok",
    ...(failed
      ? { "error.type": "run_failed", "otel.status_code": "ERROR", error: true }
      : {}),
  });
  for (const [id, name] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    add(id, "run", name, undefined, 5);
    add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  const model = add("model", "run", "model.complete", undefined, 10, {
    "span.kind": "internal",
    "model.purpose": "response",
    "model.name": failed ? "text-model" : "native-model",
    ...(failed
      ? {
          "error.type": "ModelError",
          "error.code": "model_unsupported_content",
          "antnest.error.code": "model_unsupported_content",
          "antnest.operation.phase": "model.complete",
          "antnest.outcome": "error",
          "otel.status_code": "ERROR",
          error: true,
        }
      : { "antnest.outcome": "ok" }),
  });
  let provider, transaction, insert, output, outputRead;
  if (!failed) {
    provider = add("model-http", "model", "HTTP POST model", undefined, 10, {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.status_code": 200,
    });
    transaction = add(
      "transaction",
      "model",
      "postgresql transaction",
      undefined,
      15,
      {
        "span.kind": "internal",
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": "committed",
      },
    );
    insert = add("insert", "transaction", "INSERT", undefined, 15, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": "INSERT",
      "db.query.text": actualAppendQuery,
    });
    output = add("output", "model", "acp.session.output", undefined, 15, {
      "span.kind": "internal",
      "antnest.agent.id": expected.agentId,
      "antnest.session.id": expected.sessionId,
      "antnest.operation.phase": "read",
    });
    outputRead = add("output-read", "output", "SELECT", undefined, 15, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": "SELECT",
      "db.query.text": actualSessionQuery,
    });
  }
  const finish = add("finish", "run", "SELECT", undefined, 20, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.namespace": "antnest_agent_acp",
    "db.operation.name": "SELECT",
    "db.query.text": actualFinishQuery,
  });
  const information = addRunInformationRead(trace, { version });
  const post = version === 1 ? addPostPromptInformationRead(trace) : undefined;
  if (failed) {
    model.logs = [
      {
        timestamp: model.startTime + model.duration - 1,
        fields: fields({
          event: "antnest.error",
          "antnest.error.stage": "model.complete",
          "antnest.operation.phase": "model.complete",
          "antnest.error.type": "ModelError",
          "antnest.error.code": "model_unsupported_content",
          "antnest.error.message":
            "Operation reported model_unsupported_content",
          "antnest.error.cause_types": "[]",
          "antnest.error.causes": JSON.stringify([
            {
              type: "ModelError",
              code: "model_unsupported_content",
              message: "Operation reported model_unsupported_content",
            },
          ]),
        }),
      },
    ];
    if (version === 1) addFailedV1RunResponse(request, { http: sameSpan });
  }
  f.requests = failed
    ? []
    : [
        {
          phase: expected.phase,
          trace_id: trace.traceID,
          model_span_id: provider.spanID,
        },
      ];
  if (!http) f = privateBoundaryFixture(f, { version });
  expected.promptReceipt = {
    requestId: expected.requestId,
    sessionId: expected.sessionId,
    result:
      version === 2
        ? { messageId: "message_test" }
        : failed
          ? null
          : { stopReason: "end_turn" },
    error:
      failed && version === 1
        ? {
            rpcCode: -32022,
            code: "model_unsupported_content",
            retryable: false,
          }
        : null,
    terminals:
      version === 1
        ? []
        : [
            {
              sessionId: expected.sessionId,
              update: {
                sessionUpdate: "state_update",
                state: "idle",
                stopReason: failed ? "_failed" : "end_turn",
              },
            },
          ],
  };
  return {
    ...f,
    add,
    request,
    run,
    model,
    provider,
    transaction,
    insert,
    output,
    outputRead,
    finish,
    information,
    post,
    set: setTag,
  };
}
