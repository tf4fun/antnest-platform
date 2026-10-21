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

test("Loss admits four durable Tool Runs, eight model calls and original v1 replay/denial receipts without Trace", () => {
  requireAPI();
  const evidence = fixture(),
    original = structuredClone(evidence);
  assert.deepEqual(inspect(evidence), summary);
  assert.deepEqual(evidence, original);
  assert.equal(Object.hasOwn(summary, "runtime_tool_calls"), false);
  assert.equal(Object.hasOwn(summary, "cleanup_completed"), false);
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

test("Loss rejects stale or foreign execution/Runtime snapshots for both phases", () => {
  requireAPI();
  for (const mode of ["live", "cold"]) {
    rejects((e) => {
      saved(e, mode, "after").run.execution_snapshot.executionRevision = agent(
        e,
        mode,
      ).initial.agent.executable_execution_revision;
    });
    rejects((e) => {
      saved(e, mode, "after").run.execution_snapshot.runtime.revision = agent(
        e,
        mode,
      ).initial.agent.runtime.runtime_revision;
    });
    rejects((e) => {
      saved(e, mode).run.execution_snapshot.runtime.executionId =
        "foreign-runtime-execution";
    });
    rejects((e) => {
      saved(e, mode).run.execution_snapshot.runtime.mcpEndpoint =
        "http://foreign-runtime/mcp";
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
