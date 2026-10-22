import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./run-business.mjs", import.meta.url);
const {
  inspectCommandRunBusiness: inspect,
  collectCommandRunBusiness: collect,
} = await import(url).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
    throw error;
  return {};
});

const profiles = ["v1-ws", "v2-ws", "v1-http"];
const timestamp = "2026-10-22T00:00:00.000000Z";
const marker = "F08_PRIVATE_ATTACHMENT";
const measurement = { inputTokens: 100, outputTokens: 20 };

function helpReply(text) {
  const commands = "/help - Show available commands (also /帮助)";
  return text === "/帮助"
    ? "可用命令：\n" +
        commands +
        "\n\n也可使用 /帮助。请直接用自然语言描述任务；帮助命令不会处理附加的任务内容或文件。"
    : "Available commands:\n" +
        commands +
        "\n\nDescribe tasks in natural language. Help does not process appended task instructions or attachments.";
}

function commandInput(text) {
  return [
    { type: "text", text },
    ...(text === "/help"
      ? [
          {
            type: "resource_link",
            uri: "file:///" + marker + ".txt",
            name: "notes.txt",
            mimeType: "text/plain",
          },
          {
            type: "resource",
            resource: {
              uri: "attachment:///notes.txt",
              mimeType: "text/plain",
              text: marker,
            },
          },
        ]
      : []),
  ];
}

