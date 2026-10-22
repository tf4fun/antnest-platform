import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { caseFor as fileCaseFor } from "../e2e/acp-files/model.mjs";
import {
  privateCanary,
  promptRunAuditRoutes,
  promptRunAuditsFixture,
  promptRunAuditSummary,
  runSummary,
} from "./acp-run-audits.fixture.mjs";

const url = new URL("./acp-run-audits.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    (error.url !== url.href && !error.message.includes(url.pathname))
  )
    throw error;
  return {};
});
function requireAPI(name) {
  assert.equal(typeof implementation[name], "function", name + " is required");
  return implementation[name];
}
const inspect = (value) => requireAPI("inspectPromptRunAudits")(value);
const collect = (input) => requireAPI("collectPromptRunAudits")(input);
const requestFor = (f, phase) => f.requests.find((row) => row.phase === phase);
const savedFor = (f, phase) =>
  f.agents
    .flatMap((agent) => agent.all)
    .find(({ run }) => run.input[0]?.text === phase);
const syncSummaries = (f) => {
  for (const agent of f.agents)
    agent.page.items = agent.all.map(({ run }) => runSummary(run));
};
const dispatches = (saved) =>
  saved.events.items
    .filter((event) => event.kind === "agent_message")
    .flatMap((event) => event.payload.toolCalls ?? []);
const toolEvents = (saved) =>
  saved.events.items.filter((event) => event.kind === "tool_call");
const toolUpdates = (request) =>
  request.promptReceipt.updates.filter((frame) =>
    ["tool_call", "tool_call_update"].includes(frame.update.sessionUpdate),
  );
function rejectMutations(cases) {
  requireAPI("inspectPromptRunAudits");
  assert.deepEqual(inspect(promptRunAuditsFixture()), promptRunAuditSummary);
  for (const [label, mutate] of cases) {
    const f = promptRunAuditsFixture();
    mutate(f);
    assert.throws(() => inspect(f), label);
  }
}
function rewriteToolId(f, phase, oldId, newId) {
  for (const call of dispatches(savedFor(f, phase)))
    if (call.id === oldId) call.id = newId;
  for (const event of toolEvents(savedFor(f, phase)))
    if (event.payload.toolCallId === oldId) event.payload.toolCallId = newId;
  for (const frame of toolUpdates(requestFor(f, phase)))
    if (frame.update.toolCallId === oldId) frame.update.toolCallId = newId;
}

test("original public Audit DTOs bind all prompts without Trace and return only safe counts", () => {
  const f = promptRunAuditsFixture(),
    before = structuredClone(f);
  assert.equal(
    new Set(f.requests.map((row) => row.promptReceipt.requestId)).size <
      f.requests.length,
    true,
    "SDK IDs are scoped to their original connection, not globally unique",
  );
  for (const ready of f.ready_agents) {
    for (const field of ["organization_id", "access_revision"])
      assert(!Object.hasOwn(ready, field));
    for (const field of ["runtime_execution_id", "mcp_endpoint"])
      assert(!Object.hasOwn(ready.runtime, field));
  }
  for (const agent of f.agents)
    for (const { run } of agent.all)
      for (const field of [
        "runtime",
        "organizationId",
        "accessRevision",
        "clientMcpRevisionId",
      ])
        assert(!Object.hasOwn(run.execution_snapshot, field));
  const result = inspect(f);
  assert.deepEqual(result, promptRunAuditSummary);
  assert.deepEqual(f, before, "inspection changed original receipts");
  const text = JSON.stringify(result);
  assert(!text.includes(privateCanary));
  assert(
    !/"(?:requests|ready_agents|events|principal_id|input|execution_snapshot)":/u.test(
      text,
    ),
  );
});

