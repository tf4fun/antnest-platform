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
        saved(e).run.execution_snapshot.organizationId = "foreign-organization";
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
    "post-Rebuild Run bound to old or foreign Runtime",
    [
      (e) => {
        saved(e, 1, 1).run.execution_snapshot.runtime = clone(
          saved(e, 1, 0).run.execution_snapshot.runtime,
        );
      },
      (e) => {
        saved(e, 1, 1).run.execution_snapshot.executionRevision = saved(
          e,
          1,
          0,
        ).run.execution_snapshot.executionRevision;
      },
      (e) => {
        scenario(e, 1).replacement.agent_id = "foreign-agent";
      },
      (e) => {
        delete scenario(e, 3).replacement;
      },
    ],
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
