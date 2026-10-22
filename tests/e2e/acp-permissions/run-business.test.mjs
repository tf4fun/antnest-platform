import assert from "node:assert/strict";
import test from "node:test";
import {
  permissionRunBusinessFixture as fixture,
  permissionRunBusinessSummary as expected,
} from "./run-business.fixture.mjs";

const url = new URL("./run-business.mjs", import.meta.url);
const { inspectPermissionRunBusiness: inspect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);
const api = () =>
  assert.equal(
    typeof inspect,
    "function",
    "inspectPermissionRunBusiness is required",
  );
const saved = (e, phase = "v1-once") =>
  e.agents
    .flatMap((agent) => agent.all)
    .find(({ run }) => run.input[0]?.text === phase);
const original = (e, phase = "v1-once") =>
  e.inventory.requests.find((row) => row.phase === phase);
const connection = (e, version = 1, role = "owner") =>
  e.connections.find((row) => row.version === version && row.role === role);
const permission = (e, phase = "v1-once") =>
  saved(e, phase).permissions.items[0];
const toolEvents = (e, phase = "v1-once") =>
  saved(e, phase).events.items.filter((event) => event.kind === "tool_call");
const toolUpdate = (e, phase = "v1-once", status = "completed") => {
  const item = saved(e, phase);
  const id = item.events.items.find((event) => event.kind === "tool_call")
    .payload.toolCallId;
  return e.connections
    .flatMap((c) => c.raw_frames)
    .find(
      (frame) =>
        frame.method === "session/update" &&
        frame.params.update.toolCallId === id &&
        frame.params.update.status === status,
    );
};

function changeRun(e, phase, patch) {
  const record = saved(e, phase),
    id = record.run.run_id;
  Object.assign(record.run, patch);
  const listed = e.agents
    .flatMap((agent) => agent.page.items)
    .find((run) => run.run_id === id);
  for (const key of Object.keys(patch))
    if (Object.hasOwn(listed, key)) listed[key] = patch[key];
}

test("Permissions admits 26 persisted Runs and original SDK/index evidence without Trace metadata", () => {
  api();
  const e = fixture(),
    before = structuredClone(e);
  assert.doesNotMatch(
    JSON.stringify(e),
    /"(?:trace_id|model_span_id|connectionTraceID|clientSpanID|traceID)"/u,
  );
  assert.deepEqual(inspect(e), expected);
  assert.deepEqual(
    e,
    before,
    "business inspection changed the original receipts",
  );
  assert.deepEqual(
    e.agents.map((agent) => agent.page.items.length),
    [13, 13],
  );
  assert.equal(e.inventory.requests.length, 56);
  assert.equal(e.inventory.initializations.length, 6);
  assert.equal(e.inventory.notifications.length, 2);
});

test("Permissions matches original business identities independently of audit order and diagnostic metadata", () => {
  api();
  const e = fixture();
  e.agents.reverse();
  for (const agent of e.agents) {
    agent.page.items.reverse();
    agent.all.reverse();
    for (const item of agent.all) delete item.run.unknown_effect_source;
  }
  for (const c of e.connections) {
    c.connectionTraceID = "PRIVATE-DIAGNOSTIC-CANARY";
    c.clientSpanID = "invalid-client-span";
    for (const row of [c.initialization, ...c.evidence])
      row.connectionTraceID = "different-diagnostic";
  }
  for (const row of e.inventory.requests)
    row.traceID = "duplicated-invalid-diagnostic";
  for (const row of e.model_requests) {
    row.trace_id = "duplicated-invalid-diagnostic";
    row.model_span_id = "invalid-model-span";
  }
  const before = structuredClone(e),
    result = inspect(e);
  assert.deepEqual(result, expected);
  assert(!JSON.stringify(result).includes("PRIVATE-DIAGNOSTIC-CANARY"));
  assert.deepEqual(e, before);
});

test("Permissions distinguishes failed undispatched Tool events and replay deliveries from executed Tools", () => {
  api();
  const e = fixture();
  for (const version of [1, 2]) {
    for (const suffix of ["deny", "reject", "reject-follow", "cancel"]) {
      const phase = `v${version}-${suffix}`,
        item = saved(e, phase);
      assert.equal(item.run.tool_effect_state, "none");
      assert.equal(toolEvents(e, phase).length, 1);
      assert.equal(toolEvents(e, phase)[0].payload.initial, true);
      assert.equal(toolEvents(e, phase)[0].payload.status, "failed");
    }
    const resumed = saved(e, `v${version}-reconnect`);
    assert.equal(resumed.permissions.items.length, 1);
    assert.equal(resumed.permissions.items[0].decision, "allow_once");
    assert.equal(
      original(e, `v${version}-reconnect`).permissionDeliveries.length,
      2,
    );
  }
  assert.deepEqual(inspect(e), expected);
});