test("Run auditing is not fixed to one suite's Agent or Run count", () => {
  const f = promptRunAuditsFixture();
  const saved = savedFor(f, "v1-read");
  f.ready_agents = [f.ready_agents[0]];
  f.requests = [requestFor(f, "v1-read")];
  f.agents = [
    {
      agent_id: f.ready_agents[0].agent_id,
      page: { items: [runSummary(saved.run)], next_cursor: null },
      all: [saved],
    },
  ];
  assert.deepEqual(inspect(f), {
    status: "passed",
    agents: 1,
    runs: 1,
    completed: 1,
    tool_calls: 1,
  });
});

test("v1 suppressed echo, single terminal local Plan, real progress and sequence gaps remain valid", () => {
  const f = promptRunAuditsFixture();
  const v1 = requestFor(f, "v1-read");
  assert(
    !v1.promptReceipt.updates.some((frame) =>
      frame.update.sessionUpdate.startsWith("user_message"),
    ),
  );
  const progress = toolEvents(savedFor(f, "v1-read"));
  assert.deepEqual(
    progress.map((event) => event.payload.status),
    ["in_progress", "in_progress", "completed"],
  );
  const local = toolEvents(savedFor(f, "v2-create"));
  assert.equal(local.length, 1);
  assert.equal(local[0].payload.initial, true);
  assert.equal(local[0].payload.status, "completed");
  assert(
    f.agents[0].all[0].events.items.some(
      (event, index, rows) =>
        index > 0 && event.sequence > rows[index - 1].sequence + 1,
    ),
  );
  assert.deepEqual(inspect(f), promptRunAuditSummary);
});

test("v2 original streamed chunks use responseId and one content block without requiring a whole-message update", () => {
  const f = promptRunAuditsFixture();
  const request = requestFor(f, "v2-fork"),
    saved = savedFor(f, request.phase);
  const reply = saved.events.items.at(-1);
  const responseId = createHash("sha256")
    .update(JSON.stringify([saved.run.run_id, 0]))
    .digest("hex");
  reply.payload.responseId = responseId;
  reply.payload.content = [{ type: "text", text: request.phase + " " }];
  const continuation = structuredClone(reply);
  continuation.id = "message_" + "f".repeat(32);
  continuation.sequence += 3;
  continuation.payload.messageId = continuation.id;
  continuation.payload.content = [{ type: "text", text: "verified" }];
  saved.events.items.push(continuation);
  const updates = request.promptReceipt.updates;
  const position = updates.findIndex(
    (frame) => frame.update.sessionUpdate === "agent_message",
  );
  assert(position >= 0);
  // v2 sendEvent() projects responseId into messageId for each raw chunk. The
  // stored payload.messageId remains the independently persisted event ID.
  updates.splice(
    position,
    1,
    ...[reply, continuation].map(({ payload }) => ({
      sessionId: request.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: responseId,
        content: structuredClone(payload.content[0]),
      },
    })),
  );
  const before = structuredClone(f);
  assert.deepEqual(inspect(f), promptRunAuditSummary);
  assert.deepEqual(f, before);
});

test("Files terminal may append its separately verified diff after the original wrapped Tool content", () => {
  const f = promptRunAuditsFixture({ filePhase: "v1-create" });
  const item = fileCaseFor("v1-create"),
    saved = savedFor(f, "v1-create");
  const terminal = toolEvents(saved).at(-1),
    request = requestFor(f, "v1-create");
  terminal.payload.file = {
    path: item.path,
    change: structuredClone(item.change),
  };
  const live = toolUpdates(request).at(-1).update;
  live.locations = [{ path: item.path }];
  live.content.push({
    type: "diff",
    path: item.path,
    oldText: item.change.before,
    newText: item.change.after,
  });
  const before = structuredClone(f);
  assert.deepEqual(inspect(f), promptRunAuditSummary);
  assert.deepEqual(f, before);
  // Generic auditing compares only the wrapped result items; accepting the
  // independent diff must not make the original Tool body optional.
  const wrong = structuredClone(f);
  toolUpdates(requestFor(wrong, "v1-create"))
    .at(-1)
    .update.content.find((content) => content.type === "content").content.text =
    privateCanary;
  assert.throws(() => inspect(wrong));
});

