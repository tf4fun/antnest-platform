import assert from "node:assert/strict";
import { test } from "node:test";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import * as evidence from "./evidence.mjs";
const { assertInterrupted, assertReplacement, assertBarrierRejection } =
  evidence;
function fixture(kind) {
  const before = {
    run: {
      run_id: "r",
      session_id: "s",
      agent_id: "a",
      principal_id: "p",
      created_at: "t",
      state: kind === "completed" ? "completed" : "running",
      execution_snapshot: { runtime: { revision: "source" } },
      input: [],
      usage_measurements: [],
    },
    events: {
      stream: "execution",
      next_cursor: null,
      items:
        kind === "model-held"
          ? []
          : [
              {
                id: "tool",
                sequence: 1,
                kind: "tool_call",
                visible: true,
                payload: {
                  kind: "tool_call",
                  toolCallId: "t",
                  status: kind === "inflight" ? "in_progress" : "completed",
                },
              },
            ],
    },
  };
  const after = structuredClone(before);
  if (kind !== "completed") {
    Object.assign(after.run, {
      state: kind === "inflight" ? "unresolved" : "failed",
      terminal_class: kind === "inflight" ? "unresolved" : "failed",
      executor_state: "quiescent",
      tool_effect_state:
        kind === "inflight"
          ? "unknown"
          : kind === "model-held"
            ? "none"
            : "settled",
      ...(kind === "inflight" ? { unknown_effect_source: "runtime_mcp" } : {}),
      error_class:
        kind === "inflight"
          ? "service_restarted_during_tool"
          : "service_restarted_during_run",
      stop_reason: null,
    });
    if (kind === "inflight")
      after.events.items.push({
        id: "unknown",
        sequence: 2,
        kind: "tool_call",
        visible: true,
        payload: {
          kind: "tool_call",
          initial: false,
          toolCallId: "t",
          status: "failed",
          content: [
            {
              type: "text",
              text: "Tool outcome is unknown because Agent ACP Service restarted.",
            },
          ],
        },
      });
  }
  return { before, after };
}
test("current public audits distinguish completed, known interrupted and unknown Runtime effects", () => {
  for (const kind of ["completed", "model-held", "tool-held", "inflight"]) {
    const { before, after } = fixture(kind);
    assertInterrupted(before, after, kind);
    const wrong = structuredClone(after);
    wrong.run.state = "completed-invented";
    assert.throws(() => assertInterrupted(before, wrong, kind));
    if (kind === "inflight") {
      for (const modify of [
        (x) => (x.run.tool_effect_state = "settled"),
        (x) => x.events.items.pop(),
        (x) => (x.events.items[0].payload.status = "completed"),
        (x) => (x.events.items[1].payload.status = "completed"),
      ]) {
        const wrong = structuredClone(after);
        modify(wrong);
        assert.throws(() => assertInterrupted(before, wrong, kind));
      }
    }
  }
});
test("replacement keeps template and Agent identity but replaces every execution identity", () => {
  const before = {
      agent_id: "a",
      template_id: "t",
      template_revision: 4,
      runtime_revision: "r",
      runtime_execution_id: "p",
      execution_revision: "e",
    },
    after = {
      ...before,
      runtime_revision: "r2",
      runtime_execution_id: "p2",
      execution_revision: "e2",
    };
  assertReplacement(before, after);
  for (const key of [
    "runtime_revision",
    "runtime_execution_id",
    "execution_revision",
  ])
    assert.throws(() =>
      assertReplacement(before, { ...after, [key]: before[key] }),
    );
});
test("unknown barrier uses its canonical admission error instead of busy", () => {
  assertBarrierRejection(admissionErrorReceipt("runtime_barrier_required"));
  assert.throws(() =>
    assertBarrierRejection(admissionErrorReceipt("agent_busy")),
  );
});

