import assert from "node:assert/strict";
import test from "node:test";
import { fixture, runSummary, summary } from "./business-fixtures.mjs";

const url = new URL("./business-evidence.mjs", import.meta.url);
const { inspectRpcLossBusinessEvidence: inspect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);
const requireAPI = () => assert.equal(typeof inspect, "function");
const scenario = (e, index = 0) => e.scenarios[index];
const saved = (e, index = 0, step = 0) => scenario(e, index).runs[step];
const tools = (e, index = 0, step = 0) =>
  saved(e, index, step).events.items.filter(
    (event) => event.kind === "tool_call",
  );
const clone = (value) => structuredClone(value);

test("v2 response loss accepts an original delivered digest proof and rejects changed recovery scope or version", () => {
  const evidence = fixture();
  for (const selected of evidence.scenarios.filter((s) => s.kind === "apply")) {
    const fault = selected.fault;
    fault.held.method = "apply-execution-delta";
    fault.held.base_revision = fault.held.revision - 1;
    fault.records[0] = { ...fault.held, delivery: "dropped" };
    fault.records[1] = {
      receipt_id: fault.records[1].receipt_id,
      method: "get-execution-digest",
      organization_id: fault.held.organization_id,
      schema_version: 2,
      revision: fault.held.applied_revision,
      applied_revision: fault.held.applied_revision,
      digest: "a".repeat(64),
      recovery_of: fault.held.receipt_id,
      request_hash: "b".repeat(64),
      response_hash: "c".repeat(64),
      status: 200,
      delivery: "delivered",
    };
  }
  assert.deepEqual(inspect(evidence), summary);
  for (const patch of [
    { organization_id: "foreign" },
    { revision: 1 },
    { applied_revision: 1 },
    { schema_version: 1 },
    { digest: null },
    { recovery_of: "other" },
    { delivery: "expired" },
  ]) {
    const changed = clone(evidence);
    Object.assign(changed.scenarios[0].fault.records[1], patch);
    assert.throws(() => inspect(changed));
  }
});

function executionCopies(evidence) {
  const seen = new WeakSet();
  const executions = [];
  const visit = (value) => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value.run && Array.isArray(value.events?.items)) executions.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(evidence);
  return executions;
}

