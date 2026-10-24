import assert from "node:assert/strict";
import test from "node:test";
import {
  agentID,
  deniedSessionID,
  fixture,
  phases,
  revisions,
  runSummary,
  summary,
} from "./foundation-business-fixtures.mjs";

const url = new URL("./foundation-business.mjs", import.meta.url);
const { inspectFoundationBusinessEvidence: inspect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);

const requireAPI = () => assert.equal(typeof inspect, "function");
const saved = (evidence, index = 0) => evidence.audits[0].all[index];
const events = (evidence, index = 0) => saved(evidence, index).events.items;
const held = (evidence) => evidence.private_connections[0].evidence[2];
const fresh = (evidence) => evidence.private_connections[1].evidence[1];
const busy = (evidence) => evidence.private_connections[0].evidence[3];
const raw = (evidence, row, connectionIndex = 0) =>
  evidence.private_connections[connectionIndex].raw_frames.find(
    (frame) => String(frame.id) === row.requestId,
  );
const tool = (evidence, index = 0) =>
  events(evidence, index).filter((event) => event.kind === "tool_call");

test("default Foundation admits two durable Runs and Tools from original v1 receipts without Trace", () => {
  requireAPI();
  const evidence = fixture();
  const original = structuredClone(evidence);
  assert.deepEqual(inspect(evidence), summary);
  assert.deepEqual(
    evidence,
    original,
    "inspection changed original private evidence",
  );
  assert(!Object.hasOwn(summary, "cleanup_completed"));
  assert(!Object.hasOwn(summary, "runtime_tool_calls"));
});

test("Foundation summary contains only safe counts, not original input, identity or diagnostic metadata", () => {
  requireAPI();
  const evidence = fixture();
  const canary = "FOUNDATION_PRIVATE_RECEIPT_CANARY";
  for (const c of evidence.private_connections) {
    c.initialization.initializationResult._meta.private_fixture = canary;
    c.raw_frames[0].result._meta.private_fixture = canary;
  }
  const result = inspect(evidence);
  assert.deepEqual(result, summary);
  assert(!JSON.stringify(result).includes(canary));
  assert(!JSON.stringify(result).includes(agentID));
  assert(!JSON.stringify(result).includes(phases[0]));
});