// Audit payloads use domain events; original SDK notifications use each actual
// protocol's projection. Neither fixture source contains Trace or Span metadata.
function fixture() {
  const requests = [],
    all = [],
    items = [],
    modelRequests = [];
  for (const profile of profiles) {
    const version = profile === "v2-ws" ? 2 : 1;
    const sessionId = "session-" + profile;
    const inputs = ["/help", "/帮助"];
    if (profile !== "v1-http") inputs.push("v" + version + "-baseline");
    let sequence = 0;
    for (const text of inputs) {
      const ordinary = text.endsWith("-baseline");
      const n = requests.length;
      const messageId = "user-" + n,
        replyId = "reply-" + n;
      const input = ordinary ? [{ type: "text", text }] : commandInput(text);
      const content = [
        {
          type: "text",
          text: ordinary ? text + " verified" : helpReply(text),
        },
      ];
      const updates = [];
      const notify = (update) => updates.push({ sessionId, update });
      if (version === 2) {
        notify({
          sessionUpdate: "user_message",
          messageId,
          content: structuredClone(input),
        });
        notify({ sessionUpdate: "state_update", state: "running" });
      }
      const events = { stream: "execution", next_cursor: null, items: [] };
      const event = (id, kind, payload, visible = true) =>
        events.items.push({
          id,
          sequence: ++sequence,
          kind,
          visible,
          payload: structuredClone(payload),
          created_at: timestamp,
        });
      event(messageId, "user_message", {
        kind: "user_message",
        messageId,
        content: input,
      });
      if (ordinary) {
        const toolCallId = text + "-tool";
        const arguments_ = {
          command:
            "printf '%s\\n' '" +
            text +
            "' >> /workspace/acp-effects.log; cat /workspace/acp-effects.log",
          working_dir: ".",
          timeout_ms: 10000,
        };
        const toolContent = [
          {
            type: "text",
            text: JSON.stringify({
              exit_code: 0,
              stdout: text + "\n",
              stderr: "",
              truncated: false,
              effect_state: "settled",
            }),
          },
        ];
        const usage = {
          kind: "usage",
          used: 120,
          size: 8192,
          measurement: structuredClone(measurement),
        };
        const start = {
          kind: "tool_call",
          initial: true,
          toolCallId,
          title: "bash",
          toolKind: "execute",
          modelName: "bash",
          arguments: arguments_,
          status: "in_progress",
        };
        event("usage-first-" + n, "usage", usage);
        event(
          "model-call-" + n,
          "agent_message",
          {
            kind: "agent_message",
            messageId: "model-call-" + n,
            content: [],
            toolCalls: [
              { id: toolCallId, name: "bash", arguments: arguments_ },
            ],
          },
          false,
        );
        event("tool-start-" + n, "tool_call", start);
        event("tool-end-" + n, "tool_call", {
          kind: "tool_call",
          initial: false,
          toolCallId,
          status: "completed",
          content: toolContent,
        });
        event("usage-last-" + n, "usage", usage);
        notify({ sessionUpdate: "usage_update", used: 120, size: 8192 });
        notify({
          sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
          toolCallId,
          title: "bash",
          kind: "execute",
          name: "bash",
          rawInput: structuredClone(arguments_),
          status: "in_progress",
        });
        notify({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          content: toolContent.map((block) => ({
            type: "content",
            content: structuredClone(block),
          })),
        });
        notify({ sessionUpdate: "usage_update", used: 120, size: 8192 });
        for (const stage of ["tool", "reply"])
          modelRequests.push({ phase: text, stage });
      }
      event(replyId, "agent_message", {
        kind: "agent_message",
        messageId: replyId,
        content,
      });
      notify({
        sessionUpdate: version === 1 ? "agent_message_chunk" : "agent_message",
        messageId: replyId,
        content:
          version === 1
            ? structuredClone(content[0])
            : structuredClone(content),
      });
      if (version === 2)
        notify({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        });
      requests.push({
        label: profile + ":" + (ordinary ? "ordinary-run" : text),
        kind: ordinary ? "ordinary" : "command",
        boundary: "private-acp",
        transport: profile === "v1-http" ? "http" : "websocket",
        agentId: "agent",
        protocolVersion: version,
        method: "session/prompt",
        requestId: "rpc-" + n,
        inputSessionID: sessionId,
        sessionId,
        ...(ordinary ? { phase: text } : {}),
        promptReceipt: {
          requestId: "rpc-" + n,
          sessionId,
          input: structuredClone(input),
          result: version === 1 ? { stopReason: "end_turn" } : { messageId },
          updates,
        },
      });
      const summary = {
        run_id: "run-" + n,
        agent_id: "agent",
        session_id: sessionId,
        principal_id: "owner",
        state: "completed",
        created_at: timestamp,
        updated_at: timestamp,
      };
      items.push(summary);
      all.push({
        run: {
          ...summary,
          input: structuredClone(input),
          execution_snapshot: {
            providerConnectionId: "commands-provider",
            modelProfileId: "commands-model",
            configurationRevision: 1,
            executionRevision: "execution-1",
          },
          terminal_class: "completed",
          executor_state: "quiescent",
          tool_effect_state: ordinary ? "settled" : "none",
          unknown_effect_source: null,
          stop_reason: "end_turn",
          error_class: null,
          usage_measurements: ordinary
            ? [structuredClone(measurement), structuredClone(measurement)]
            : [],
        },
        events,
      });
    }
  }
  return {
    agent_ids: ["agent", "empty-agent"],
    principal_id: "owner",
    requests,
    model_requests: modelRequests,
    agents: [
      { agent_id: "agent", page: { items, next_cursor: null }, all },
      {
        agent_id: "empty-agent",
        page: { items: [], next_cursor: null },
        all: [],
      },
    ],
  };
}

const api = () => assert.equal(typeof inspect, "function");
const row = (e, index = 0) => e.agents[0].all[index];
const ordinary = (e) => row(e, 2);
const reply = (r) =>
  r.events.items.find(
    (event) => event.kind === "agent_message" && event.visible,
  );
const tools = (r) =>
  r.events.items.filter((event) => event.kind === "tool_call");
function changeRun(e, index, values) {
  Object.assign(row(e, index).run, values);
  Object.assign(e.agents[0].page.items[index], values);
}
function moveSession(e, index, sessionId) {
  changeRun(e, index, { session_id: sessionId });
  const request = e.requests[index];
  request.sessionId = sessionId;
  request.inputSessionID = sessionId;
  request.promptReceipt.sessionId = sessionId;
  for (const frame of request.promptReceipt.updates)
    frame.sessionId = sessionId;
}
const expected = {
  status: "passed",
  runs: 8,
  completed: 8,
  failed: 0,
  commands: 6,
  ordinary: 2,
  profiles: 3,
  other_agent_runs: 0,
};