function addModelAttempts(evidence) {
  const histories = new WeakSet();
  for (const execution of executionCopies(evidence)) {
    const rows = execution.events.items;
    if (histories.has(rows)) continue;
    histories.add(rows);
    const { run } = execution;
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
          context_excluded: true,
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
              usage: clone(event.payload.measurement),
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

// Keep original checkpoint copies consistent so a changed Run revision must
// be rejected by its Runtime binding, not an unrelated replay mismatch.
function replaceExecutionRevision(evidence, index, step, revision) {
  const selected = scenario(evidence, index);
  const runId = selected.runs[step].run.run_id;
  for (const execution of [
    ...selected.runs,
    selected.replay.before.execution,
    selected.replay.after.execution,
    selected.denial?.before.execution,
    selected.denial?.after.execution,
  ].filter(Boolean)) {
    if (execution.run.run_id === runId)
      execution.run.execution_snapshot.executionRevision = revision;
  }
}

test("RPC loss admits the original four cases and eight durable Tools without any Trace", () => {
  requireAPI();
  const original = fixture(),
    before = clone(original);
  const result = inspect(original);
  assert.deepEqual(result, summary);
  assert.deepEqual(original, before);
  const text = JSON.stringify(result);
  for (const value of [
    original.agentId,
    original.principalId,
    original.organizationId,
    "RPC_PRIVATE_AUDIT_CANARY",
    "request_hash",
    "command",
    "trace",
  ])
    assert(
      !text.includes(value),
      "safe count summary leaked private or diagnostic evidence",
    );
  assert(!Object.hasOwn(result, "deleted"));
  assert(!Object.hasOwn(result, "cleanup_completed"));
});

test("RPC loss accepts only the actual public Admin snapshot shape and separately captured Runtime bindings", () => {
  requireAPI();
  const original = fixture();
  for (const selected of original.scenarios) {
    for (const execution of [
      ...selected.runs,
      selected.replay.before.execution,
      selected.replay.after.execution,
      selected.denial?.before.execution,
      selected.denial?.after.execution,
    ].filter(Boolean)) {
      const snapshot = execution.run.execution_snapshot;
      // services/admin-console/internal/server/execution_snapshot_projection.go
      // deliberately omits organization/access/client-MCP/Runtime authority.
      assert.deepEqual(
        Object.keys(snapshot).sort(),
        [
          "providerConnectionId",
          "modelProfileId",
          "configurationRevision",
          "agentSpecRevision",
          "executionRevision",
          "deadlineAt",
          "agentExecutionSpecDigest",
          "executionSpec",
        ].sort(),
      );
      assert.deepEqual(
        Object.keys(snapshot.executionSpec).sort(),
        [
          "systemPrompt",
          "contextPolicyVersion",
          "maxModelRequests",
          "model",
          "configuration",
        ].sort(),
      );
      assert(!Object.hasOwn(snapshot.executionSpec.model, "baseUrl"));
    }
    if (selected.kind === "settle") {
      assert.equal(
        selected.runs[0].run.execution_snapshot.executionRevision,
        selected.source.execution_revision,
      );
      assert.equal(
        selected.runs[1].run.execution_snapshot.executionRevision,
        selected.replacement.execution_revision,
      );
      // These are captureRuntime() receipts, not private fields invented on
      // the Admin Run. They do not claim a Run exposed an endpoint or process ID.
      assert.deepEqual(
        Object.keys(selected.source).sort(),
        [
          "agent_id",
          "runtime_revision",
          "runtime_execution_id",
          "mcp_endpoint",
          "execution_revision",
          "template_id",
          "template_revision",
        ].sort(),
      );
    }
  }
  assert.deepEqual(inspect(original), summary);
});

test("RPC Tool counting permits actual progress and Session-local sequence gaps", () => {
  requireAPI();
  const original = fixture();
  for (const s of original.scenarios)
    for (const execution of s.runs) {
      const start = execution.events.items.find(
        (event) => event.kind === "tool_call",
      );
      const progress = {
        ...clone(start),
        id: start.id + "-progress",
        sequence: start.sequence + 1,
        payload: {
          kind: "tool_call",
          initial: false,
          toolCallId: start.payload.toolCallId,
          status: "in_progress",
          content: [{ type: "text", text: "running" }],
        },
      };
      execution.events.items.splice(
        execution.events.items.indexOf(start) + 1,
        0,
        progress,
      );
      const progressUpdate = {
        sessionId: s.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: start.payload.toolCallId,
          status: "in_progress",
          content: [
            { type: "content", content: { type: "text", text: "running" } },
          ],
        },
      };
      const appendProgress = (rows) => {
        const index = rows.findIndex(
          ({ update }) =>
            update.toolCallId === start.payload.toolCallId &&
            update.status === "in_progress",
        );
        if (index >= 0) rows.splice(index + 1, 0, clone(progressUpdate));
      };
      for (const c of original.connections.filter(
        (c) => c.version === s.version && c.kind === s.kind,
      ))
        appendProgress(c.updates);
      if (execution.run.input[0].text.endsWith("-write")) {
        for (const check of [
          s.replay.before,
          s.replay.after,
          s.denial?.before,
          s.denial?.after,
        ].filter(Boolean)) {
          check.execution.events = clone(execution.events);
          if (check.updates) appendProgress(check.updates);
        }
      }
    }
  assert.deepEqual(inspect(original), summary);
});

const groups = [
  [
    "missing or extra scenarios",
    [(e) => e.scenarios.pop(), (e) => e.scenarios.push(clone(e.scenarios[0]))],
  ],
  [
    "incomplete eight-Run evidence",
    [
      (e) => scenario(e).auditPage.items.pop(),
      (e) => scenario(e).runs.pop(),
      (e) => {
        scenario(e).auditPage.next_cursor = "more-runs";
      },
      (e) => {
        saved(e, 0, 1).events.next_cursor = "more-events";
      },
    ],
  ],
  [
    "duplicate or unlisted durable Runs",
    [
      (e) => scenario(e).runs.push(clone(saved(e))),
      (e) => {
        saved(e, 0, 1).run.run_id = "unlisted-run";
      },
      (e) => {
        scenario(e).auditPage.items[0].run_id =
          scenario(e).auditPage.items[1].run_id;
      },
    ],
  ],
  [
    "foreign Run ownership or Session",
    [
      (e) => {
        e.principalId = "foreign-owner";
      },
      (e) => {
        saved(e).run.session_id = scenario(e, 1).sessionId;
      },
      (e) => {
        saved(e).run.agent_id = "foreign-agent";
      },
      (e) => {
        e.organizationId = "foreign-organization";
      },
    ],
  ],
  [
    "wrong durable terminal or input",
    [
      (e) => {
        saved(e, 0, 1).run.state = "running";
      },
      (e) => {
        saved(e, 0, 1).run.tool_effect_state = "unknown";
      },
      (e) => {
        saved(e, 0, 1).run.input[0].text = "foreign prompt";
      },
    ],
  ],
  [
    "missing Tool lifecycle or repeated completion",
    [
      (e) => {
        saved(e, 0, 1).events.items = saved(e, 0, 1).events.items.filter(
          (event) => event.id !== tools(e, 0, 1)[0].id,
        );
      },
      (e) => {
        saved(e, 0, 1).events.items = saved(e, 0, 1).events.items.filter(
          (event) => event.id !== tools(e, 0, 1).at(-1).id,
        );
      },
      (e) => {
        const extra = clone(tools(e, 0, 1).at(-1));
        extra.id += "-duplicate";
        extra.sequence = saved(e, 0, 1).events.items.at(-1).sequence + 1;
        saved(e, 0, 1).events.items.push(extra);
      },
    ],
  ],
  [
    "extra unique Tool work",
    [
      (e) => {
        const execution = saved(e, 0, 1);
        let sequence = execution.events.items.at(-1).sequence;
        for (const original of tools(e, 0, 1)) {
          const extra = clone(original);
          extra.id += "-extra";
          extra.sequence = ++sequence;
          extra.payload.toolCallId += "-extra";
          execution.events.items.push(extra);
        }
      },
      (e) => {
        tools(e, 0, 1).at(-1).payload.toolCallId = "foreign-tool";
      },
    ],
  ],
  [
    "missing changed or duplicated model requests",
    [
      (e) => e.model.requests.pop(),
      (e) => e.model.requests.push(clone(e.model.requests[0])),
      (e) => {
        e.model.requests[0].phase = "v1-settle-denied";
      },
      (e) => e.model.errors.push("invalid_model_request"),
    ],
  ],
  [
    "public Run revision inconsistent with its captured source or replacement",
    [1, 3].flatMap((index) => [
      (e) => replaceExecutionRevision(e, index, 0, "foreign-write-revision"),
      (e) => {
        scenario(e, index).source.execution_revision =
          "foreign-source-revision";
      },
      (e) => replaceExecutionRevision(e, index, 1, "foreign-read-revision"),
      (e) => {
        scenario(e, index).replacement.execution_revision =
          "foreign-replacement-revision";
      },
      (e) =>
        replaceExecutionRevision(
          e,
          index,
          1,
          scenario(e, index).source.execution_revision,
        ),
      (e) => {
        const old = scenario(e, index).source.execution_revision;
        scenario(e, index).replacement.execution_revision = old;
        replaceExecutionRevision(e, index, 1, old);
      },
    ]),
  ],
  [
    "missing or foreign captured Runtime receipts",
    [1, 3].flatMap((index) => [
      (e) => {
        delete scenario(e, index).source;
      },
      (e) => {
        delete scenario(e, index).replacement;
      },
      (e) => {
        scenario(e, index).source.agent_id = "foreign-agent";
      },
      (e) => {
        scenario(e, index).replacement.agent_id = "foreign-agent";
      },
    ]),
  ],
  [
    "replacement Runtime retains its old binding or changes its template",
    [1, 3].flatMap((index) => [
      (e) => {
        scenario(e, index).replacement.runtime_revision = scenario(
          e,
          index,
        ).source.runtime_revision;
      },
      (e) => {
        scenario(e, index).replacement.runtime_execution_id = scenario(
          e,
          index,
        ).source.runtime_execution_id;
      },
      (e) => {
        scenario(e, index).source.runtime_revision = "";
      },
      (e) => {
        scenario(e, index).replacement.runtime_execution_id = "";
      },
      (e) => {
        scenario(e, index).replacement.template_id = "foreign-template";
      },
      (e) => {
        scenario(e, index).replacement.template_revision =
          scenario(e, index).source.template_revision + 1;
      },
    ]),
  ],
  [
    "lost or changed proxy acknowledgement",
    [
      (e) => scenario(e).fault.records.pop(),
      (e) => {
        scenario(e).fault.records[1].delivery = "expired";
      },
      (e) => {
        scenario(e).fault.records[1].request_hash = "f".repeat(64);
      },
      (e) => {
        scenario(e).fault.records[1].response_hash = "e".repeat(64);
      },
    ],
  ],
  [
    "foreign settlement or changed absolute deadline",
    [
      (e) => {
        scenario(e, 1).fault.records[1].deadline_at = "2026-10-22T00:10:00Z";
      },
      (e) => {
        scenario(e, 1).fault.lifecycle.requestId = "foreign-operation";
      },
      (e) => {
        scenario(e).fault.held.organization_id = "foreign-organization";
        for (const record of scenario(e).fault.records)
          record.organization_id = "foreign-organization";
      },
    ],
  ],
  [
    "replay changed durable history or reached Provider",
    [
      (e) => {
        scenario(e).replay.after.execution.events.items.at(
          -1,
        ).payload.content[0].text = "changed replay history";
      },
      (e) =>
        scenario(e).replay.after.modelRequests.push({
          phase: "v1-apply-write",
          stage: "tool",
        }),
      (e) => {
        delete scenario(e, 3).replay;
      },
    ],
  ],
  [
    "closed admission created work or output",
    [
      (e) => {
        const denied = scenario(e, 1).denial.after.execution;
        denied.rows.push({ ...runSummary(denied.run), run_id: "denied-run" });
      },
      (e) =>
        scenario(e, 1).denial.after.modelRequests.push({
          phase: "v1-settle-denied",
          stage: "tool",
        }),
      (e) =>
        scenario(e, 1).denial.after.updates.push({
          sessionId: scenario(e, 1).sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "denied-tool",
            status: "completed",
          },
        }),
      (e) => {
        delete scenario(e, 3).denial;
      },
    ],
  ],
  [
    "busy denial checkpoint borrowed another request",
    [
      (e) => {
        scenario(e, 1).denial.requestId = "foreign-request";
      },
      (e) => {
        scenario(e, 1).denial.before.execution = clone(
          scenario(e, 0).replay.before.execution,
        );
        scenario(e, 1).denial.after.execution = clone(
          scenario(e, 0).replay.after.execution,
        );
      },
    ],
  ],
  [
    "missing raw canonical rejection or unjoined connection",
    [
      (e) => e.connections[3].raw_frames.pop(),
      (e) => {
        e.connections[3].raw_frames.at(-1).error.code = -32020;
      },
      (e) => {
        e.connections[11].closed = false;
      },
    ],
  ],
];