for (const [name, mutate] of [
  ["missing connection", (e) => e.private_connections.pop()],
  [
    "extra connection",
    (e) =>
      e.private_connections.push(structuredClone(e.private_connections[0])),
  ],
  [
    "wrong protocol",
    (e) => {
      e.private_connections[1].version = 2;
    },
  ],
  [
    "foreign Agent",
    (e) => {
      e.private_connections[1].agentId = "other-agent";
    },
  ],
  [
    "missing actual SDK request",
    (e) => e.private_connections[0].requests.pop(),
  ],
  [
    "duplicate original request",
    (e) => e.private_connections[0].evidence.push(structuredClone(held(e))),
  ],
  [
    "missing original initialization response",
    (e) => e.private_connections[0].raw_frames.shift(),
  ],
  [
    "missing successful raw response",
    (e) => {
      e.private_connections[0].raw_frames =
        e.private_connections[0].raw_frames.filter(
          (frame) => String(frame.id) !== held(e).requestId,
        );
    },
  ],
  [
    "duplicate successful raw response",
    (e) =>
      e.private_connections[0].raw_frames.push(
        structuredClone(raw(e, held(e))),
      ),
  ],
  [
    "raw prompt result disagrees with original receipt",
    (e) => {
      raw(e, held(e)).result.stopReason = "max_tokens";
    },
  ],
  [
    "failed original prompt",
    (e) => {
      held(e).outcome = "failed";
    },
  ],
  [
    "wrong original prompt input",
    (e) => {
      held(e).requestParams.prompt[0].text = "different input";
    },
  ],
  [
    "missing original prompt receipt",
    (e) => {
      delete held(e).requestReceipt;
    },
  ],
  [
    "receipt input disagrees with dispatched input",
    (e) => {
      held(e).requestReceipt.params.prompt[0].text = "changed receipt";
    },
  ],
  [
    "receipt request ID disagrees with actual SDK ID",
    (e) => {
      held(e).requestReceipt.requestId = "different-id";
    },
  ],
  [
    "foreign original Session",
    (e) => {
      held(e).inputSessionID = deniedSessionID;
    },
  ],
  [
    "wrong phase",
    (e) => {
      fresh(e).phase = phases[0];
    },
  ],
  [
    "wrong post-rebuild Tool",
    (e) => {
      fresh(e).toolName = "bash";
    },
  ],
  [
    "load changes original Session",
    (e) => {
      e.private_connections[1].evidence[0].requestParams.sessionId =
        deniedSessionID;
    },
  ],
  [
    "missing Run list page",
    (e) => {
      delete e.audits[0].page;
    },
  ],
  ["missing final denied Session inventory", (e) => e.audits.pop()],
  [
    "truncated Run list",
    (e) => {
      e.audits[0].page.next_cursor = "another-page";
    },
  ],
  [
    "truncated denied Session list",
    (e) => {
      e.audits[1].page.next_cursor = "another-page";
    },
  ],
  ["missing listed Run", (e) => e.audits[0].page.items.pop()],
  [
    "extra listed Run",
    (e) =>
      e.audits[0].page.items.push({
        ...e.audits[0].page.items[0],
        run_id: "extra-run",
      }),
  ],
  ["missing Run detail", (e) => e.audits[0].all.pop()],
  ["extra Run detail", (e) => e.audits[0].all.push(structuredClone(saved(e)))],
  [
    "duplicate listed Run identity",
    (e) => {
      e.audits[0].page.items[1].run_id = e.audits[0].page.items[0].run_id;
    },
  ],
  [
    "Run detail changed listed identity",
    (e) => {
      saved(e).run.run_id = "unlisted-run";
    },
  ],
  [
    "foreign durable Agent",
    (e) => {
      saved(e).run.agent_id = "other-agent";
    },
  ],
  [
    "foreign durable Principal",
    (e) => {
      saved(e).run.principal_id = "other-user";
    },
  ],
  [
    "foreign durable Session",
    (e) => {
      saved(e).run.session_id = deniedSessionID;
    },
  ],
  [
    "changed durable input",
    (e) => {
      saved(e).run.input[0].text = "different input";
    },
  ],
  [
    "two Runs bound to one original prompt",
    (e) => {
      saved(e, 1).run.input = structuredClone(saved(e).run.input);
    },
  ],
  [
    "Run still running",
    (e) => {
      saved(e).run.state = "running";
    },
  ],
  [
    "failed durable terminal",
    (e) => {
      saved(e).run.terminal_class = "failed";
    },
  ],
  [
    "unsettled executor",
    (e) => {
      saved(e).run.executor_state = "unknown";
    },
  ],
  [
    "unknown Tool effects",
    (e) => {
      saved(e).run.tool_effect_state = "unknown";
    },
  ],
  [
    "completed Tool has no settled effect evidence",
    (e) => {
      saved(e).run.tool_effect_state = "none";
    },
  ],
  [
    "unknown effect source",
    (e) => {
      saved(e).run.unknown_effect_source = "runtime_mcp";
    },
  ],
  [
    "wrong durable stop reason",
    (e) => {
      saved(e).run.stop_reason = "refusal";
    },
  ],
  [
    "durable error class",
    (e) => {
      saved(e).run.error_class = "persistence_interrupted";
    },
  ],
  [
    "held Run changes its original revision",
    (e) => {
      saved(e).run.execution_snapshot.executionRevision = revisions[1];
    },
  ],
  [
    "rebuilt Run reuses old revision",
    (e) => {
      saved(e, 1).run.execution_snapshot.executionRevision = revisions[0];
    },
  ],
  [
    "truncated persisted events",
    (e) => {
      saved(e).events.next_cursor = "more-events";
    },
  ],
  [
    "wrong persisted event stream",
    (e) => {
      saved(e).events.stream = "permissions";
    },
  ],
  [
    "missing persisted user input",
    (e) => {
      saved(e).events.items = events(e).filter(
        (event) => event.kind !== "user_message",
      );
    },
  ],
  [
    "persisted user input differs from Run input",
    (e) => {
      events(e)[0].payload.content[0].text = "changed stored user";
    },
  ],
  [
    "duplicate event identity",
    (e) => {
      events(e)[1].id = events(e)[0].id;
    },
  ],
  [
    "repeated Session sequence across Runs",
    (e) => {
      events(e, 1)[0].sequence = events(e)[0].sequence;
    },
  ],
  [
    "reordered persisted events",
    (e) => {
      events(e)[2].sequence = events(e)[1].sequence;
    },
  ],
  [
    "persisted kind and payload disagree",
    (e) => {
      tool(e)[0].payload.kind = "usage";
    },
  ],
  [
    "missing persisted Tool start",
    (e) => {
      saved(e).events.items = events(e).filter(
        (event) => event.id !== phases[0] + "-start",
      );
    },
  ],
  [
    "missing persisted Tool completion",
    (e) => {
      saved(e).events.items = events(e).filter(
        (event) => event.id !== phases[0] + "-finish",
      );
    },
  ],
  [
    "extra persisted Tool dispatch",
    (e) => {
      events(e)
        .find((event) => event.id === phases[0] + "-dispatch")
        .payload.toolCalls.push({
          id: "extra-tool",
          name: "bash",
          arguments: {},
        });
    },
  ],
  [
    "extra persisted Tool lifecycle",
    (e) => {
      for (const [index, original] of tool(e).entries()) {
        const event = structuredClone(original);
        event.id = "extra-tool-event-" + index;
        event.sequence = 20 + index;
        event.payload.toolCallId = "extra-tool";
        events(e).push(event);
      }
    },
  ],
  [
    "persisted Tool lifecycle borrowed from the other Run",
    (e) => {
      const source = tool(e);
      const target = tool(e, 1);
      for (const [index, event] of target.entries())
        event.payload = structuredClone(source[index].payload);
    },
  ],
  [
    "mismatched model dispatch Tool identity",
    (e) => {
      events(e).find(
        (event) => event.id === phases[0] + "-dispatch",
      ).payload.toolCalls[0].id = "other-tool";
    },
  ],
  [
    "Tool finishes under another identity",
    (e) => {
      tool(e)[1].payload.toolCallId = "other-tool";
    },
  ],
  [
    "Tool did not complete",
    (e) => {
      tool(e)[1].payload.status = "failed";
    },
  ],
  [
    "Tool start is not initial",
    (e) => {
      tool(e)[0].payload.initial = false;
    },
  ],
  [
    "wrong persisted Runtime Tool name",
    (e) => {
      tool(e, 1)[0].payload.modelName = "write";
    },
  ],
  [
    "persisted Tool arguments differ from SDK input",
    (e) => {
      tool(e)[0].payload.arguments.command = "different command";
    },
  ],
  [
    "persisted Tool result differs from SDK result",
    (e) => {
      tool(e)[1].payload.content[0].text = "different Tool result";
    },
  ],
  [
    "missing persisted reply",
    (e) => {
      saved(e).events.items = events(e).filter(
        (event) => event.id !== phases[0] + "-reply",
      );
    },
  ],
  [
    "persisted reply differs from actual SDK reply",
    (e) => {
      events(e).at(-1).payload.content[0].text = "different reply";
    },
  ],
  [
    "usage differs from complete stored events",
    (e) => {
      saved(e).run.usage_measurements.pop();
    },
  ],
  [
    "missing live Tool notification",
    (e) => {
      e.private_connections[0].updates =
        e.private_connections[0].updates.filter(
          (frame) => frame.update.sessionUpdate !== "tool_call",
        );
    },
  ],
  [
    "extra live Tool notification",
    (e) => {
      const c = e.private_connections[0];
      c.updates.push(
        structuredClone(
          c.updates.find((frame) => frame.update.sessionUpdate === "tool_call"),
        ),
      );
    },
  ],
  [
    "foreign Session notification",
    (e) => {
      e.private_connections[0].updates[0].sessionId = deniedSessionID;
    },
  ],
  ["missing model request", (e) => e.provider_requests.pop()],
  [
    "extra model request",
    (e) => e.provider_requests.push(structuredClone(e.provider_requests[0])),
  ],
  [
    "wrong model phase",
    (e) => {
      e.provider_requests[0].phase = "c3-denied";
    },
  ],
  [
    "reordered model stages",
    (e) => {
      e.provider_requests[0].stage = "reply";
      e.provider_requests[1].stage = "tool";
    },
  ],
  [
    "busy request became successful",
    (e) => {
      busy(e).outcome = "succeeded";
    },
  ],
  [
    "busy receipt uses old numeric fallback",
    (e) => {
      raw(e, busy(e)).error.code = -32020;
    },
  ],
  [
    "busy receipt leaks a noncanonical message",
    (e) => {
      raw(e, busy(e)).error.message = "synthetic private dependency details";
    },
  ],
  [
    "busy receipt lost retryability",
    (e) => {
      raw(e, busy(e)).error.data.retryable = false;
    },
  ],
  [
    "busy receipt has incorrect delay",
    (e) => {
      raw(e, busy(e)).error.data.retry_after_ms = 1;
    },
  ],
  [
    "missing busy raw rejection",
    (e) => {
      e.private_connections[0].raw_frames =
        e.private_connections[0].raw_frames.filter(
          (frame) => String(frame.id) !== busy(e).requestId,
        );
    },
  ],
  [
    "busy receipt disagrees with raw error",
    (e) => {
      busy(e).rejectionReceipt.retryable = false;
    },
  ],
  ["missing busy checkpoint", (e) => e.busy_checks.pop()],
  [
    "busy checkpoint bound to another request",
    (e) => {
      e.busy_checks[0].request_id = held(e).requestId;
    },
  ],
  [
    "truncated busy checkpoint page",
    (e) => {
      e.busy_checks[0].after.page.next_cursor = "more-runs";
    },
  ],
  [
    "busy denial admitted a new Run",
    (e) => {
      e.busy_checks[0].after.page.items.push({
        ...runSummary(saved(e).run),
        session_id: deniedSessionID,
        run_id: "denied-run",
      });
    },
  ],
  [
    "busy Session already had an unexpected Run",
    (e) => {
      const r = {
        ...runSummary(saved(e).run),
        session_id: deniedSessionID,
        run_id: "denied-run",
      };
      e.busy_checks[0].before.page.items.push(r);
      e.busy_checks[0].after.page.items.push(structuredClone(r));
    },
  ],
  [
    "busy denial reached the model",
    (e) => {
      e.busy_checks[1].after.model_requests.push({
        phase: "c3-denied",
        stage: "tool",
        received_at_ms: 1500,
      });
    },
  ],
  [
    "busy before/after model receipts both include unexpected execution",
    (e) => {
      const r = { phase: "c3-denied", stage: "tool", received_at_ms: 1500 };
      e.busy_checks[0].before.model_requests.push(r);
      e.busy_checks[0].after.model_requests.push(structuredClone(r));
    },
  ],
  [
    "busy denial emitted execution notifications",
    (e) => {
      e.busy_checks[0].after.updates.push({
        sessionId: deniedSessionID,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "denied-tool",
          title: "bash",
          status: "in_progress",
        },
      });
    },
  ],
  [
    "final denied Session inventory contains execution",
    (e) => {
      const run = {
        ...structuredClone(saved(e).run),
        run_id: "late-denied-run",
        session_id: deniedSessionID,
      };
      e.audits[1].page.items.push(runSummary(run));
      e.audits[1].all.push({ run, events: structuredClone(saved(e).events) });
    },
  ],
]) {
  test("Foundation business rejects " + name + " without Trace", () => {
    requireAPI();
    const evidence = fixture();
    mutate(evidence);
    assert.throws(() => inspect(evidence));
  });
}