test("original Principal, Agent, Session, input and public execution revision cannot be substituted", () => {
  rejectMutations([
    [
      "missing Principal",
      (f) => {
        f.principal_id = "";
      },
    ],
    [
      "foreign Principal",
      (f) => {
        savedFor(f, "v1-read").run.principal_id = "foreign";
        syncSummaries(f);
      },
    ],
    [
      "foreign Agent",
      (f) => {
        savedFor(f, "v1-read").run.agent_id = f.ready_agents[1].agent_id;
        syncSummaries(f);
      },
    ],
    [
      "foreign Session",
      (f) => {
        savedFor(f, "v1-read").run.session_id = "foreign";
        syncSummaries(f);
      },
    ],
    [
      "changed input",
      (f) => {
        savedFor(f, "v1-read").run.input[0].text = privateCanary;
      },
    ],
    [
      "old public revision",
      (f) => {
        savedFor(f, "v2-execute").run.execution_snapshot.executionRevision =
          "old";
      },
    ],
    [
      "missing public revision",
      (f) => {
        delete savedFor(f, "v1-read").run.execution_snapshot.executionRevision;
      },
    ],
    [
      "ready receipt changed",
      (f) => {
        f.ready_agents[1].executable_execution_revision = "old";
      },
    ],
    [
      "missing ready receipt",
      (f) => {
        f.ready_agents.pop();
      },
    ],
  ]);
});

test("every original Prompt maps to exactly one Run and every Agent list is complete", () => {
  rejectMutations([
    [
      "missing Prompt",
      (f) => {
        f.requests.pop();
      },
    ],
    [
      "duplicate Prompt",
      (f) => {
        f.requests.push(structuredClone(f.requests[0]));
      },
    ],
    [
      "missing Run",
      (f) => {
        f.agents[0].all.pop();
        syncSummaries(f);
      },
    ],
    [
      "duplicate Run",
      (f) => {
        f.agents[0].all.push(structuredClone(f.agents[0].all[0]));
        syncSummaries(f);
      },
    ],
    [
      "extra unrequested Run",
      (f) => {
        const extra = structuredClone(f.agents[0].all[0]);
        extra.run.run_id = "unrequested-run";
        extra.run.input = [{ type: "text", text: "unrequested-prompt" }];
        f.agents[0].all.push(extra);
        syncSummaries(f);
      },
    ],
    [
      "missing Agent page",
      (f) => {
        f.agents.pop();
      },
    ],
    [
      "foreign Agent page",
      (f) => {
        f.agents[0].agent_id = "foreign";
      },
    ],
    [
      "detail absent from page",
      (f) => {
        f.agents[0].page.items.pop();
      },
    ],
    [
      "summary differs from detail",
      (f) => {
        f.agents[0].page.items[0].state = "running";
      },
    ],
  ]);
});

test("missing original Prompt receipts or protocol identity cannot become durable success", () => {
  rejectMutations([
    [
      "missing receipt",
      (f) => {
        delete f.requests[0].promptReceipt;
      },
    ],
    [
      "missing request ID",
      (f) => {
        f.requests[0].promptReceipt.requestId = "";
      },
    ],
    [
      "wrong original request ID",
      (f) => {
        f.requests[0].promptReceipt.requestId = "stale";
      },
    ],
    [
      "wrong protocol",
      (f) => {
        f.requests[0].protocolVersion = 3;
      },
    ],
    [
      "missing live updates",
      (f) => {
        delete f.requests[0].promptReceipt.updates;
      },
    ],
    [
      "wrong v1 completion",
      (f) => {
        f.requests[0].promptReceipt.result.stopReason = "max_turn_requests";
      },
    ],
    [
      "changed receipt input",
      (f) => {
        f.requests[0].promptReceipt.input = [];
      },
    ],
  ]);
});