for (const [name, mutations] of groups)
  test("RPC business rejects " + name + " without Trace", () => {
    requireAPI();
    for (const mutate of mutations) {
      const original = fixture();
      mutate(original);
      assert.throws(
        () => inspect(original),
        "missing independent business rejection",
      );
    }
  });

test("durable Tool identity must be Run-normalized rather than the Provider-local ID", () => {
  requireAPI();
  const evidence = fixture();
  let raw = JSON.stringify(evidence);
  for (const { run, events } of evidence.scenarios.flatMap(
    (scenario) => scenario.runs,
  )) {
    const normalized = events.items.find((event) => event.kind === "tool_call")
      .payload.toolCallId;
    assert.match(normalized, /^[a-f0-9]{64}$/u);
    raw = raw.replaceAll(normalized, run.input[0].text + "-tool");
  }
  assert.throws(() => inspect(JSON.parse(raw)));
});

test("RPC loss admits complete hidden model attempts without changing the original wire or summary", () => {
  requireAPI();
  const evidence = fixture();
  const wire = clone(evidence.connections);
  addModelAttempts(evidence);
  for (const execution of executionCopies(evidence))
    assert.equal(
      execution.events.items.filter((event) => event.kind === "model_attempt")
        .length,
      4,
    );
  const before = clone(evidence);
  assert.deepEqual(inspect(evidence), summary);
  assert.deepEqual(evidence, before);
  assert.deepEqual(evidence.connections, wire);
});

