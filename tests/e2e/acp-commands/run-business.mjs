import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { assertOrdinaryTool, transcript } from "./evidence.mjs";

const profiles = ["v1-ws", "v2-ws", "v1-http"];
const summaryFields = [
  "run_id",
  "session_id",
  "agent_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const nonempty = (value, message) =>
  assert(typeof value === "string" && value.trim().length > 0, message);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function completePage(page, name) {
  assert(Array.isArray(page?.items), name + " items required");
  assert(page.items.length <= 100, name + " exceeds the requested page");
  assert.equal(page.next_cursor, null, "complete " + name + " required");
}

function originalRequests(evidence) {
  assert(Array.isArray(evidence.requests));
  assert.equal(evidence.requests.length, 8, "eight original prompts required");
  const expected = [],
    sessions = new Set();
  for (const profile of profiles) {
    const version = profile === "v2-ws" ? 2 : 1;
    const steps = ["/help", "/帮助"];
    if (profile !== "v1-http") steps.push("ordinary-run");
    const profileSessions = new Set();
    for (const step of steps) {
      const matches = evidence.requests.filter(
        (request) => request.label === profile + ":" + step,
      );
      assert.equal(matches.length, 1, "missing or duplicate original prompt");
      const request = matches[0],
        receipt = request.promptReceipt;
      const ordinary = step === "ordinary-run";
      assert.equal(request.kind, ordinary ? "ordinary" : "command");
      assert.equal(request.method, "session/prompt");
      assert.equal(request.boundary, "private-acp");
      assert.equal(request.protocolVersion, version);
      assert.equal(
        request.transport,
        profile === "v1-http" ? "http" : "websocket",
      );
      assert.equal(request.agentId, evidence.agent_ids[0]);
      nonempty(request.sessionId, "original Session required");
      nonempty(request.requestId, "actual SDK request identity required");
      assert.equal(request.inputSessionID, request.sessionId);
      assert.equal(receipt?.sessionId, request.sessionId);
      assert.equal(receipt.requestId, request.requestId);
      assert(Array.isArray(receipt.input) && receipt.input.length > 0);
      assert(
        receipt.input.every(
          (block) => object(block) && typeof block.type === "string",
        ),
      );
      const text = receipt.input.find(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim(),
      )?.text;
      assert.equal(text, ordinary ? "v" + version + "-baseline" : step);
      if (ordinary) assert.equal(request.phase, text);
      if (version === 1)
        assert.deepEqual(receipt.result, { stopReason: "end_turn" });
      else {
        nonempty(
          receipt.result?.messageId,
          "v2 durable user identity required",
        );
        assert.deepEqual(receipt.result, {
          messageId: receipt.result.messageId,
        });
      }
      assert(
        receipt.error === undefined || receipt.error === null,
        "successful prompt contains a failure receipt",
      );
      assert(Array.isArray(receipt.updates) && receipt.updates.length > 0);
      for (const frame of receipt.updates) {
        assert.equal(
          frame.sessionId,
          request.sessionId,
          "foreign prompt notification",
        );
        nonempty(
          frame.update?.sessionUpdate,
          "original Session notification required",
        );
      }
      const states = receipt.updates.filter(
        (frame) => frame.update.sessionUpdate === "state_update",
      );
      assert.deepEqual(
        states,
        version === 1
          ? []
          : [
              {
                sessionId: request.sessionId,
                update: { sessionUpdate: "state_update", state: "running" },
              },
              {
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "state_update",
                  state: "idle",
                  stopReason: "end_turn",
                },
              },
            ],
        "prompt did not report its successful protocol completion",
      );
      profileSessions.add(request.sessionId);
      expected.push({ request, receipt, profile, version, ordinary, text });
    }
    assert.equal(
      profileSessions.size,
      1,
      "profile prompts changed original Session",
    );
    const sessionId = [...profileSessions][0];
    assert(!sessions.has(sessionId), "profiles share an original Session");
    sessions.add(sessionId);
  }
  assert.equal(sessions.size, 3);
  return expected;
}

function inspectModelRequests(evidence, expected) {
  assert(
    Array.isArray(evidence.model_requests),
    "original model requests required",
  );
  assert.equal(
    evidence.model_requests.length,
    4,
    "four model requests required",
  );
  const phases = new Set(
    expected.filter((item) => item.ordinary).map((item) => item.text),
  );
  assert.equal(phases.size, 2);
  for (const request of evidence.model_requests)
    assert(
      phases.has(request.phase),
      "model request is not bound to an ordinary prompt",
    );
  for (const phase of phases)
    assert.deepEqual(
      evidence.model_requests
        .filter((request) => request.phase === phase)
        .map((request) => request.stage),
      ["tool", "reply"],
      "missing, repeated or unexpected model request",
    );
}