test("Commands admits eight real Runs and original SDK receipts without any Trace metadata", () => {
  api();
  const e = fixture(),
    before = structuredClone(e);
  assert.deepEqual(inspect(e), expected);
  assert.deepEqual(e, before, "business inspection changed raw evidence");
  assert.deepEqual(
    profiles.map(
      (profile) =>
        e.agents[0].page.items.filter(
          (run) => run.session_id === "session-" + profile,
        ).length,
    ),
    [3, 3, 2],
  );
});

test("Commands matches Run identities rather than audit page or detail array order", () => {
  api();
  const e = fixture();
  e.agents[0].page.items.reverse();
  e.agents[0].all.reverse();
  e.requests.reverse();
  assert.deepEqual(inspect(e), expected);
});

test("Commands accepts omitted null unknown-effect projections and ignores invalid Trace metadata", () => {
  api();
  const e = fixture();
  for (const item of e.agents[0].all) delete item.run.unknown_effect_source;
  for (const request of e.requests) {
    request.traceID = "invalid-auxiliary-trace";
    request.connectionTraceID = "invalid-auxiliary-trace";
    request.clientSpanID = "invalid-auxiliary-span";
  }
  for (const model of e.model_requests)
    model.trace_id = "invalid-auxiliary-trace";
  const before = structuredClone(e);
  assert.deepEqual(inspect(e), expected);
  assert.deepEqual(e, before);
});

