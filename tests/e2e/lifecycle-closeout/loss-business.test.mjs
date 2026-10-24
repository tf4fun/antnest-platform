import assert from "node:assert/strict";
import test from "node:test";
import {
  lossBusinessFixture as fixture,
  lossBusinessSummary as summary,
} from "./loss-business.fixture.mjs";

const url = new URL("./loss-business.mjs", import.meta.url);
const { inspectLossBusinessEvidence: inspect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);
const requireAPI = () => assert.equal(typeof inspect, "function");
const agent = (e, mode = "live") => e.agents.find((row) => row.mode === mode);
const saved = (e, mode = "live", moment = "before") =>
  agent(e, mode).audit.all.find(
    (row) => row.run.input[0].text === `c5-${mode}-${moment}`,
  );
const tool = (e, mode = "live", moment = "before") =>
  saved(e, mode, moment).events.items.filter((row) => row.kind === "tool_call");
function rejects(mutate) {
  const evidence = fixture();
  mutate(evidence);
  assert.throws(() => inspect(evidence));
}
function mutateSnapshot(evidence, mode, moment, mutate) {
  for (const run of [
    saved(evidence, mode, moment).run,
    agent(evidence, mode)[moment + "_run"],
  ])
    mutate(run.execution_snapshot);
}

test("Loss admits four durable Tool Runs, eight model calls and original v1 replay/denial receipts without Trace", () => {
  requireAPI();
  const evidence = fixture(),
    original = structuredClone(evidence);
  assert.deepEqual(inspect(evidence), summary);
  assert.deepEqual(evidence, original);
  assert.equal(Object.hasOwn(summary, "runtime_tool_calls"), false);
  assert.equal(Object.hasOwn(summary, "cleanup_completed"), false);
});

test("Loss admits the public Admin Agent and Run projections without private scope or Runtime fields", () => {
  requireAPI();
  const evidence = fixture();
  for (const row of evidence.agents) {
    for (const state of [row.initial, row.replacement]) {
      for (const field of ["organization_id", "access_revision"])
        assert.equal(Object.hasOwn(state.agent, field), false);
      assert.deepEqual(Object.keys(state.agent.runtime), ["runtime_revision"]);
      assert.equal(
        state.container.Config.Labels["io.antnest.agent-id"],
        row.id,
      );
    }
    for (const run of [
      row.before_run,
      row.after_run,
      ...row.audit.all.map((saved) => saved.run),
    ])
      assert.deepEqual(Object.keys(run.execution_snapshot).sort(), [
        "agentExecutionSpecDigest",
        "agentSpecRevision",
        "configurationRevision",
        "deadlineAt",
        "executionRevision",
        "executionSpec",
        "modelProfileId",
        "providerConnectionId",
      ]);
  }
  assert.deepEqual(inspect(evidence), summary);
});

test("Loss returns only safe counts, including when private initialization metadata has additional fields", () => {
  requireAPI();
  const evidence = fixture(),
    canary = "LOSS_PRIVATE_RECEIPT_CANARY";
  for (const c of evidence.private_connections) {
    c.initialization.initializationResult._meta.private_fixture = canary;
    c.raw_frames[0].result._meta.private_fixture = canary;
  }
  const result = inspect(evidence);
  assert.deepEqual(result, summary);
  assert(!JSON.stringify(result).includes(canary));
  assert(!JSON.stringify(result).includes(evidence.principal.user_id));
});

test("Loss rejects missing, extra or cross-Agent durable Runs", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    rejects((e) => agent(e, mode).audit.all.pop());
    rejects((e) => {
      const a = agent(e, mode),
        extra = structuredClone(a.audit.all[0]);
      extra.run.run_id = mode + "-extra-run";
      a.audit.all.push(extra);
      a.audit.page.items.push({
        ...a.audit.page.items[0],
        run_id: extra.run.run_id,
      });
    });
    rejects((e) => {
      const a = agent(e, mode),
        other = agent(e, mode === "live" ? "cold" : "live");
      a.audit.all[0] = structuredClone(other.audit.all[0]);
      a.audit.page.items[0] = structuredClone(other.audit.page.items[0]);
    });
  }
});