function inspectEvents(events, run, eventIds, sessionSequences) {
  completePage(events, "execution event page");
  assert.equal(events.stream, "execution");
  let previous = 0;
  for (const event of events.items) {
    nonempty(event.id, "persisted event identity required");
    assert(!eventIds.has(event.id), "duplicate persisted event identity");
    eventIds.add(event.id);
    assert(
      Number.isSafeInteger(event.sequence) && event.sequence > previous,
      "unordered execution events",
    );
    assert(
      !sessionSequences.has(event.sequence),
      "duplicate Session event sequence",
    );
    sessionSequences.add(event.sequence);
    previous = event.sequence;
    assert.equal(typeof event.visible, "boolean");
    assert(
      Number.isFinite(Date.parse(event.created_at)),
      "invalid event timestamp",
    );
    nonempty(event.kind, "persisted event kind required");
    assert.equal(
      event.payload?.kind,
      event.kind,
      "persisted event kind changed",
    );
    if (
      ["user_message", "agent_message", "agent_thought"].includes(event.kind)
    ) {
      assert.equal(
        event.payload.messageId,
        event.id,
        "persisted message identity changed",
      );
      assert(Array.isArray(event.payload.content));
    }
  }
  const users = events.items.filter((event) => event.kind === "user_message");
  assert.equal(users.length, 1, "one persisted user message required");
  assert.equal(users[0].visible, true);
  assert.deepEqual(
    users[0].payload.content,
    run.input,
    "durable user prompt changed",
  );
  return users[0];
}

function inspectReply(events, expected) {
  const messages = events.items.filter(
    (event) => event.kind === "agent_message",
  );
  for (const event of messages)
    assert.equal(
      event.visible,
      event.payload.content.length > 0,
      "assistant visibility changed",
    );
  const visible = messages.filter((event) => event.visible);
  assert.equal(visible.length, 1, "one persisted assistant reply required");
  const content = visible[0].payload.content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  nonempty(content[0].text, "persisted assistant text required");
  if (expected.ordinary)
    assert.equal(content[0].text, expected.text + " verified");
  else
    assert(
      content[0].text.includes(
        expected.text === "/帮助" ? "可用命令" : "Available commands",
      ),
      "persisted help reply is missing",
    );
  const original = transcript(
    expected.receipt.updates,
    expected.request.sessionId,
  );
  assert.deepEqual(
    original.filter((message) => message.role === "assistant"),
    [{ role: "assistant", content }],
    "persisted reply differs from original SDK notifications",
  );
  return visible[0];
}

function inspectUserReceipt(expected, user) {
  const { receipt, request, version } = expected;
  const users = receipt.updates.filter((frame) =>
    ["user_message", "user_message_chunk"].includes(frame.update.sessionUpdate),
  );
  if (version === 2) {
    assert.equal(
      receipt.result.messageId,
      user.id,
      "v2 ACK changed durable user identity",
    );
    assert.deepEqual(
      users,
      [
        {
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "user_message",
            messageId: user.id,
            content: receipt.input,
          },
        },
      ],
      "v2 ACK does not identify the original user notification",
    );
  } else if (users.length) {
    for (const frame of users) assert.equal(frame.update.messageId, user.id);
    assert.deepEqual(transcript(users, request.sessionId), [
      { role: "user", content: receipt.input },
    ]);
  }
}

function inspectUsage(run, events, updates, ordinary) {
  assert(
    Array.isArray(run.usage_measurements),
    "persisted usage measurements required",
  );
  const stored = events.items.filter((event) => event.kind === "usage");
  const observed = updates.filter(
    (frame) => frame.update.sessionUpdate === "usage_update",
  );
  if (!ordinary) {
    assert.deepEqual(run.usage_measurements, [], "command called a model");
    assert.deepEqual(stored, [], "command persisted model usage");
    assert.deepEqual(observed, [], "command reported model usage");
    return;
  }
  assert.equal(stored.length, 2, "ordinary model usage missing or repeated");
  for (const event of stored) {
    assert(object(event.payload.measurement), "per-call usage receipt missing");
    assert(Number.isFinite(event.payload.used) && event.payload.used >= 0);
    assert(Number.isFinite(event.payload.size) && event.payload.size > 0);
  }
  assert.deepEqual(
    run.usage_measurements,
    stored.map((event) => event.payload.measurement),
    "Run usage differs from complete persisted events",
  );
  assert.deepEqual(
    observed.map((frame) => frame.update),
    stored.map(({ payload }) => ({
      sessionUpdate: "usage_update",
      used: payload.used,
      size: payload.size,
      ...(payload.cost === undefined ? {} : { cost: payload.cost }),
    })),
    "original usage notifications differ from persisted usage",
  );
}