test("Permissions admits the real v1 owner stream without a live accepted user-message echo", () => {
  api();
  const evidence = fixture(),
    owner = connection(evidence);
  const durableUsers = evidence.agents
    .flatMap((agent) => agent.all)
    .flatMap((item) =>
      item.events.items.filter((event) => event.kind === "user_message"),
    );
  const users = owner.raw_frames.filter(
    (frame) =>
      frame.method === "session/update" &&
      frame.params.update.sessionUpdate === "user_message_chunk",
  );
  assert.equal(users.length, 13);
  owner.raw_frames = owner.raw_frames.filter((frame) => !users.includes(frame));
  const before = structuredClone(evidence);
  assert.equal(
    durableUsers.length,
    26,
    "the durable accepted user messages must remain present",
  );
  assert(
    connection(evidence, 1, "replay").raw_frames.some(
      (frame) => frame.params?.update?.sessionUpdate === "user_message_chunk",
    ),
    "v1 replay lost its accepted input",
  );
  assert(
    connection(evidence, 2).raw_frames.some(
      (frame) => frame.params?.update?.sessionUpdate === "user_message",
    ),
    "v2 lost its accepted input",
  );
  assert.deepEqual(inspect(evidence), expected);
  assert.deepEqual(evidence, before);
});

test("Permissions binds original Runs to the actual public Agent and audit snapshot projections", () => {
  api();
  const evidence = fixture();
  for (const agent of evidence.agents) {
    // Physical Runtime identity is checked by the separate actual Docker ACK.
    // Admin's public Agent and Run projections do not expose private authority.
    assert.equal(agent.ready.agent_id, agent.agent_id);
    assert.equal(agent.ready.owner_user_id, evidence.principal_id);
    assert.equal(Object.hasOwn(agent.ready, "organization_id"), false);
    assert.equal(Object.hasOwn(agent.ready, "access_revision"), false);
    assert.deepEqual(Object.keys(agent.ready.runtime), ["runtime_revision"]);
    assert.equal(typeof agent.ready.runtime.runtime_revision, "string");
    assert(agent.ready.runtime.runtime_revision.length > 0);
    for (const { run } of agent.all) {
      const snapshot = run.execution_snapshot;
      assert.equal(run.agent_id, agent.ready.agent_id);
      assert.equal(run.principal_id, agent.ready.owner_user_id);
      assert.equal(
        snapshot.executionRevision,
        agent.ready.executable_execution_revision,
      );
      assert.equal(snapshot.agentSpecRevision, agent.ready.agent_spec_revision);
      assert.deepEqual(Object.keys(snapshot).sort(), [
        "agentSpecRevision",
        "configurationRevision",
        "executionRevision",
        "modelProfileId",
        "providerConnectionId",
      ]);
    }
  }
  const before = structuredClone(evidence);
  assert.deepEqual(inspect(evidence), expected);
  assert.deepEqual(evidence, before);
});

const publicationMutations = [
  [
    "missing original ready Agent",
    (_e, agent) => {
      delete agent.ready;
    },
  ],
  [
    "ready names another Agent",
    (_e, agent, _snapshot, other) => {
      agent.ready.agent_id = other.agent_id;
    },
  ],
  [
    "ready has no owner",
    (_e, agent) => {
      delete agent.ready.owner_user_id;
    },
  ],
  [
    "ready belongs to another owner",
    (_e, agent) => {
      agent.ready.owner_user_id = "another-owner";
    },
  ],
  [
    "ready has no executable revision",
    (_e, agent) => {
      delete agent.ready.executable_execution_revision;
    },
  ],
  [
    "ready has no Agent spec revision",
    (_e, agent) => {
      delete agent.ready.agent_spec_revision;
    },
  ],
  [
    "ready has no public Runtime record",
    (_e, agent) => {
      delete agent.ready.runtime;
    },
  ],
  [
    "ready has no public Runtime revision",
    (_e, agent) => {
      delete agent.ready.runtime.runtime_revision;
    },
  ],
  [
    "ready has an empty public Runtime revision",
    (_e, agent) => {
      agent.ready.runtime.runtime_revision = "";
    },
  ],
  [
    "ready has a nonstring public Runtime revision",
    (_e, agent) => {
      agent.ready.runtime.runtime_revision = null;
    },
  ],
  [
    "Run has no executable revision",
    (_e, _agent, snapshot) => {
      delete snapshot.executionRevision;
    },
  ],
  [
    "Run has no Agent spec revision",
    (_e, _agent, snapshot) => {
      delete snapshot.agentSpecRevision;
    },
  ],
  [
    "Run has a stale executable revision",
    (_e, _agent, snapshot) => {
      snapshot.executionRevision = "c".repeat(64);
    },
  ],
  [
    "Run has a stale Agent spec revision",
    (_e, _agent, snapshot) => {
      snapshot.agentSpecRevision = "old-agent-spec";
    },
  ],
  [
    "Run borrows the other Agent publication",
    (_e, _agent, snapshot, other) => {
      snapshot.executionRevision = other.ready.executable_execution_revision;
      snapshot.agentSpecRevision = other.ready.agent_spec_revision;
    },
  ],
];
for (const version of [1, 2]) {
  test(`Permissions v${version} rejects missing, stale or foreign public Agent/Run publication identities`, () => {
    api();
    for (const [name, mutate] of publicationMutations) {
      const evidence = fixture();
      const agent = evidence.agents.find(
        (item) => item.agent_id === evidence.agent_ids[version - 1],
      );
      const other = evidence.agents.find((item) => item !== agent);
      mutate(
        evidence,
        agent,
        saved(evidence, `v${version}-once`).run.execution_snapshot,
        other,
      );
      assert.throws(() => inspect(evidence), undefined, name);
    }
  });
  test(`Permissions v${version} validates public publication revisions after the first Run, including undispatched and resumed Runs`, () => {
    api();
    for (const entry of ["follow", "deny", "cancel", "reconnect"]) {
      for (const field of ["executionRevision", "agentSpecRevision"]) {
        const evidence = fixture();
        saved(evidence, `v${version}-${entry}`).run.execution_snapshot[field] =
          "stale-publication-revision";
        assert.throws(() => inspect(evidence), undefined, `${entry} ${field}`);
      }
    }
  });
}