test("Loss rejects missing, repeated or borrowed durable Tool lifecycles", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    rejects((e) => {
      saved(e, mode).events.items = saved(e, mode).events.items.filter(
        (event) => event.kind !== "tool_call",
      );
    });
    rejects((e) => {
      const extra = tool(e, mode).map((event, index) => ({
        ...structuredClone(event),
        id: mode + "-extra-tool-" + index,
        sequence: 40 + index,
      }));
      for (const event of extra) event.payload.toolCallId = "extra-tool";
      saved(e, mode).events.items.push(...extra);
    });
    rejects((e) => {
      const source = tool(e, mode === "live" ? "cold" : "live"),
        target = tool(e, mode);
      target.forEach((event, index) => {
        event.payload = structuredClone(source[index].payload);
      });
    });
  }
});

test("Loss requires complete Audit lists and complete ordered execution event pages", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    rejects((e) => {
      agent(e, mode).audit.page.next_cursor = "more-runs";
    });
    rejects((e) => {
      saved(e, mode, "after").events.next_cursor = "more-events";
    });
    rejects((e) => {
      saved(e, mode).events.stream = "permissions";
    });
    rejects((e) => {
      const items = saved(e, mode).events.items;
      items[1].sequence = items[0].sequence;
    });
  }
});

test("Loss binds durable input and Principal to the original owner and SDK prompt", () => {
  requireAPI();
  rejects((e) => {
    const row = saved(e);
    row.run.input = [{ type: "text", text: "foreign prompt" }];
    row.events.items.find(
      (event) => event.kind === "user_message",
    ).payload.content = structuredClone(row.run.input);
  });
  rejects((e) => {
    const a = agent(e),
      row = saved(e);
    row.run.principal_id = "foreign-owner";
    a.audit.page.items.find(
      (item) => item.run_id === row.run.run_id,
    ).principal_id = "foreign-owner";
  });
  rejects((e) => {
    e.private_connections[0].evidence[1].requestReceipt.params.prompt[0].text =
      "changed original receipt";
  });
});

test("Loss binds the public ready Agent to the original login owner and creation organization", () => {
  requireAPI();
  rejects((e) => {
    e.principal.organization_id = "foreign-organization";
  });
  rejects((e) => {
    e.creation_principal = encodeURIComponent(
      JSON.stringify(["foreign-organization", "loss-administrator"]),
    );
  });
  rejects((e) => {
    e.creation_principal = encodeURIComponent(
      JSON.stringify([e.principal.organization_id, ""]),
    );
  });
  for (const mode of ["live", "cold"])
    for (const phase of ["initial", "replacement"]) {
      rejects((e) => {
        agent(e, mode)[phase].agent.agent_id = "foreign-agent";
      });
      rejects((e) => {
        agent(e, mode)[phase].agent.owner_user_id = "foreign-owner";
      });
    }
});

test("Loss rejects stale or foreign public spec and execution revisions for both phases", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    for (const moment of ["before", "after"]) {
      rejects((e) => {
        mutateSnapshot(e, mode, moment, (snapshot) => {
          snapshot.agentSpecRevision = "foreign-agent-spec";
        });
      });
      rejects((e) => {
        mutateSnapshot(e, mode, moment, (snapshot) => {
          snapshot.executionRevision = "foreign-execution-revision";
        });
      });
      rejects((e) => {
        mutateSnapshot(e, mode, moment, (snapshot) => {
          snapshot.configurationRevision = 0;
        });
      });
    }
    rejects((e) => {
      mutateSnapshot(e, mode, "after", (snapshot) => {
        snapshot.executionRevision = agent(
          e,
          mode,
        ).initial.agent.executable_execution_revision;
      });
    });
    rejects((e) => {
      mutateSnapshot(e, mode, "after", (snapshot) => {
        snapshot.agentSpecRevision = agent(
          e,
          mode,
        ).initial.agent.agent_spec_revision;
      });
    });
  }
});

test("Loss binds Runtime lineage to the original inspected container and replacement", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    for (const phase of ["initial", "replacement"]) {
      rejects((e) => {
        agent(e, mode)[phase].agent.runtime.runtime_revision = "";
      });
      rejects((e) => {
        agent(e, mode)[phase].container.Id = "";
      });
      rejects((e) => {
        agent(e, mode)[phase].container.Config.Labels["io.antnest.agent-id"] =
          "foreign-agent";
      });
      rejects((e) => {
        delete agent(e, mode)[phase].container.Config.Labels[
          "io.antnest.runtime-controller-scope"
        ];
      });
    }
    rejects((e) => {
      const row = agent(e, mode);
      row.replacement.agent.runtime.runtime_revision =
        row.initial.agent.runtime.runtime_revision;
    });
    rejects((e) => {
      const row = agent(e, mode);
      row.replacement.container.Id = row.initial.container.Id;
    });
    rejects((e) => {
      agent(e, mode).replacement.container.Config.Labels[
        "io.antnest.runtime-controller-scope"
      ] = "antnest-lifecycle-ff123456";
    });
    rejects((e) => {
      agent(e, mode).replacement.volume = "foreign-workspace";
    });
    rejects((e) => {
      agent(e, mode).replacement.agent.configuration.template.template_id =
        "foreign-template";
    });
    rejects((e) => {
      const row = agent(e, mode);
      row.replacement.agent.aggregate_sequence =
        row.initial.agent.aggregate_sequence;
    });
  }
});