for (const [name, mutate] of [
  [
    "missing Run",
    (e) => {
      e.agents[0].all.pop();
      e.agents[0].page.items.pop();
    },
  ],
  [
    "duplicate Run",
    (e) => {
      e.agents[0].all[1] = structuredClone(row(e));
    },
  ],
  [
    "extra listed Run",
    (e) => {
      e.agents[0].page.items.push(structuredClone(e.agents[0].page.items[0]));
    },
  ],
  [
    "other Agent executed",
    (e) => {
      e.agents[1].page.items.push(structuredClone(e.agents[0].page.items[0]));
    },
  ],
  ["foreign detail Agent", (e) => changeRun(e, 0, { agent_id: "foreign" })],
  ["foreign Principal", (e) => changeRun(e, 0, { principal_id: "foreign" })],
  ["foreign Session", (e) => changeRun(e, 0, { session_id: "foreign" })],
  [
    "profile Runs split between Sessions",
    (e) => moveSession(e, 3, "another-v2-session"),
  ],
  [
    "profiles sharing an original Session",
    (e) => {
      moveSession(e, 6, "session-v1-ws");
      moveSession(e, 7, "session-v1-ws");
    },
  ],
  [
    "changed list state",
    (e) => {
      e.agents[0].page.items[0].state = "running";
    },
  ],
  [
    "incomplete Run page",
    (e) => {
      e.agents[0].page.next_cursor = "more";
    },
  ],
  [
    "incomplete other Agent page",
    (e) => {
      e.agents[1].page.next_cursor = "more";
    },
  ],
  [
    "incomplete event page",
    (e) => {
      row(e).events.next_cursor = "more";
    },
  ],
  [
    "wrong event stream",
    (e) => {
      row(e).events.stream = "permissions";
    },
  ],
  ["running Run", (e) => changeRun(e, 0, { state: "running" })],
  [
    "failed Run",
    (e) => {
      changeRun(e, 0, { state: "failed" });
      row(e).run.terminal_class = "failed";
    },
  ],
  [
    "wrong terminal class",
    (e) => {
      row(e).run.terminal_class = "cancelled";
    },
  ],
  [
    "nonquiescent executor",
    (e) => {
      row(e).run.executor_state = "unknown";
    },
  ],
  [
    "unknown Tool effect",
    (e) => {
      ordinary(e).run.tool_effect_state = "unknown";
    },
  ],
  [
    "unknown Runtime source",
    (e) => {
      ordinary(e).run.unknown_effect_source = "runtime_mcp";
    },
  ],
  [
    "wrong success reason",
    (e) => {
      row(e).run.stop_reason = "refusal";
    },
  ],
  [
    "success with an error class",
    (e) => {
      row(e).run.error_class = "internal_error";
    },
  ],
  [
    "missing original prompt",
    (e) => {
      e.requests.pop();
    },
  ],
  [
    "duplicate original prompt",
    (e) => {
      e.requests[1] = structuredClone(e.requests[0]);
    },
  ],
  [
    "unrecognized prompt kind",
    (e) => {
      e.requests[0].kind = "ordinary";
    },
  ],
  [
    "wrong profile version",
    (e) => {
      e.requests[3].protocolVersion = 1;
    },
  ],
  [
    "foreign request Agent",
    (e) => {
      e.requests[0].agentId = "foreign";
    },
  ],
  [
    "foreign request Session",
    (e) => {
      e.requests[0].sessionId = "foreign";
    },
  ],
  [
    "foreign prompt receipt Session",
    (e) => {
      e.requests[0].promptReceipt.sessionId = "foreign";
    },
  ],
  [
    "mismatched request identity",
    (e) => {
      e.requests[0].promptReceipt.requestId = "foreign";
    },
  ],
  [
    "missing real request ID",
    (e) => {
      e.requests[0].requestId = "";
    },
  ],
  [
    "wrong v1 result",
    (e) => {
      e.requests[0].promptReceipt.result.stopReason = "refusal";
    },
  ],
  [
    "wrong v2 user ACK",
    (e) => {
      e.requests[3].promptReceipt.result.messageId = "foreign";
    },
  ],
  [
    "missing v2 idle",
    (e) => {
      e.requests[3].promptReceipt.updates.pop();
    },
  ],
  [
    "failed v2 idle",
    (e) => {
      e.requests[3].promptReceipt.updates.at(-1).update.stopReason = "_failed";
    },
  ],
  [
    "foreign notification Session",
    (e) => {
      e.requests[0].promptReceipt.updates[0].sessionId = "foreign";
    },
  ],
  [
    "missing original reply notification",
    (e) => {
      e.requests[0].promptReceipt.updates = [];
    },
  ],
  [
    "changed original reply notification",
    (e) => {
      e.requests[0].promptReceipt.updates[0].update.content.text =
        "counterfeit";
    },
  ],
  [
    "changed actual attachment input",
    (e) => {
      e.requests[0].promptReceipt.input[2].resource.text = "changed";
    },
  ],
  [
    "changed durable attachment input",
    (e) => {
      row(e).run.input[2].resource.text = "changed";
    },
  ],
  [
    "missing durable user message",
    (e) => {
      row(e).events.items.shift();
    },
  ],
  [
    "hidden durable user message",
    (e) => {
      row(e).events.items[0].visible = false;
    },
  ],
  [
    "changed durable user content",
    (e) => {
      row(e).events.items[0].payload.content = [];
    },
  ],
  [
    "wrong durable user identity",
    (e) => {
      row(e).events.items[0].payload.messageId = "foreign";
    },
  ],
  [
    "missing durable assistant",
    (e) => {
      row(e).events.items.pop();
    },
  ],
  [
    "hidden durable assistant",
    (e) => {
      reply(row(e)).visible = false;
    },
  ],
  [
    "changed durable assistant",
    (e) => {
      reply(row(e)).payload.content[0].text = "counterfeit";
    },
  ],
  [
    "duplicate durable message ID",
    (e) => {
      row(e, 1).events.items[0].id = row(e).events.items[0].id;
    },
  ],
  [
    "duplicate Session sequence across Runs",
    (e) => {
      row(e, 1).events.items[0].sequence = row(e).events.items[0].sequence;
    },
  ],
  [
    "unordered event sequence",
    (e) => {
      row(e).events.items.reverse();
    },
  ],
  [
    "command with Tool state",
    (e) => {
      row(e).run.tool_effect_state = "settled";
    },
  ],
  [
    "command with usage measurement",
    (e) => {
      row(e).run.usage_measurements.push(structuredClone(measurement));
    },
  ],
  [
    "command with usage event",
    (e) => {
      row(e).events.items.push({
        id: "unexpected-usage",
        sequence: 3,
        kind: "usage",
        visible: true,
        payload: { kind: "usage", used: 120, size: 8192, measurement },
        created_at: timestamp,
      });
    },
  ],
  [
    "command with model Tool dispatch",
    (e) => {
      reply(row(e)).payload.toolCalls = [
        { id: "extra", name: "bash", arguments: {} },
      ];
    },
  ],
  [
    "command with a durable Tool event",
    (e) => {
      row(e).events.items.push({
        id: "unexpected-tool",
        sequence: 3,
        kind: "tool_call",
        visible: true,
        payload: {
          kind: "tool_call",
          initial: true,
          toolCallId: "extra",
          title: "bash",
          modelName: "bash",
          arguments: {},
          status: "in_progress",
        },
        created_at: timestamp,
      });
    },
  ],
  [
    "command with a Tool notification",
    (e) => {
      e.requests[0].promptReceipt.updates.unshift({
        sessionId: e.requests[0].sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "extra",
          title: "bash",
          status: "in_progress",
        },
      });
    },
  ],
  [
    "missing ordinary Tool terminal",
    (e) => {
      ordinary(e).events.items = ordinary(e).events.items.filter(
        (event) => event !== tools(ordinary(e))[1],
      );
    },
  ],
  [
    "missing ordinary Tool start",
    (e) => {
      ordinary(e).events.items = ordinary(e).events.items.filter(
        (event) => event !== tools(ordinary(e))[0],
      );
    },
  ],
  [
    "failed ordinary Tool",
    (e) => {
      tools(ordinary(e))[1].payload.status = "failed";
    },
  ],
  [
    "changed ordinary Tool identity",
    (e) => {
      tools(ordinary(e))[1].payload.toolCallId = "foreign";
    },
  ],
  [
    "ordinary Tool without settled Run state",
    (e) => {
      ordinary(e).run.tool_effect_state = "none";
    },
  ],
  [
    "ordinary Tool with no stdout effect",
    (e) => {
      tools(ordinary(e))[1].payload.content[0].text = JSON.stringify({
        exit_code: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        effect_state: "settled",
      });
    },
  ],
  [
    "ordinary Tool with an unknown physical effect",
    (e) => {
      const result = JSON.parse(tools(ordinary(e))[1].payload.content[0].text);
      result.effect_state = "unknown";
      tools(ordinary(e))[1].payload.content[0].text = JSON.stringify(result);
    },
  ],
  [
    "ordinary Tool notification failure",
    (e) => {
      e.requests[2].promptReceipt.updates.find(
        (frame) => frame.update.status === "completed",
      ).update.status = "failed";
    },
  ],
  [
    "ordinary missing usage",
    (e) => {
      ordinary(e).run.usage_measurements = [];
      ordinary(e).events.items = ordinary(e).events.items.filter(
        (event) => event.kind !== "usage",
      );
    },
  ],
  [
    "missing model request",
    (e) => {
      e.model_requests.pop();
    },
  ],
  [
    "duplicate model phase/stage",
    (e) => {
      e.model_requests[1] = structuredClone(e.model_requests[0]);
    },
  ],
  [
    "command reached the model",
    (e) => {
      e.model_requests.push({ phase: "/help", stage: "reply" });
    },
  ],
  [
    "unbound model phase",
    (e) => {
      e.model_requests[0].phase = "foreign-baseline";
    },
  ],
]) {
  test("Commands Run business rejects " + name, () => {
    api();
    const e = fixture();
    inspect(e);
    mutate(e);
    assert.throws(() => inspect(e));
  });
}