function modelAttemptExecutionCopies(evidence) {
  const seen = new WeakSet();
  const executions = [];
  const visit = (value) => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value.execution_snapshot && !value.execution_snapshot.executionSpec) {
      const snapshot = value.execution_snapshot;
      snapshot.executionSpec = {
        systemPrompt: "Complete the original Foundation business prompt.",
        contextPolicyVersion: "context-v1",
        maxModelRequests: 4,
        model: {
          model: "foundation-model",
          contextWindow: 8192,
          maxOutputTokens: 1024,
          supportsImages: false,
        },
        configuration: {
          modelProfileId: snapshot.modelProfileId,
          authorizationRevision: 1,
          authorization: { mode: "auto", toolRules: [] },
        },
      };
    }
    if (value.run && Array.isArray(value.events?.items)) executions.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(evidence);
  return executions;
}

function withModelAttempts(evidence) {
  const histories = new WeakSet();
  for (const { run, events } of modelAttemptExecutionCopies(evidence)) {
    const rows = events.items;
    if (histories.has(rows)) continue;
    histories.add(rows);
    const snapshot = run.execution_snapshot;
    const expanded = [];
    let ordinal = 0;
    for (const event of rows) {
      event.sequence *= 3;
      if (event.kind === "usage") {
        ordinal += 1;
        const startedAt = new Date(
          Date.parse(run.created_at) + ordinal * 10,
        ).toISOString();
        const finishedAt = new Date(Date.parse(startedAt) + 1).toISOString();
        const fact = (phase, sequence, payload, created_at) => ({
          id: run.run_id + "-model-attempt-" + ordinal + "-" + phase,
          sequence,
          kind: "model_attempt",
          visible: false,
          payload: { kind: "model_attempt", phase, ordinal, ...payload },
          created_at,
        });
        expanded.push(
          fact(
            "start",
            event.sequence - 2,
            {
              modelProfileId: snapshot.modelProfileId,
              providerConnectionId: snapshot.providerConnectionId,
              model: snapshot.executionSpec.model.model,
              purpose: "foreground",
              startedAt,
            },
            startedAt,
          ),
          fact(
            "finish",
            event.sequence - 1,
            {
              outcome: "completed",
              reason: "completed",
              durationMs: 1,
              finishedAt,
              contextSize: snapshot.executionSpec.model.contextWindow,
              usage: structuredClone(event.payload.measurement),
              outputStarted: true,
            },
            finishedAt,
          ),
        );
      }
      expanded.push(event);
    }
    assert.equal(
      ordinal,
      2,
      "fixture must retain its two original usage facts",
    );
    rows.splice(0, rows.length, ...expanded);
  }
  return evidence;
}