test("complete pages and durable event identity/order remain blocking without contiguous sequences", () => {
  rejectMutations([
    [
      "Run continuation",
      (f) => {
        f.agents[0].page.next_cursor = "unread";
      },
    ],
    [
      "event continuation",
      (f) => {
        savedFor(f, "v2-create").events.next_cursor = "unread";
      },
    ],
    [
      "wrong event stream",
      (f) => {
        savedFor(f, "v2-execute").events.stream = "permissions";
      },
    ],
    [
      "missing events",
      (f) => {
        delete savedFor(f, "v1-read").events;
      },
    ],
    [
      "duplicate event ID",
      (f) => {
        const e = savedFor(f, "v1-read").events.items;
        e[1].id = e[0].id;
      },
    ],
    [
      "duplicate sequence",
      (f) => {
        const e = savedFor(f, "v1-read").events.items;
        e[1].sequence = e[0].sequence;
      },
    ],
    [
      "reversed event sequence",
      (f) => {
        savedFor(f, "v1-read").events.items.reverse();
      },
    ],
  ]);
});

test("only completed quiescent Runs with known settled or none effects pass", () => {
  rejectMutations([
    ...["running", "failed", "cancelled", "unresolved"].map((state) => [
      state,
      (f) => {
        const run = savedFor(f, "v1-read").run;
        run.state = state;
        run.terminal_class = state;
        syncSummaries(f);
      },
    ]),
    [
      "wrong terminal class",
      (f) => {
        savedFor(f, "v1-read").run.terminal_class = "failed";
      },
    ],
    [
      "still executing",
      (f) => {
        savedFor(f, "v2-execute").run.executor_state = "running";
      },
    ],
    [
      "unknown effect",
      (f) => {
        savedFor(f, "v1-read").run.tool_effect_state = "unknown";
      },
    ],
    [
      "missing effect",
      (f) => {
        delete savedFor(f, "v2-create").run.tool_effect_state;
      },
    ],
    [
      "wrong stop reason",
      (f) => {
        savedFor(f, "v1-read").run.stop_reason = "max_turn_requests";
      },
    ],
    [
      "error class",
      (f) => {
        savedFor(f, "v1-read").run.error_class = "controlled-failure";
      },
    ],
    [
      "unknown source",
      (f) => {
        savedFor(f, "v1-read").run.unknown_effect_source = "runtime_mcp";
      },
    ],
  ]);
});

test("v2 ACK identifies the original persisted user message rather than the Run", () => {
  rejectMutations([
    [
      "ACK replaced by Run ID",
      (f) => {
        requestFor(f, "v2-create").promptReceipt.result.messageId = savedFor(
          f,
          "v2-create",
        ).run.run_id;
      },
    ],
    [
      "missing ACK",
      (f) => {
        requestFor(f, "v2-execute").promptReceipt.result = {};
      },
    ],
    [
      "live user ID changed",
      (f) => {
        requestFor(f, "v2-create").promptReceipt.updates.find(
          (frame) => frame.update.sessionUpdate === "user_message",
        ).update.messageId = "foreign";
      },
    ],
    [
      "stored user changed",
      (f) => {
        savedFor(f, "v2-create").events.items.find(
          (event) => event.kind === "user_message",
        ).payload.content = [];
      },
    ],
    [
      "missing stored user",
      (f) => {
        const saved = savedFor(f, "v1-read");
        saved.events.items = saved.events.items.filter(
          (event) => event.kind !== "user_message",
        );
      },
    ],
  ]);
});

test("assistant persistence and original live reply must both match the requested phase", () => {
  rejectMutations([
    [
      "missing durable reply",
      (f) => {
        savedFor(f, "v1-read").events.items.pop();
      },
    ],
    [
      "changed durable reply",
      (f) => {
        savedFor(f, "v1-read").events.items.at(-1).payload.content[0].text =
          privateCanary;
      },
    ],
    [
      "changed v1 live reply",
      (f) => {
        requestFor(f, "v1-read").promptReceipt.updates.find(
          (frame) => frame.update.sessionUpdate === "agent_message_chunk",
        ).update.content.text = privateCanary;
      },
    ],
    [
      "changed v2 live reply",
      (f) => {
        requestFor(f, "v2-create").promptReceipt.updates.find(
          (frame) => frame.update.sessionUpdate === "agent_message",
        ).update.content[0].text = privateCanary;
      },
    ],
    [
      "same wrong durable and live reply",
      (f) => {
        savedFor(f, "v2-create").events.items.at(-1).payload.content[0].text =
          privateCanary;
        requestFor(f, "v2-create").promptReceipt.updates.find(
          (frame) => frame.update.sessionUpdate === "agent_message",
        ).update.content[0].text = privateCanary;
      },
    ],
  ]);
});