const groups = [
  [
    "missing duplicate truncated or replay-created Runs",
    [
      [
        "missing original Run",
        (e) => {
          e.agents[0].page.items.shift();
          e.agents[0].all.shift();
        },
      ],
      [
        "duplicate Run detail",
        (e) => {
          e.agents[0].all[1] = structuredClone(e.agents[0].all[0]);
        },
      ],
      [
        "truncated Agent list",
        (e) => {
          e.agents[1].page.next_cursor = "more-runs";
        },
      ],
      [
        "reconnect admitted an extra Run",
        (e) => {
          const extra = structuredClone(saved(e, "v1-reconnect"));
          extra.run.run_id = "extra-reconnect-run";
          const agent = e.agents.find(
            (item) => item.agent_id === extra.run.agent_id,
          );
          agent.all.push(extra);
          const summary = structuredClone(
            agent.page.items.find(
              (row) => row.run_id === "fixture-run-v1-reconnect",
            ),
          );
          summary.run_id = extra.run.run_id;
          agent.page.items.push(summary);
        },
      ],
    ],
  ],
  [
    "foreign scope changed input or a false v2 acknowledgement",
    [
      [
        "foreign Principal",
        (e) => changeRun(e, "v1-once", { principal_id: "another-owner" }),
      ],
      [
        "foreign Agent",
        (e) => changeRun(e, "v1-once", { agent_id: e.agent_ids[1] }),
      ],
      [
        "another original Session",
        (e) =>
          changeRun(e, "v1-once", {
            session_id: saved(e, "v1-reject").run.session_id,
          }),
      ],
      [
        "Run and durable input both changed",
        (e) => {
          const item = saved(e);
          item.run.input = [{ type: "text", text: "unrequested execution" }];
          item.events.items.find(
            (event) => event.kind === "user_message",
          ).payload.content = structuredClone(item.run.input);
        },
      ],
      [
        "v2 ACK names another user message",
        (e) => {
          original(e, "v2-once").requestReceipt.result.messageId =
            "another-message";
        },
      ],
    ],
  ],
  [
    "incomplete or corrupted original event pages",
    [
      [
        "truncated execution events",
        (e) => {
          saved(e).events.next_cursor = "more-events";
        },
      ],
      [
        "missing permission stream",
        (e) => {
          delete saved(e).permissions;
        },
      ],
      [
        "truncated permission stream",
        (e) => {
          saved(e).permissions.next_cursor = "more-permissions";
        },
      ],
      [
        "duplicate event identity",
        (e) => {
          saved(e).events.items[1].id = saved(e).events.items[0].id;
        },
      ],
      [
        "missing durable user message",
        (e) => {
          saved(e).events.items = saved(e).events.items.filter(
            (event) => event.kind !== "user_message",
          );
        },
      ],
    ],
  ],
  [
    "nonterminal unknown or contradictory durable outcomes",
    [
      [
        "failed approved Run",
        (e) => {
          changeRun(e, "v1-once", { state: "failed" });
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
        "unknown effects",
        (e) => {
          saved(e).run.tool_effect_state = "unknown";
        },
      ],
      [
        "effect source remains pinned",
        (e) => {
          saved(e).run.unknown_effect_source = "runtime_mcp";
        },
      ],
      [
        "completed Tool lost its settled effect",
        (e) => {
          saved(e).run.tool_effect_state = "none";
        },
      ],
    ],
  ],
  [
    "permission facts detached from original Run Session or Tool",
    [
      [
        "missing persisted wait",
        (e) => {
          saved(e).permissions.items = [];
        },
      ],
      [
        "wrong permission Run",
        (e) => {
          permission(e).request.runId = "another-run";
        },
      ],
      [
        "wrong permission Session",
        (e) => {
          permission(e).request.sessionId = saved(
            e,
            "v1-reject",
          ).run.session_id;
        },
      ],
      [
        "permission Tool ID differs",
        (e) => {
          permission(e).tool_call_id = "f".repeat(64);
        },
      ],
      [
        "permission arguments differ",
        (e) => {
          permission(e).request.call.arguments.path = "another-file.txt";
        },
      ],
    ],
  ],
  [
    "approval cancellation or replay decisions that disagree with their deliveries",
    [
      [
        "approved call persisted as rejection",
        (e) => {
          permission(e).decision = "reject_once";
        },
      ],
      [
        "cancelled approval persisted as allowed",
        (e) => {
          permission(e, "v1-cancel").decision = "allow_once";
        },
      ],
      [
        "reissued approval kept the original connection cancellation",
        (e) => {
          permission(e, "v1-reconnect").decision = "cancelled";
        },
      ],
      [
        "approval still pending",
        (e) => {
          permission(e).decision = null;
          permission(e).decided_at = null;
        },
      ],
      [
        "wire selected a different original option",
        (e) => {
          connection(e).permissions[0].optionId = "reject_once";
        },
      ],
    ],
  ],
  [
    "incorrect execution rejection or actual Tool output",
    [
      [
        "approved Tool failed",
        (e) => {
          toolEvents(e)[1].payload.status = "failed";
        },
      ],
      [
        "approved Tool has no execution events",
        (e) => {
          saved(e).events.items = saved(e).events.items.filter(
            (event) => event.kind !== "tool_call",
          );
        },
      ],
      [
        "denied Tool completed",
        (e) => {
          toolEvents(e, "v1-deny")[0].payload.status = "completed";
        },
      ],
      [
        "original Tool result disagrees with persistence",
        (e) => {
          toolUpdate(e).params.update.content[0].content.text =
            "different Runtime result";
        },
      ],
      [
        "original assistant output disagrees with persistence",
        (e) => {
          const frame = connection(e).raw_frames.find(
            (row) =>
              row.method === "session/update" &&
              row.params.update.messageId === "v1-once-reply",
          );
          frame.params.update.content.text = "different assistant output";
        },
      ],
    ],
  ],
  [
    "cancel or reconnect acknowledged without their real terminal proof",
    [
      [
        "cancelled Run marked completed",
        (e) => {
          changeRun(e, "v2-cancel", { state: "completed" });
          saved(e, "v2-cancel").run.terminal_class = "completed";
          saved(e, "v2-cancel").run.stop_reason = "end_turn";
        },
      ],
      [
        "v2 idle lost cancelled stop reason",
        (e) => {
          const sessionId = saved(e, "v2-cancel").run.session_id;
          connection(e, 2).raw_frames.find(
            (row) =>
              row.params?.sessionId === sessionId &&
              row.params.update?.sessionUpdate === "state_update" &&
              row.params.update.state === "idle",
          ).params.update.stopReason = "end_turn";
        },
      ],
      [
        "cancel never finished writing",
        (e) => {
          connection(e).notifications[0].status = "write_failed";
        },
      ],
      [
        "v1 reconnect lost its original close exception",
        (e) => {
          delete original(e, "v1-reconnect").closedBeforeResponse;
        },
      ],
    ],
  ],
  [
    "missing extra or wrongly scoped real model requests",
    [
      [
        "missing model request",
        (e) => {
          e.model_requests.pop();
        },
      ],
      [
        "extra model request",
        (e) => {
          e.model_requests.push(structuredClone(e.model_requests[0]));
        },
      ],
      [
        "missing actual Smart judgement",
        (e) => {
          e.model_requests.find((row) => row.stage === "judge").stage = 1;
        },
      ],
      [
        "wrong selected Model",
        (e) => {
          e.model_requests[0].model = e.model_names.default;
        },
      ],
    ],
  ],
];

for (const [group, mutations] of groups)
  test("Permissions rejects " + group, () => {
    api();
    for (const [name, mutate] of mutations) {
      const evidence = fixture();
      mutate(evidence);
      assert.throws(() => inspect(evidence), undefined, name);
    }
  });