test("Foundation admits complete hidden model attempts without changing the original wire or summary", () => {
  requireAPI();
  const evidence = fixture();
  const wire = structuredClone(evidence.private_connections);
  withModelAttempts(evidence);
  for (const execution of modelAttemptExecutionCopies(evidence))
    assert.equal(
      execution.events.items.filter((event) => event.kind === "model_attempt")
        .length,
      4,
    );
  const original = structuredClone(evidence);
  assert.deepEqual(inspect(evidence), summary);
  assert.deepEqual(evidence, original);
  assert.deepEqual(evidence.private_connections, wire);
});

for (const [name, mutate] of [
  [
    "visible audit",
    (rows) => {
      rows[0].visible = true;
    },
  ],
  [
    "missing finish",
    (rows, execution) => {
      execution.events.items.splice(execution.events.items.indexOf(rows[1]), 1);
    },
  ],
  [
    "foreign model profile",
    (rows) => {
      rows[0].payload.modelProfileId = "foreign-model-profile";
    },
  ],
  [
    "foreign provider",
    (rows) => {
      rows[0].payload.providerConnectionId = "foreign-provider";
    },
  ],
  [
    "foreign model",
    (rows) => {
      rows[0].payload.model = "foreign-model";
    },
  ],
  [
    "changed usage",
    (rows) => {
      rows[1].payload.usage.outputTokens += 1;
    },
  ],
  [
    "changed context size",
    (rows) => {
      rows[1].payload.contextSize += 1;
    },
  ],
])
  test("Foundation rejects model attempt " + name + " without Trace", () => {
    requireAPI();
    const evidence = withModelAttempts(fixture());
    const selectedRunId = saved(evidence).run.run_id;
    const changed = new WeakSet();
    for (const execution of modelAttemptExecutionCopies(evidence)) {
      const rows = execution.events.items;
      if (execution.run.run_id !== selectedRunId || changed.has(rows)) continue;
      changed.add(rows);
      mutate(
        rows.filter((event) => event.kind === "model_attempt"),
        execution,
      );
    }
    assert.throws(
      () => inspect(evidence),
      "invalid hidden model audit must reject business evidence",
    );
  });