function reader(e, calls) {
  const responses = new Map();
  for (const agent of e.agents) {
    responses.set(
      "/api/admin/execution-audits?agent_id=" + agent.agent_id + "&limit=100",
      agent.page,
    );
    for (const item of agent.all) {
      const path = "/api/admin/execution-audits/" + item.run.run_id;
      responses.set(path, item.run);
      responses.set(path + "/events?limit=100", item.events);
    }
  }
  return async (path) => {
    calls.push(path);
    assert(responses.has(path), "unexpected audit read: " + path);
    return structuredClone(responses.get(path));
  };
}

function options(e, read, preserve) {
  return {
    agentIds: e.agent_ids,
    principalId: e.principal_id,
    requests: e.requests,
    modelRequests: e.model_requests,
    read,
    preserve,
  };
}

test("Commands collector reads both Agents and all eight detail/event pairs and preserves original evidence", async () => {
  assert.equal(typeof collect, "function");
  const e = fixture(),
    before = structuredClone(e),
    calls = [];
  let saved,
    preserved = 0;
  const requests = [
    ...e.requests,
    {
      kind: "request",
      method: "session/prompt",
      rejection: "access_denied",
      requestId: "denied",
      agentId: "agent",
    },
  ];
  const result = await collect({
    ...options(e, reader(e, calls), (value) => {
      preserved++;
      saved = structuredClone(value);
    }),
    requests,
  });
  const paths = e.agents.flatMap((agent) => [
    "/api/admin/execution-audits?agent_id=" + agent.agent_id + "&limit=100",
    ...agent.all.flatMap((item) => {
      const path = "/api/admin/execution-audits/" + item.run.run_id;
      return [path, path + "/events?limit=100"];
    }),
  ]);
  assert.equal(calls.length, 18);
  assert.deepEqual(new Set(calls), new Set(paths));
  assert.equal(preserved, 1);
  assert.deepEqual(result, e);
  assert.deepEqual(saved, e);
  assert.deepEqual(inspect(result), expected);
  assert.deepEqual(e, before);
});