test("Loss requires settled terminal outcomes and matching durable Tool results, replies and usage", () => {
  requireAPI();
  rejects((e) => {
    saved(e).run.executor_state = "unknown";
  });
  rejects((e) => {
    saved(e).run.tool_effect_state = "unknown";
    saved(e).run.unknown_effect_source = "runtime_mcp";
  });
  rejects((e) => {
    saved(e).run.terminal_class = "failed";
  });
  rejects((e) => {
    tool(e)[1].payload.content[0].text = "changed persisted Tool output";
  });
  rejects((e) => {
    saved(e).events.items.at(-1).payload.content[0].text =
      "changed persisted reply";
  });
  rejects((e) => {
    saved(e).run.usage_measurements.pop();
  });
});

test("Loss requires the actual original SDK responses and canonical unavailable refusal", () => {
  requireAPI();
  rejects((e) => {
    e.private_connections[0].raw_frames =
      e.private_connections[0].raw_frames.filter(
        (frame) => String(frame.id) !== "3",
      );
  });
  rejects((e) => {
    e.private_connections[2].evidence[1].requestReceipt.requestId =
      "another-connection-request";
  });
  rejects((e) => {
    e.private_connections[1].raw_frames.find(
      (frame) => frame.error,
    ).error.code = -32020;
  });
  rejects((e) => {
    e.private_connections[1].raw_frames.find(
      (frame) => frame.error,
    ).error.data.retryable = false;
  });
});

test("Loss denials cannot produce a Run, model execution or notifications", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    rejects((e) => {
      const a = agent(e, mode);
      a.denial.after.page.items.push({
        ...a.denial.after.page.items[0],
        run_id: "denied-new-run",
      });
    });
    rejects((e) => {
      agent(e, mode).denial.after.model_requests.push({
        phase: `c5-${mode}-denied`,
        stage: "tool",
        received_at_ms: 1,
      });
    });
    rejects((e) => {
      const a = agent(e, mode);
      a.denial.after.updates.push({
        sessionId: a.session_id,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "denied-tool",
          status: "in_progress",
          title: "bash",
        },
      });
    });
  }
});

test("Loss replay preserves original history and does not execute before or after recovery", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    rejects((e) => {
      agent(e, mode).replays.pop();
    });
    rejects((e) => {
      const replay = agent(e, mode).replays[2];
      replay.after.page.items.push({
        ...replay.after.page.items[0],
        run_id: "replay-created-run",
      });
    });
    rejects((e) => {
      agent(e, mode).replays[1].after.model_requests.push({
        phase: `c5-${mode}-before`,
        stage: "tool",
        received_at_ms: 1,
      });
    });
    rejects((e) => {
      const row = agent(e, mode).replays[2].after.history.find(
        (frame) => frame.update.sessionUpdate === "tool_call_update",
      );
      row.update.content[0].content.text = "changed recovered history";
    });
  }
});

test("Loss model inventory cannot omit, repeat or substitute the four original prompt phases", () => {
  requireAPI();
  rejects((e) => e.provider_requests.pop());
  rejects((e) =>
    e.provider_requests.push(structuredClone(e.provider_requests[0])),
  );
  rejects((e) => {
    e.provider_requests[0].phase = "c5-live-denied";
  });
});

test("durable Tool identity must be Run-normalized rather than the Provider-local ID", () => {
  requireAPI();
  const evidence = fixture();
  let raw = JSON.stringify(evidence);
  for (const { run, events } of evidence.agents.flatMap(
    (agent) => agent.audit.all,
  )) {
    const normalized = events.items.find((event) => event.kind === "tool_call")
      .payload.toolCallId;
    assert.match(normalized, /^[a-f0-9]{64}$/u);
    raw = raw.replaceAll(normalized, run.input[0].text + "-tool");
  }
  assert.throws(() => inspect(JSON.parse(raw)));
});

function modelAttemptExecutionCopies(evidence) {
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

test("Loss admits complete hidden model attempts without changing the original wire or summary", () => {
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
  test("Loss rejects model attempt " + name + " without Trace", () => {
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