test("durable model dispatches match the existing Tool oracle without missing or extra calls", () => {
  rejectMutations([
    [
      "wrong Tool name",
      (f) => {
        dispatches(savedFor(f, "v1-read"))[0].name = "write";
      },
    ],
    [
      "wrong arguments",
      (f) => {
        dispatches(savedFor(f, "v1-read"))[0].arguments.path = "another-file";
      },
    ],
    [
      "missing expected oracle",
      (f) => {
        delete requestFor(f, "v1-read").expectedTools;
      },
    ],
    [
      "wrong expected oracle",
      (f) => {
        requestFor(f, "v2-execute").expectedTools.reverse();
      },
    ],
    [
      "missing dispatch",
      (f) => {
        savedFor(f, "v2-create")
          .events.items.find((event) => event.payload.toolCalls)
          ?.payload.toolCalls.pop();
      },
    ],
    [
      "extra dispatch",
      (f) => {
        const row = savedFor(f, "v2-execute").events.items.find(
          (event) => event.payload.toolCalls,
        );
        row.payload.toolCalls.push({
          id: "unexpected",
          name: "read",
          arguments: {},
        });
      },
    ],
    [
      "Tool in a no-Tool Run",
      (f) => {
        const saved = savedFor(f, "v2-fork");
        const reply = saved.events.items.at(-1);
        reply.payload.toolCalls = [
          { id: "unexpected", name: "read", arguments: {} },
        ];
      },
    ],
  ]);
});

test("coherent Tool IDs must still be normalized from the actual Run, model step and provider phase", () => {
  rejectMutations([
    [
      "bare provider ID in every receipt",
      (f) => {
        const phase = "v1-read",
          old = dispatches(savedFor(f, phase))[0].id;
        rewriteToolId(f, phase, old, phase);
      },
    ],
    [
      "another Run's normalized ID",
      (f) => {
        const phase = "v1-read",
          old = dispatches(savedFor(f, phase))[0].id;
        rewriteToolId(
          f,
          phase,
          old,
          createHash("sha256")
            .update(JSON.stringify(["foreign-run", 0, phase]))
            .digest("hex"),
        );
      },
    ],
    [
      "step one reused step zero",
      (f) => {
        const phase = "v2-execute",
          calls = dispatches(savedFor(f, phase));
        rewriteToolId(f, phase, calls[1].id, calls[0].id);
      },
    ],
    [
      "provider phase changed coherently",
      (f) => {
        const phase = "v1-read",
          saved = savedFor(f, phase),
          old = dispatches(saved)[0].id;
        rewriteToolId(
          f,
          phase,
          old,
          createHash("sha256")
            .update(JSON.stringify([saved.run.run_id, 0, "another-phase"]))
            .digest("hex"),
        );
      },
    ],
  ]);
});

