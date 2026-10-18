import assert from "node:assert/strict";
import test from "node:test";
import {
  foundationConnectionFixture,
  setup,
} from "../lifecycle-closeout/foundation-connection.fixture.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { workspaceDisconnectTraceFixture } from "./private-disconnect-trace.fixture.mjs";
import { inspectProgressCancellation } from "../acp-progress/tool-cancellation.mjs";

const { openWorkspaceConnection } = await import("./private-connection.mjs");
const implementation = await import("./private-disconnect-trace.mjs").catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes(
        "/workspace-closeout/private-disconnect-trace.mjs",
      )
    )
      throw error;
    return {};
  },
);
const reasons = new Set([
  "workspace-prompt-disconnect",
  "workspace-run-unresolved",
  "workspace-tool-cancelled",
  "completed-runtime-tool-http-disconnect",
  "completed-initialize-mcp-read-disconnect",
]);
async function receipt(t, phase) {
  const f = await foundationConnectionFixture(t);
  const client = f.register(
    await openWorkspaceConnection("agent", f.browser, {
      ...f.options,
      preserve() {},
    }),
  );
  const { sessionId } = await client.request("new", setup);
  const pending = client
    .request("prompt", {
      sessionId,
      prompt: [{ type: "text", text: phase }],
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    await f.entered;
    await client.disconnectPending(phase);
    assert(client.isLocalCloseError((await pending).error));
    return client.disconnectReceipts[0];
  } finally {
    f.release();
    await pending;
    await client.closeAndWait();
  }
}
const inspect = (f, original) => {
  assert.equal(
    typeof implementation.inspectWorkspaceDisconnectedTrace,
    "function",
  );
  return implementation.inspectWorkspaceDisconnectedTrace(
    f.trace,
    f.expected,
    ["workspace-disconnect-secret"],
    f.requests,
    { receipt: original },
  );
};

test(
  "Workspace process-start cancellation preserves the original abort before response headers",
  { timeout: 15000 },
  async (t) => {
    const original = await receipt(t, "c4-cancel");
    const f = workspaceDisconnectTraceFixture(original, {
      invocationBeforeHeaders: true,
    });
    const before = structuredClone(f.trace);
    const report = await inspect(f, original);
    assert.equal(report.disconnect_verified, true);
    assert.equal(report.runtime_tool_calls, 1);
    assert(
      report.owned_error_spans.some((item) => item.span_id === f.server.spanID),
    );
    privateACPDiagnosticInventory(
      [f.trace, f.connectionTrace],
      [report],
      reasons,
    );
    assert.deepEqual(f.trace, before);
    // The Progress consumer still requires its own response-start precondition.
    assert.throws(() =>
      inspectProgressCancellation(
        f.trace,
        f.call,
        {
          agentId: f.expected.agentId,
          sessionId: f.expected.sessionId,
          executionId: tag(f.call, "antnest.runtime.execution_id"),
        },
        { kind: "bash", toolName: "bash" },
      ),
    );
  },
);

test(
  "Workspace early invocation abort cannot borrow discovery completion or hide unrelated errors",
  { timeout: 15000 },
  async (t) => {
    const original = await receipt(t, "c4-cancel");
    for (const [name, mutate] of Object.entries({
      invented_client_bytes: (f) =>
        f.set(f.invocationClient, "http.response.body.size", 0),
      invented_server_bytes: (f) =>
        f.set(f.server, "http.response.body.size", 0),
      invented_client_status: (f) =>
        f.set(f.invocationClient, "http.response.status_code", 200),
      invented_server_status: (f) => f.set(f.server, "http.status_code", 200),
      missing_abort: (f) => (f.invocationClient.logs = []),
      missing_unknown: (f) => f.set(f.server, "error.type", undefined),
      wrong_protocol: (f) =>
        f.set(f.server, "antnest.protocol.outcome", "success"),
      hidden_failure: (f) => f.set(f.server, "otel.status_code", "ERROR"),
      invented_completion: (f) =>
        f.server.logs.push(
          f.event(f.server.startTime, "Runtime HTTP request completed", {}),
        ),
      incomplete_operation: (f) => (f.operation.logs = []),
      incomplete_executor: (f) => (f.work.logs = []),
      headerless_discovery: (f) => {
        const discovery = f.trace.spans.find(
          (span) =>
            span !== f.invocationClient &&
            span.operationName === "HTTP POST antnest-runtime" &&
            span.references.some(
              (ref) =>
                ref.refType === "CHILD_OF" && ref.spanID === f.call.spanID,
            ),
        );
        f.set(discovery, "http.response.status_code", undefined);
      },
    })) {
      const f = workspaceDisconnectTraceFixture(original, {
        invocationBeforeHeaders: true,
      });
      mutate(f);
      await assert.rejects(inspect(f, original), undefined, name);
    }
  },
);

for (const phase of ["c4-cancel", "c4-offline"])
  test(
    `${phase} binds its complete original Trace to the joined live connection`,
    { timeout: 15000 },
    async (t) => {
      const original = await receipt(t, phase);
      for (const refresh of [false, true])
        for (const protocolFailed of phase === "c4-cancel"
          ? [false, true]
          : [false]) {
          const f = workspaceDisconnectTraceFixture(original, {
            refresh,
            protocolFailed,
          });
          const before = structuredClone({
            trace: f.trace,
            expected: f.expected,
            original,
          });
          const report = await inspect(f, original);
          assert.equal(report.run_id, "run");
          assert.equal(report.model_requests, phase === "c4-cancel" ? 1 : 2);
          assert.equal(report.runtime_tool_calls, 1);
          assert.equal(report.disconnect_verified, true);
          const inventory = privateACPDiagnosticInventory(
            [f.trace, f.connectionTrace],
            [report],
            reasons,
          );
          assert.equal(
            inventory.raw_error_inventory.length > 1,
            phase === "c4-cancel",
          );
          assert.deepEqual(
            { trace: f.trace, expected: f.expected, original },
            before,
          );
        }
    },
  );

test(
  "Workspace disconnect rejects copied receipts, wrong request ownership and unowned diagnostics",
  { timeout: 15000 },
  async (t) => {
    const original = await receipt(t, "c4-cancel");
    for (const [name, change] of Object.entries({
      missing_receipt: (f) => {
        f.original = undefined;
      },
      copied_receipt: (f) => {
        f.original = structuredClone(original);
      },
      foreign_connection: (f) => {
        f.expected.connectionTraceID = "a".repeat(32);
      },
      foreign_client: (f) => {
        f.expected.clientSpanID = "a".repeat(16);
      },
      foreign_request: (f) => {
        f.expected.requestId = "999";
      },
      foreign_session: (f) => {
        f.expected.sessionId = "other";
      },
      foreign_agent: (f) => {
        f.expected.agentId = "other";
      },
      wrong_phase: (f) => {
        f.expected.phase = "c4-offline";
      },
      wrong_kind: (f) => {
        f.expected.kind = "ordinary";
      },
      wrong_protocol: (f) => {
        f.expected.protocolVersion = 2;
      },
      successful_rpc: (f) => {
        f.expected.outcome = "success";
      },
      assumed_disconnect: (f) => {
        f.expected.closedBeforeResponse = true;
      },
      invented_reply: (f) => {
        f.expected.requestReceipt = {};
      },
      missing_dispatch_event: (f) => {
        f.request.logs = [];
      },
      fabricated_rpc_error: (f) => {
        f.set(f.request, "rpc.response.status_code", -32023);
      },
      fabricated_error_origin: (f) => {
        f.set(f.request, "antnest.error.origin", "execute");
      },
      unrelated_dispatch_error: (f) => {
        f.set(f.request, "error.type", "UnexpectedError");
      },
      duplicate_dispatch_field: (f) => {
        f.request.tags.push({ key: "error.type", value: "Error" });
      },
      foreign_run: (f) => {
        f.expected.runId = "other";
      },
      missing_run_request_id: (f) => {
        f.set(f.run, "antnest.request.id", undefined);
      },
      foreign_run_alias: (f) => {
        f.set(f.run, "run.id", "foreign");
      },
      foreign_session_alias: (f) => {
        f.set(f.run, "session.id", "foreign");
      },
      foreign_agent_alias: (f) => {
        f.set(f.run, "agent.id", "foreign");
      },
      foreign_request_alias: (f) => {
        f.set(f.run, "request.id", "foreign");
      },
      rewritten_run_outcome: (f) => {
        f.set(f.run, "run.tool_effect_state", "settled");
      },
      extra_run_error: (f) => {
        f.run.logs = structuredClone(f.request.logs);
      },
      missing_durable_close: (f) => {
        f.trace.spans = f.trace.spans.filter(
          (span) =>
            !/^WITH finished AS/u.test(tag(span, "db.query.text") ?? ""),
        );
      },
      extra_provider: (f) => {
        f.requests.push({ ...f.requests[0] });
      },
      wrong_provider: (f) => {
        f.requests[0].model_span_id = f.call.spanID;
      },
      model_not_joined: (f) => {
        f.trace.spans.find(
          (span) => span.operationName === "model.complete",
        ).duration = 1000000;
      },
      http_not_joined: (f) => {
        f.trace.spans.find(
          (span) => span.operationName === "HTTP POST model",
        ).duration = 1000000;
      },
      model_overlaps_dispatch: (f) => {
        const model = f.trace.spans.find(
          (span) => span.operationName === "model.complete",
        );
        model.duration = f.call.startTime + 2000 - model.startTime;
      },
      foreign_model_process: (f) => {
        const model = f.trace.spans.find(
          (span) => span.operationName === "model.complete",
        );
        f.trace.processes.foreign = structuredClone(
          f.trace.processes[model.processID],
        );
        model.processID = "foreign";
      },
      unrelated_connection_error: (f) => {
        f.set(f.connectionTrace.spans[0], "error", true);
      },
      failed_persistence: (f) => {
        f.set(
          f.trace.spans.find((span) =>
            /^WITH finished AS/u.test(tag(span, "db.query.text") ?? ""),
          ),
          "error",
          true,
        );
      },
      leaked_payload: (f) => {
        f.set(f.request, "private", "workspace-disconnect-secret");
      },
    }))
      await t.test(name, async () => {
        const f = workspaceDisconnectTraceFixture(original);
        f.original = original;
        change(f);
        const before = structuredClone({
          trace: f.trace,
          expected: f.expected,
        });
        await assert.rejects(() => inspect(f, f.original));
        assert.deepEqual({ trace: f.trace, expected: f.expected }, before);
      });
  },
);

test(
  "offline completion cannot borrow unresolved Run or cancelled Tool allowances",
  { timeout: 15000 },
  async (t) => {
    const original = await receipt(t, "c4-offline");
    for (const [name, change] of Object.entries({
      unresolved_run: (f) => {
        f.set(f.run, "error.type", "run_unresolved");
        f.set(f.run, "run.terminal_class", "unresolved");
      },
      cancelled_tool: (f) => {
        f.set(f.call, "error.type", "McpToolCallError");
      },
      unknown_effect: (f) => {
        f.set(f.tool, "error.type", "outcome_unknown");
      },
      missing_reply: (f) => {
        f.requests.pop();
      },
      foreign_run_alias: (f) => {
        f.set(f.run, "run.id", "foreign");
      },
      foreign_session_alias: (f) => {
        f.set(f.run, "session.id", "foreign");
      },
      failed_executor: (f) => {
        f.set(f.work, "process.exit.code", 1);
      },
      missing_executor_pid: (f) => {
        f.set(f.work, "executor.child.pid", undefined);
      },
      unexpected_exit_signal: (f) => {
        f.set(f.work, "process.exit.signal", "SIGKILL");
      },
      missing_completion_event: (f) => {
        f.work.logs = [];
      },
      foreign_executor_process: (f) => {
        f.trace.processes.foreign = structuredClone(
          f.trace.processes[f.work.processID],
        );
        f.work.processID = "foreign";
      },
      executor_not_joined: (f) => {
        f.work.duration = 1000000;
      },
      extra_executor_child: (f) => {
        const extra = structuredClone(f.work);
        extra.spanID = "unaccounted-work";
        extra.references[0].spanID = f.work.spanID;
        f.trace.spans.push(extra);
      },
    }))
      await t.test(name, async () => {
        const f = workspaceDisconnectTraceFixture(original);
        change(f);
        await assert.rejects(() => inspect(f, original));
      });
  },
);