function inspectTools(events, expected, reply) {
  const stored = events.items.filter((event) => event.kind === "tool_call");
  const updates = expected.receipt.updates;
  const observed = updates.filter((frame) =>
    ["tool_call", "tool_call_update"].includes(frame.update.sessionUpdate),
  );
  const dispatches = events.items
    .filter((event) => event.kind === "agent_message")
    .flatMap((event) => {
      const calls = event.payload.toolCalls;
      assert(calls === undefined || Array.isArray(calls));
      return calls ?? [];
    });
  if (!expected.ordinary) {
    assert.deepEqual(stored, [], "command persisted a Tool call");
    assert.deepEqual(observed, [], "command dispatched a Tool");
    assert.deepEqual(dispatches, [], "command persisted model Tool dispatch");
    assert(
      !events.items.some((event) =>
        ["agent_thought", "plan"].includes(event.kind),
      ),
      "command persisted model execution",
    );
    return;
  }
  assertOrdinaryTool(updates, expected.version, expected.text);
  assert(stored.length >= 2, "durable Tool lifecycle missing");
  assert.equal(
    observed.length,
    stored.length,
    "durable and actual Tool inventories differ",
  );
  const first = stored[0].payload,
    terminal = stored.at(-1).payload;
  nonempty(first.toolCallId, "persisted Tool identity required");
  assert.equal(first.initial, true, "durable Tool start missing");
  assert.equal(first.modelName, "bash");
  assert(object(first.arguments), "persisted Tool input required");
  for (const [index, event] of stored.entries()) {
    const payload = event.payload;
    assert.equal(
      payload.toolCallId,
      first.toolCallId,
      "durable Tool identity changed",
    );
    assert.equal(payload.initial, index === 0, "repeated durable Tool start");
    assert.equal(
      payload.status,
      index === stored.length - 1 ? "completed" : "in_progress",
    );
    const actual = observed[index].update;
    assert.equal(actual.toolCallId, payload.toolCallId);
    assert.equal(actual.status, payload.status);
    if (payload.arguments !== undefined)
      assert.deepEqual(actual.rawInput, payload.arguments);
    if (payload.modelName !== undefined)
      assert.equal(actual.name, payload.modelName);
    if (payload.content !== undefined)
      assert.deepEqual(
        actual.content,
        payload.content.map((content) => ({ type: "content", content })),
        "actual Tool result differs from durable result",
      );
  }
  assert.equal(terminal.status, "completed");
  assert(
    reply.sequence > stored.at(-1).sequence,
    "assistant persisted before Tool completion",
  );
  assert.equal(
    dispatches.length,
    1,
    "missing or duplicated model Tool dispatch",
  );
  assert.deepEqual(dispatches[0], {
    id: first.toolCallId,
    name: first.modelName,
    arguments: first.arguments,
  });
}