const attemptMutations = [
  [
    "visible or context-included audit",
    [
      (rows) => {
        rows[0].visible = true;
      },
      (rows) => {
        rows[0].context_excluded = false;
      },
    ],
  ],
  [
    "missing finish or repeated ordinal",
    [
      (rows, execution) => {
        execution.events.items.splice(
          execution.events.items.indexOf(rows[1]),
          1,
        );
      },
      (rows) => {
        rows[2].payload.ordinal = 1;
        rows[3].payload.ordinal = 1;
      },
    ],
  ],
  [
    "foreign frozen candidate",
    [
      (rows) => {
        rows[0].payload.modelProfileId = "foreign-model-profile";
      },
      (rows) => {
        rows[0].payload.providerConnectionId = "foreign-provider";
      },
      (rows) => {
        rows[0].payload.model = "foreign-model";
      },
    ],
  ],
  [
    "changed usage or context size",
    [
      (rows) => {
        rows[1].payload.usage.outputTokens += 1;
      },
      (rows) => {
        rows[1].payload.contextSize += 1;
      },
    ],
  ],
  [
    "invalid phase or unfinished attempt",
    [
      (rows) => {
        rows[1].payload.phase = "pending";
      },
      (rows) => {
        rows[1].payload.outcome = "failed";
        rows[1].payload.reason = "model_unavailable";
      },
      (rows) => {
        rows[1].payload.outputStarted = false;
      },
    ],
  ],
  [
    "invalid duration or timestamp",
    [
      (rows) => {
        rows[1].payload.durationMs = -1;
      },
      (rows) => {
        rows[1].payload.durationMs = Infinity;
      },
      (rows) => {
        rows[0].payload.startedAt = "not-a-date";
      },
      (rows) => {
        rows[1].payload.finishedAt = "not-a-date";
      },
    ],
  ],
];