function replacementRunFixture(version) {
  const replacement = {
    agent_id: "restart-agent",
    runtime_revision: "rtv_" + "2".repeat(32),
    runtime_execution_id: "replacement-instance",
    mcp_endpoint: "http://replacement-runtime:8080/mcp",
    execution_revision: "replacement-execution-revision",
    template_id: "restart-template",
    template_revision: 1,
  };
  const expected = {
    agentId: replacement.agent_id,
    sessionId: "restart-session",
    phase: `v${version}-inflight-post`,
    replacement,
  };
  const run = {
    run_id: "restart-post-run",
    agent_id: expected.agentId,
    session_id: expected.sessionId,
    principal_id: "restart-owner",
    state: "completed",
    created_at: "2026-10-22T00:00:00.000Z",
    updated_at: "2026-10-22T00:00:01.000Z",
    input: [{ type: "text", text: expected.phase }],
    // This is the actual Admin auditExecutionSnapshot whitelist. Runtime
    // process/endpoint identity belongs to the separate captureRuntime DTO;
    // only the public executionRevision binds this Run to that receipt.
    execution_snapshot: {
      providerConnectionId: "restart-provider",
      modelProfileId: "restart-model-profile",
      configurationRevision: 8,
      agentSpecRevision: "restart-agent-spec",
      executionRevision: replacement.execution_revision,
      deadlineAt: "2026-10-22T00:01:00.000Z",
      agentExecutionSpecDigest: "a".repeat(64),
      executionSpec: {
        systemPrompt: "Restart fixture",
        contextPolicyVersion: "context-v1",
        maxModelRequests: 8,
        model: {
          model: "restart-model",
          contextWindow: 64000,
          maxOutputTokens: 4096,
          supportsImages: false,
        },
        configuration: {
          modelProfileId: "restart-model-profile",
          authorizationRevision: 1,
          authorization: { mode: "auto", toolRules: [] },
        },
      },
    },
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    stop_reason: "end_turn",
    error_class: null,
    unknown_effect_source: null,
    usage_measurements: [],
  };
  return { run, expected };
}

function replacementRunAssertion() {
  assert.equal(
    typeof evidence.assertReplacementRun,
    "function",
    "assertReplacementRun is not implemented",
  );
  return evidence.assertReplacementRun;
}

for (const version of [1, 2]) {
  test(`v${version}: replacement post Run binds its actual public Admin DTO without Trace or private Runtime fields`, () => {
    const check = replacementRunAssertion();
    const original = replacementRunFixture(version);
    const before = structuredClone(original);
    for (const field of [
      "runtime",
      "organizationId",
      "accessRevision",
      "clientMcpRevisionId",
    ])
      assert(!Object.hasOwn(original.run.execution_snapshot, field));
    check(original.run, original.expected);
    assert.deepEqual(
      original,
      before,
      "replacement binding changed the original evidence",
    );
  });

  test(`v${version}: replacement post Run rejects a foreign Agent, Session or original input`, () => {
    const check = replacementRunAssertion();
    for (const mutate of [
      ({ run }) => {
        run.agent_id = "foreign-agent";
      },
      ({ run }) => {
        run.session_id = "foreign-session";
      },
      ({ run }) => {
        run.input[0].text = "another-prompt";
      },
      ({ run }) => {
        run.input = [];
      },
      ({ run }) => {
        run.input.push({ type: "text", text: "extra-input" });
      },
    ]) {
      const original = replacementRunFixture(version);
      mutate(original);
      assert.throws(() => check(original.run, original.expected));
    }
  });

  test(`v${version}: replacement post Run rejects missing, cross-Agent or inconsistent actual execution receipts`, () => {
    const check = replacementRunAssertion();
    for (const mutate of [
      ({ expected }) => {
        delete expected.replacement;
      },
      ({ expected }) => {
        expected.replacement.agent_id = "foreign-agent";
      },
      ({ expected }) => {
        expected.replacement.execution_revision = "another-execution";
      },
      ({ expected }) => {
        expected.replacement.execution_revision = "";
      },
      ({ run }) => {
        delete run.execution_snapshot;
      },
      ({ run }) => {
        run.execution_snapshot.executionRevision = "old-execution-revision";
      },
      ({ run }) => {
        delete run.execution_snapshot.executionRevision;
      },
    ]) {
      const original = replacementRunFixture(version);
      mutate(original);
      assert.throws(() => check(original.run, original.expected));
    }
  });

  test(`v${version}: replacement post Run must be durably completed, quiescent and settled`, () => {
    const check = replacementRunAssertion();
    for (const mutate of [
      ({ run }) => {
        run.state = "running";
      },
      ({ run }) => {
        run.state = "failed";
        run.terminal_class = "failed";
        run.error_class = "controlled-failure";
      },
      ({ run }) => {
        run.terminal_class = "cancelled";
      },
      ({ run }) => {
        run.executor_state = "unknown";
      },
      ({ run }) => {
        run.tool_effect_state = "unknown";
      },
      ({ run }) => {
        run.tool_effect_state = "none";
      },
      ({ run }) => {
        run.stop_reason = "max_turn_requests";
      },
      ({ run }) => {
        run.error_class = "unexpected-error";
      },
      ({ run }) => {
        run.unknown_effect_source = "runtime_mcp";
      },
    ]) {
      const original = replacementRunFixture(version);
      mutate(original);
      assert.throws(() => check(original.run, original.expected));
    }
  });
}