export function inspectCommandRunBusiness(evidence) {
  assert(Array.isArray(evidence?.agent_ids) && evidence.agent_ids.length === 2);
  assert.equal(new Set(evidence.agent_ids).size, 2);
  for (const id of evidence.agent_ids)
    nonempty(id, "original Agent identity required");
  nonempty(evidence.principal_id, "original Principal required");
  const expected = originalRequests(evidence);
  inspectModelRequests(evidence, expected);
  assert(Array.isArray(evidence.agents));
  assert.deepEqual(
    evidence.agents.map((agent) => agent.agent_id),
    evidence.agent_ids,
  );
  const runIds = new Set(),
    eventIds = new Set(),
    sequences = new Map(),
    matched = new Set();
  let commands = 0,
    ordinary = 0;
  for (const [index, agent] of evidence.agents.entries()) {
    completePage(agent.page, "Run page");
    assert.equal(agent.page.items.length, index === 0 ? 8 : 0);
    assert(Array.isArray(agent.all));
    assert.equal(agent.all.length, agent.page.items.length);
    const summaries = new Map();
    for (const summary of agent.page.items) {
      for (const field of summaryFields)
        nonempty(summary[field], "incomplete Run summary");
      assert.equal(summary.agent_id, agent.agent_id);
      assert.equal(summary.principal_id, evidence.principal_id);
      assert(!summaries.has(summary.run_id), "duplicate listed Run");
      summaries.set(summary.run_id, summary);
    }
    for (const { run, events } of agent.all) {
      nonempty(run?.run_id, "persisted Run identity required");
      assert(!runIds.has(run.run_id), "duplicate persisted Run");
      runIds.add(run.run_id);
      const summary = summaries.get(run.run_id);
      assert(summary, "Run detail absent from original list");
      for (const field of summaryFields)
        assert.equal(
          run[field],
          summary[field],
          "Run detail changed original list",
        );
      const matches = expected.filter(
        (item) =>
          item.request.sessionId === run.session_id &&
          isDeepStrictEqual(item.receipt.input, run.input),
      );
      assert.equal(
        matches.length,
        1,
        "Run is not bound to one original prompt",
      );
      const current = matches[0];
      assert(!matched.has(current), "original prompt produced duplicate Runs");
      matched.add(current);
      assert.equal(run.agent_id, current.request.agentId);
      assert.equal(run.principal_id, evidence.principal_id);
      assert.equal(run.state, "completed");
      assert.equal(run.terminal_class, "completed");
      assert.equal(run.stop_reason, "end_turn");
      assert.equal(run.error_class, null);
      assert.equal(run.executor_state, "quiescent");
      assert.equal(
        run.tool_effect_state,
        current.ordinary ? "settled" : "none",
      );
      assert(
        run.unknown_effect_source === undefined ||
          run.unknown_effect_source === null,
        "unknown Runtime effect",
      );
      if (!sequences.has(run.session_id))
        sequences.set(run.session_id, new Set());
      const user = inspectEvents(
        events,
        run,
        eventIds,
        sequences.get(run.session_id),
      );
      inspectUserReceipt(current, user);
      const reply = inspectReply(events, current);
      inspectUsage(run, events, current.receipt.updates, current.ordinary);
      inspectTools(events, current, reply);
      if (current.ordinary) ordinary++;
      else commands++;
    }
  }
  assert.equal(runIds.size, 8);
  assert.equal(matched.size, 8);
  assert.equal(commands, 6);
  assert.equal(ordinary, 2);
  return {
    status: "passed",
    runs: 8,
    completed: 8,
    failed: 0,
    commands,
    ordinary,
    profiles: profiles.length,
    other_agent_runs: 0,
  };
}

export async function collectCommandRunBusiness({
  read,
  agentIds,
  requests,
  principalId,
  modelRequests,
  preserve,
}) {
  const evidence = {
    agent_ids: structuredClone(agentIds),
    principal_id: principalId,
    requests: [],
    model_requests: [],
    agents: [],
  };
  let failure;
  try {
    assert(Array.isArray(requests), "original request inventory required");
    evidence.requests = structuredClone(
      requests.filter((request) =>
        ["command", "ordinary"].includes(request.kind),
      ),
    );
    evidence.model_requests = structuredClone(modelRequests);
    assert(
      Array.isArray(evidence.agent_ids) && evidence.agent_ids.length === 2,
    );
    for (const [index, agentId] of evidence.agent_ids.entries()) {
      nonempty(agentId, "original Agent identity required");
      const receipt = { agent_id: agentId, page: null, all: [] };
      evidence.agents.push(receipt);
      receipt.page = structuredClone(
        await read(
          "/api/admin/execution-audits?agent_id=" +
            encodeURIComponent(agentId) +
            "&limit=100",
        ),
      );
      completePage(receipt.page, "Run page");
      assert.equal(receipt.page.items.length, index === 0 ? 8 : 0);
      for (const summary of receipt.page.items) {
        nonempty(summary.run_id, "listed Run identity required");
        const path =
          "/api/admin/execution-audits/" + encodeURIComponent(summary.run_id);
        const detail = { run: null, events: null };
        receipt.all.push(detail);
        detail.run = structuredClone(await read(path));
        detail.events = structuredClone(await read(path + "/events?limit=100"));
      }
    }
    inspectCommandRunBusiness(evidence);
    return evidence;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await preserve(evidence);
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure, error],
          "Commands audit and business archive failed",
        );
      throw error;
    }
  }
}