for (const [name, mutations] of attemptMutations)
  test("RPC business rejects model attempt " + name + " without Trace", () => {
    requireAPI();
    for (const mutate of mutations) {
      const evidence = addModelAttempts(fixture());
      const selectedRunId = saved(evidence).run.run_id;
      const changed = new WeakSet();
      for (const execution of executionCopies(evidence)) {
        const items = execution.events.items;
        if (execution.run.run_id !== selectedRunId || changed.has(items))
          continue;
        changed.add(items);
        mutate(
          items.filter((event) => event.kind === "model_attempt"),
          execution,
        );
      }
      assert.throws(
        () => inspect(evidence),
        "invalid hidden model audit must independently reject business evidence",
      );
    }
  });

test("RPC business rejects a second model attempt started before the first usage was durable", () => {
  requireAPI();
  const evidence = fixture();
  const wire = clone(evidence.connections);
  addModelAttempts(evidence);
  const selectedRunId = saved(evidence).run.run_id;
  const changed = new WeakSet();
  for (const execution of executionCopies(evidence)) {
    const items = execution.events.items;
    if (execution.run.run_id !== selectedRunId || changed.has(items)) continue;
    changed.add(items);
    const firstSequence = items[0].sequence;
    const secondAttempt = items.filter(
      (event) => event.kind === "model_attempt" && event.payload.ordinal === 2,
    );
    assert.equal(secondAttempt.length, 2);
    const reordered = items.filter((event) => !secondAttempt.includes(event));
    const firstUsageIndex = reordered.findIndex(
      (event) => event.kind === "usage",
    );
    assert(firstUsageIndex >= 0);
    reordered.splice(firstUsageIndex, 0, ...secondAttempt);
    for (const [index, event] of reordered.entries())
      event.sequence = firstSequence + index;
    items.splice(0, items.length, ...reordered);
    assert(
      items.every(
        (event, index) =>
          Number.isSafeInteger(event.sequence) &&
          event.sequence > 0 &&
          (index === 0 || items[index - 1].sequence < event.sequence),
      ),
    );
    const firstUsage = items.find((event) => event.kind === "usage");
    assert(secondAttempt[1].sequence < firstUsage.sequence);
  }
  for (const selected of evidence.scenarios) {
    const sequences = selected.runs.flatMap((execution) =>
      execution.events.items.map((event) => event.sequence),
    );
    assert.equal(new Set(sequences).size, sequences.length);
  }
  assert.deepEqual(evidence.connections, wire);
  assert.throws(
    () => inspect(evidence),
    "later attempt must wait for the original durable usage receipt",
  );
});