for (const phase of ["list", "events"]) {
  test(
    "Commands " +
      phase +
      " read interruption preserves the complete observed prefix and still fails",
    async () => {
      assert.equal(typeof collect, "function");
      const e = fixture(),
        calls = [],
        read = reader(e, calls);
      const interrupted = new Error("audit interrupted");
      interrupted.name = "AbortError";
      let saved,
        preserved = 0;
      const path =
        phase === "list"
          ? "/api/admin/execution-audits?agent_id=agent&limit=100"
          : "/api/admin/execution-audits/run-1/events?limit=100";
      await assert.rejects(
        collect(
          options(
            e,
            async (target) => {
              if (target === path) throw interrupted;
              return read(target);
            },
            (value) => {
              preserved++;
              saved = structuredClone(value);
            },
          ),
        ),
        (error) => error === interrupted,
      );
      assert.equal(preserved, 1);
      assert.deepEqual(saved.requests, e.requests);
      assert.deepEqual(saved.model_requests, e.model_requests);
      assert.equal(saved.agents.length, 1);
      if (phase === "list") {
        assert.equal(saved.agents[0].page, null);
        assert.deepEqual(saved.agents[0].all, []);
      } else {
        assert.deepEqual(saved.agents[0].page, e.agents[0].page);
        assert.equal(saved.agents[0].all.length, 2);
        assert.deepEqual(saved.agents[0].all[0], row(e));
        assert.deepEqual(saved.agents[0].all[1].run, row(e, 1).run);
        assert.equal(saved.agents[0].all[1].events, null);
      }
    },
  );
}

test("Commands invalid audit business remains a failure after its raw receipt is preserved", async () => {
  assert.equal(typeof collect, "function");
  const e = fixture();
  changeRun(e, 0, { state: "failed" });
  row(e).run.terminal_class = "failed";
  let saved;
  await assert.rejects(
    collect(
      options(e, reader(e, []), (value) => {
        saved = structuredClone(value);
      }),
    ),
  );
  assert(saved, "failed audit business was not archived");
  assert.equal(saved.agents[0].all[0].run.state, "failed");
});

test("Commands read and archive failures retain both original errors", async () => {
  assert.equal(typeof collect, "function");
  const e = fixture();
  const readFailure = new Error("audit unavailable");
  const archiveFailure = new Error("business archive failed");
  let preserved = false;
  await assert.rejects(
    collect(
      options(
        e,
        async () => {
          throw readFailure;
        },
        () => {
          preserved = true;
          throw archiveFailure;
        },
      ),
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], readFailure);
      assert.equal(error.errors[1], archiveFailure);
      return true;
    },
  );
  assert.equal(preserved, true);
});

test("Commands collector awaits a held archive and archive failure cannot become business success", async () => {
  assert.equal(typeof collect, "function");
  const e = fixture(),
    calls = [];
  const archiveFailure = new Error("business archive failed");
  let release,
    entered,
    finished = false;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const result = collect(
    options(e, reader(e, calls), async () => {
      entered();
      await held;
      throw archiveFailure;
    }),
  );
  const joined = result.then(
    (value) => {
      finished = true;
      return { value };
    },
    (error) => {
      finished = true;
      return { error };
    },
  );
  try {
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 18);
    assert.equal(
      finished,
      false,
      "collector returned before business archive joined",
    );
    release();
    assert.equal((await joined).error, archiveFailure);
  } finally {
    release();
    await joined;
  }
});