test("durable Tool lifecycle order and original live status, input and content must agree", () => {
  rejectMutations([
    [
      "foreign live Session",
      (f) => {
        requestFor(f, "v1-read").promptReceipt.updates[0].sessionId = "foreign";
      },
    ],
    [
      "foreign live Tool ID",
      (f) => {
        toolUpdates(requestFor(f, "v1-read"))[0].update.toolCallId = "foreign";
      },
    ],
    [
      "live status differs",
      (f) => {
        toolUpdates(requestFor(f, "v1-read")).at(-1).update.status = "failed";
      },
    ],
    [
      "live input differs",
      (f) => {
        toolUpdates(requestFor(f, "v1-read"))[0].update.rawInput.path =
          "foreign";
      },
    ],
    [
      "live content differs",
      (f) => {
        toolUpdates(requestFor(f, "v1-read")).at(
          -1,
        ).update.content[0].content.text = privateCanary;
      },
    ],
    [
      "missing terminal",
      (f) => {
        const saved = savedFor(f, "v1-read"),
          terminal = toolEvents(saved).at(-1);
        saved.events.items = saved.events.items.filter(
          (event) => event !== terminal,
        );
      },
    ],
    [
      "progress after terminal",
      (f) => {
        const [start, progress, terminal] = toolEvents(savedFor(f, "v1-read"));
        const value = terminal.payload;
        terminal.payload = progress.payload;
        progress.payload = value;
        const live = toolUpdates(requestFor(f, "v1-read"));
        const update = live[2].update;
        live[2].update = live[1].update;
        live[1].update = update;
        assert.equal(start.payload.status, "in_progress");
      },
    ],
    [
      "local Plan lost its initial terminal",
      (f) => {
        toolEvents(savedFor(f, "v2-create"))[0].payload.initial = false;
      },
    ],
  ]);
});

const outcome = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Run audit test gate timed out")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function atGate(gate, task) {
  const value = await within(
    Promise.race([gate.promise.then(() => true), task.then(() => false)]),
  );
  assert.equal(
    value,
    true,
    "collector settled before its held operation entered",
  );
}
function environment() {
  const source = promptRunAuditsFixture();
  const routes = promptRunAuditRoutes(source),
    calls = [],
    preserved = [];
  let active = 0;
  const read = async (path) => {
    assert.equal(active, 0, "Audit reads overlapped");
    const expected = routes[calls.length];
    assert.equal(
      path,
      expected?.path,
      "collector read a different original Audit",
    );
    calls.push(path);
    active++;
    try {
      await Promise.resolve();
      return expected.body;
    } finally {
      active--;
    }
  };
  const preserve = (evidence, failure) => {
    preserved.push({ evidence, failure });
    return Promise.resolve();
  };
  return {
    source,
    routes,
    calls,
    preserved,
    read,
    preserve,
    input: {
      read,
      readyAgents: source.ready_agents,
      requests: source.requests,
      principalId: source.principal_id,
      preserve,
    },
  };
}

test("collector reads each original Agent list, detail and complete event page serially and preserves once", async () => {
  requireAPI("collectPromptRunAudits");
  const f = environment(),
    before = structuredClone(f.source);
  const result = await collect(f.input);
  assert.deepEqual(
    f.calls,
    f.routes.map((route) => route.path),
  );
  assert.equal(f.calls.length, 12);
  assert.deepEqual(result, f.source);
  assert.deepEqual(inspect(result), promptRunAuditSummary);
  assert.deepEqual(f.source, before);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].evidence, result);
  assert.equal(f.preserved[0].failure, undefined);
});

