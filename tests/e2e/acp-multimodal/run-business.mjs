import assert from "node:assert/strict";
import { storedPrompt } from "./fixtures.mjs";

const profiles = ["v1-ws", "v2-ws", "v1-http"];
const steps = ["native", "continue", "mismatch", "restored"];
const summaryFields = [
  "run_id",
  "session_id",
  "agent_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const nonempty = (value, label) =>
  assert(typeof value === "string" && value.length > 0, label);

function completePage(page, label) {
  assert(Array.isArray(page?.items), `${label} items required`);
  assert.equal(page.next_cursor, null, `complete ${label} required`);
}

export function inspectNativeRunBusiness(evidence) {
  assert(Array.isArray(evidence?.agent_ids));
  assert.equal(evidence.agent_ids.length, 2);
  assert.equal(new Set(evidence.agent_ids).size, 2);
  for (const id of evidence.agent_ids) nonempty(id, "Agent identity required");
  nonempty(evidence.principal_id, "original Principal required");
  assert(Array.isArray(evidence.requests));
  assert.equal(evidence.requests.length, 12, "twelve prompt receipts required");
  assert(Array.isArray(evidence.agents));
  assert.deepEqual(
    evidence.agents.map((agent) => agent.agent_id),
    evidence.agent_ids,
  );

  const requests = new Map(),
    sessions = new Set();
  for (const profile of profiles) {
    const profileSessions = new Set();
    for (const step of steps) {
      const phase = `${profile} ${step}`;
      const matches = evidence.requests.filter(
        (request) => request.phase === phase,
      );
      assert.equal(matches.length, 1, "missing or duplicate prompt phase");
      const request = matches[0];
      assert.equal(request.label, `${profile}:${step}`);
      assert.equal(
        request.kind,
        step === "mismatch" ? "local-failure" : "native",
      );
      assert.equal(request.agentId, evidence.agent_ids[0]);
      assert.equal(request.protocolVersion, profile === "v2-ws" ? 2 : 1);
      nonempty(request.sessionId, "prompt Session required");
      assert.equal(request.promptReceipt?.sessionId, request.sessionId);
      nonempty(
        request.promptReceipt.requestId,
        "actual prompt request required",
      );
      if (request.requestId !== undefined)
        assert.equal(request.promptReceipt.requestId, request.requestId);
      profileSessions.add(request.sessionId);
      requests.set(phase, { request, profile, step });
    }
    assert.equal(profileSessions.size, 1, "profile prompts changed Session");
    sessions.add([...profileSessions][0]);
  }
  assert.equal(sessions.size, 3, "three original Sessions required");

  const runIds = new Set(),
    eventIds = new Set(),
    sequences = new Map(),
    matched = new Set();
  let completed = 0,
    failed = 0;
  for (const [index, agent] of evidence.agents.entries()) {
    completePage(agent.page, "Run page");
    assert(Array.isArray(agent.all));
    assert.equal(agent.page.items.length, index === 0 ? 12 : 0);
    assert.equal(agent.all.length, agent.page.items.length);
    const summaries = new Map();
    for (const summary of agent.page.items) {
      for (const field of summaryFields)
        nonempty(summary[field], `Run summary ${field} required`);
      assert.equal(summary.agent_id, agent.agent_id);
      assert.equal(summary.principal_id, evidence.principal_id);
      assert(!summaries.has(summary.run_id), "duplicate Run summary");
      summaries.set(summary.run_id, summary);
    }
    for (const { run, events } of agent.all) {
      nonempty(run?.run_id, "persisted Run identity required");
      assert(!runIds.has(run.run_id), "duplicate persisted Run");
      runIds.add(run.run_id);
      const summary = summaries.get(run.run_id);
      assert(summary, "persisted Run absent from list");
      assert.deepEqual(
        Object.fromEntries(summaryFields.map((field) => [field, run[field]])),
        Object.fromEntries(
          summaryFields.map((field) => [field, summary[field]]),
        ),
        "Run detail changed its list identity or state",
      );
      const phase = run.input?.[0]?.text;
      const expected = requests.get(phase);
      assert(
        expected && !matched.has(phase),
        "unmatched or duplicate Run input",
      );
      matched.add(phase);
      const { request, profile, step } = expected;
      assert.equal(run.agent_id, request.agentId);
      assert.equal(run.session_id, request.sessionId);
      assert.equal(run.principal_id, evidence.principal_id);
      const input =
        step === "native"
          ? storedPrompt(profile)
          : [{ type: "text", text: phase }];
      assert.deepEqual(run.input, input, "persisted prompt changed");
      assert.equal(run.executor_state, "quiescent");
      assert.equal(run.tool_effect_state, "none");
      // Admin omits a null unknown_effect_source from its projection.
      assert(
        run.unknown_effect_source === null ||
          run.unknown_effect_source === undefined,
        "unknown Runtime effect",
      );
      const isFailed = step === "mismatch";
      assert.equal(run.state, isFailed ? "failed" : "completed");
      assert.equal(run.terminal_class, run.state);
      assert.equal(run.stop_reason, isFailed ? null : "end_turn");
      assert.equal(
        run.error_class,
        isFailed ? "model_unsupported_content" : null,
      );
      if (isFailed) failed++;
      else completed++;

      completePage(events, "execution event page");
      assert.equal(events.stream, "execution");
      if (!sequences.has(run.session_id))
        sequences.set(run.session_id, new Set());
      const sessionSequences = sequences.get(run.session_id);
      let previous = 0;
      for (const event of events.items) {
        nonempty(event.id, "persisted event identity required");
        assert(!eventIds.has(event.id), "duplicate persisted event identity");
        eventIds.add(event.id);
        assert(
          Number.isSafeInteger(event.sequence) && event.sequence > previous,
        );
        assert(
          !sessionSequences.has(event.sequence),
          "duplicate Session event sequence",
        );
        sessionSequences.add(event.sequence);
        previous = event.sequence;
        nonempty(event.kind, "persisted event kind required");
        assert(
          !event.kind.startsWith("tool"),
          "unexpected persisted Tool event",
        );
        if (event.kind === "agent_message")
          assert(
            event.payload?.toolCalls === undefined ||
              (Array.isArray(event.payload.toolCalls) &&
                event.payload.toolCalls.length === 0),
            "unexpected persisted model Tool call",
          );
      }
      const users = events.items.filter(
        (event) => event.kind === "user_message",
      );
      assert.equal(users.length, 1, "one persisted user message required");
      const user = users[0];
      assert.equal(user.visible, true);
      assert.equal(user.payload?.kind, "user_message");
      assert.equal(user.payload.messageId, user.id);
      assert.deepEqual(user.payload.content, input);
      if (request.protocolVersion === 2)
        assert.equal(request.promptReceipt.result?.messageId, user.id);

      const replies = events.items.filter(
        (event) => event.kind === "agent_message",
      );
      if (isFailed)
        assert.equal(replies.length, 0, "local failure persisted a reply");
      else {
        assert(replies.length > 0, "persisted assistant reply required");
        const content = [];
        for (const reply of replies) {
          assert.equal(reply.visible, true);
          assert.equal(reply.payload?.kind, "agent_message");
          assert.equal(reply.payload.messageId, reply.id);
          assert(Array.isArray(reply.payload.content));
          for (const block of reply.payload.content) {
            assert.equal(block.type, "text");
            assert.equal(typeof block.text, "string");
            content.push(block.text);
          }
        }
        assert.equal(content.join(""), `${profile} native input verified`);
      }
    }
  }
  assert.equal(matched.size, 12);
  assert.equal(runIds.size, 12);
  assert.equal(completed, 9);
  assert.equal(failed, 3);
  return {
    status: "passed",
    runs: runIds.size,
    completed,
    failed,
    profiles: profiles.length,
    other_agent_runs: evidence.agents[1].page.items.length,
  };
}

export async function collectNativeRunBusiness({
  read,
  agentIds,
  requests,
  principalId,
  preserve,
}) {
  const evidence = {
    agent_ids: structuredClone(agentIds),
    principal_id: principalId,
    requests: [],
    agents: [],
  };
  let failure;
  try {
    assert(Array.isArray(requests));
    evidence.requests = structuredClone(
      requests.filter((request) =>
        ["native", "local-failure"].includes(request.kind),
      ),
    );
    assert(
      Array.isArray(evidence.agent_ids) && evidence.agent_ids.length === 2,
    );
    for (const [index, agentId] of evidence.agent_ids.entries()) {
      const receipt = { agent_id: agentId, page: null, all: [] };
      evidence.agents.push(receipt);
      receipt.page = structuredClone(
        await read(
          `/api/admin/execution-audits?agent_id=${encodeURIComponent(agentId)}&limit=100`,
        ),
      );
      completePage(receipt.page, "Run page");
      assert.equal(receipt.page.items.length, index === 0 ? 12 : 0);
      for (const row of receipt.page.items) {
        nonempty(row.run_id, "listed Run identity required");
        const path = `/api/admin/execution-audits/${encodeURIComponent(row.run_id)}`;
        const detail = { run: null, events: null };
        receipt.all.push(detail);
        detail.run = structuredClone(await read(path));
        detail.events = structuredClone(await read(`${path}/events?limit=100`));
      }
    }
    inspectNativeRunBusiness(evidence);
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
          "Native audit and business archive failed",
        );
      throw error;
    }
  }
}