test("collector cannot finish or dispatch another Audit while its actual read is held", async () => {
  requireAPI("collectPromptRunAudits");
  const f = environment(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let settled = false;
  const task = outcome(
    collect({
      ...f.input,
      read: async (path) => {
        const body = await f.read(path);
        if (path === f.routes[0].path) {
          entered.resolve();
          await release.promise;
        }
        return body;
      },
    }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await atGate(entered, task);
    await turn();
    assert.equal(settled, false);
    assert.deepEqual(f.calls, [f.routes[0].path]);
    assert.equal(f.preserved.length, 0);
    release.resolve();
    const result = await within(task);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value, f.source);
  } finally {
    release.resolve();
    await within(task);
  }
});

test("collector joins the actual private archive before returning successful evidence", async () => {
  requireAPI("collectPromptRunAudits");
  const f = environment(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let settled = false;
  const task = outcome(
    collect({
      ...f.input,
      preserve: async (evidence, failure) => {
        await f.preserve(evidence, failure);
        entered.resolve();
        await release.promise;
      },
    }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await atGate(entered, task);
    await turn();
    assert.equal(settled, false);
    assert.equal(f.calls.length, f.routes.length);
    assert.equal(f.preserved.length, 1);
    release.resolve();
    assert.equal((await within(task)).error, undefined);
  } finally {
    release.resolve();
    await within(task);
  }
});

test("read failure retains the original error and partial original responses without invented later evidence", async () => {
  requireAPI("collectPromptRunAudits");
  const f = environment(),
    failure = new Error("original Audit event request failed");
  const result = await outcome(
    collect({
      ...f.input,
      read: (path) => {
        if (path === f.routes[2].path) {
          f.calls.push(path);
          return Promise.reject(failure);
        }
        return f.read(path);
      },
    }),
  );
  assert.equal(result.error, failure);
  assert.deepEqual(
    f.calls,
    f.routes.slice(0, 3).map((route) => route.path),
  );
  assert.equal(f.preserved.length, 1);
  const partial = f.preserved[0].evidence;
  assert.equal(f.preserved[0].failure, failure);
  assert.deepEqual(partial.ready_agents, f.source.ready_agents);
  assert.deepEqual(partial.requests, f.source.requests);
  assert.deepEqual(partial.agents[0].page, f.source.agents[0].page);
  assert.deepEqual(partial.agents[0].all[0].run, f.source.agents[0].all[0].run);
  assert(partial.agents[0].all[0].events == null);
  assert(
    partial.agents[1]?.page == null,
    "unread Agent became a complete Audit",
  );
});

test("failed business inspection and truncated list pages are archived and remain hard failures", async () => {
  requireAPI("collectPromptRunAudits");
  for (const mode of ["inspection", "pagination"]) {
    const f = environment();
    if (mode === "inspection")
      savedFor(f.source, "v1-read").run.executor_state = "running";
    else f.source.agents[0].page.next_cursor = "unread";
    const result = await outcome(collect(f.input));
    assert(result.error instanceof Error);
    assert.equal(result.value, undefined);
    assert.equal(f.preserved.length, 1);
    assert.equal(f.preserved[0].failure, result.error);
    assert.deepEqual(
      f.preserved[0].evidence.agents[0].page,
      f.source.agents[0].page,
    );
    if (mode === "pagination") assert.deepEqual(f.calls, [f.routes[0].path]);
  }
});

test("archive failure is hard even after every Audit and business assertion succeeded", async () => {
  requireAPI("collectPromptRunAudits");
  const f = environment(),
    failure = new Error("original private archive failed");
  const result = await outcome(
    collect({
      ...f.input,
      preserve: async (evidence, error) => {
        await f.preserve(evidence, error);
        throw failure;
      },
    }),
  );
  assert.equal(result.error, failure);
  assert.equal(result.value, undefined);
  assert.equal(f.calls.length, f.routes.length);
  assert.equal(f.preserved.length, 1);
  assert.equal(f.preserved[0].failure, undefined);
});

test("read plus held archive failure joins both and retains both original errors in order", async () => {
  requireAPI("collectPromptRunAudits");
  const f = environment(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const readError = new Error("original Audit read failed"),
    archiveError = new Error("original archive failed");
  let settled = false;
  const task = outcome(
    collect({
      ...f.input,
      read: () => Promise.reject(readError),
      preserve: async (evidence, error) => {
        await f.preserve(evidence, error);
        entered.resolve();
        await release.promise;
        throw archiveError;
      },
    }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await atGate(entered, task);
    await turn();
    assert.equal(settled, false);
    assert.equal(f.preserved.length, 1);
    assert.equal(f.preserved[0].failure, readError);
    release.resolve();
    const result = await within(task);
    assert(result.error instanceof AggregateError);
    assert.deepEqual(result.error.errors, [readError, archiveError]);
    assert.equal(result.value, undefined);
  } finally {
    release.resolve();
    await within(task);
  }
});
