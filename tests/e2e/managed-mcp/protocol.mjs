import assert from "node:assert/strict";

export function parseVersion(value = "1") {
  assert(["1", "2"].includes(value), "managed MCP version must be 1 or 2");
  return Number(value);
}

export function initializeParams(version, protocolVersion) {
  const info = { name: "managed-mcp-integration", version: "1" };
  return version === 1
    ? { protocolVersion, clientCapabilities: {}, clientInfo: info }
    : { protocolVersion, capabilities: {}, info };
}

export function replayRequest(version, sessionId) {
  return {
    method: version === 1 ? "load" : "resume",
    params: {
      sessionId,
      cwd: "/workspace",
      mcpServers: [],
      ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
    },
  };
}

const text = (update) =>
  (Array.isArray(update.content) ? update.content : [update.content])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
function answerIndex(version, updates, phase) {
  const matches = updates.flatMap(({ update }, index) =>
    (update.sessionUpdate === "agent_message_chunk" ||
      (version === 2 && update.sessionUpdate === "agent_message")) &&
    text(update) === `${phase} verified`
      ? [index]
      : [],
  );
  assert.equal(
    matches.length,
    1,
    `${phase}: missing or duplicate verified answer`,
  );
  return matches[0];
}

export function assertPromptComplete(
  version,
  response,
  updates,
  phase,
  sessionId,
) {
  assert(
    updates.every((item) => item.sessionId === sessionId),
    "foreign prompt notification",
  );
  const states = updates.filter(
    ({ update }) => update.sessionUpdate === "state_update",
  );
  if (version === 1) {
    assert.equal(response.stopReason, "end_turn");
    assert.equal(states.length, 0);
  } else {
    assert.deepEqual(response, {}, "v2 acknowledgment changed");
    assert.deepEqual(
      states.map(({ update }) => update.state),
      ["running", "idle"],
    );
    assert.equal(states[1].update.stopReason, "end_turn");
    assert.equal(updates.at(-1), states[1], "v2 idle preceded output");
  }
  const completed = updates.findLastIndex(
    ({ update }) =>
      update.sessionUpdate === "tool_call_update" &&
      update.status === "completed",
  );
  assert(completed >= 0, "missing completed Tool");
  assert(
    answerIndex(version, updates, phase) > completed,
    "answer preceded completed Tool",
  );
}

export function assertStillRunning(version, updates, sessionId) {
  if (version === 1) return;
  const state = updates
    .filter(
      (item) =>
        item.sessionId === sessionId &&
        item.update.sessionUpdate === "state_update",
    )
    .at(-1);
  assert.equal(
    state?.update.state,
    "running",
    "held v2 Run did not remain running",
  );
}

function terminalTools(updates) {
  const tools = updates
    .filter(
      ({ update }) =>
        update.toolCallId &&
        ["failed", "completed", "cancelled"].includes(update.status),
    )
    .map(({ update }) => ({
      id: update.toolCallId,
      status: update.status,
      content: update.content ?? null,
      rawOutput: update.rawOutput ?? null,
      locations: update.locations ?? null,
    }));
  assert(tools.length > 0, "missing Tool history");
  assert.equal(
    new Set(tools.map((tool) => tool.id)).size,
    tools.length,
    "duplicate terminal Tool",
  );
  return tools;
}

function businessTimeline(updates) {
  return updates.flatMap(({ update }, index) => {
    const kind = update.sessionUpdate.replace(/_chunk$/, "");
    if (["user_message", "agent_message", "agent_thought"].includes(kind))
      return [
        {
          index,
          event: [
            kind,
            update.messageId,
            Array.isArray(update.content) ? update.content : [update.content],
          ],
        },
      ];
    if (
      update.toolCallId &&
      ["failed", "completed", "cancelled"].includes(update.status)
    )
      return [{ index, event: ["tool", update.toolCallId] }];
    return [];
  });
}

function v1ExpectedTimeline(original, phases) {
  const timeline = businessTimeline(original);
  const expected = [];
  let previous = -1;
  for (const phase of phases) {
    const end = answerIndex(1, original, phase);
    assert(end > previous, "reordered live answers");
    // v1 suppresses the initiating user's live echo. Match load to the actual
    // sent input plus that Run's observed output, not to an invented live frame.
    expected.push(["user_message", null, [{ type: "text", text: phase }]]);
    expected.push(
      ...timeline
        .filter(({ index }) => index > previous && index <= end)
        .map(({ event }) => event),
    );
    previous = end;
  }
  assert.equal(timeline.at(-1).index, previous, "unaccounted live output");
  return expected;
}

function v1ReplayTimeline(timeline) {
  const inputs = timeline.filter(({ event }) => event[0] === "user_message");
  const ids = inputs.map(({ event }) => event[1]);
  assert(
    ids.every((id) => typeof id === "string" && id.trim()),
    "missing input ID",
  );
  assert.equal(new Set(ids).size, ids.length, "duplicate input ID");
  return timeline.map(({ event }) =>
    event[0] === "user_message" ? [event[0], null, event[2]] : event,
  );
}

export function assertReplay(
  version,
  original,
  replayed,
  phases,
  sessionId,
  expectedStopReason = "end_turn",
) {
  assert(
    replayed.every((item) => item.sessionId === sessionId),
    "foreign replay notification",
  );
  const ownedOriginal = original.filter((item) => item.sessionId === sessionId);
  assert.deepEqual(terminalTools(replayed), terminalTools(ownedOriginal));
  const timeline = businessTimeline(replayed);
  assert.deepEqual(
    version === 1
      ? v1ReplayTimeline(timeline)
      : timeline.map((item) => item.event),
    version === 1
      ? v1ExpectedTimeline(ownedOriginal, phases)
      : businessTimeline(ownedOriginal).map((item) => item.event),
    "changed or reordered message/Tool history",
  );
  let previous = -1;
  for (const phase of phases) {
    const index = answerIndex(version, replayed, phase);
    assert(index > previous, "reordered answers");
    previous = index;
  }
  const states = replayed.filter(
    ({ update }) => update.sessionUpdate === "state_update",
  );
  assert.equal(
    states.length,
    version === 1 ? 0 : 1,
    "unexpected replay state count",
  );
  if (version === 2) {
    assert.equal(states[0].update.state, "idle");
    assert.equal(states[0].update.stopReason, expectedStopReason);
    assert(
      replayed.indexOf(states[0]) > timeline.at(-1).index,
      "replay idle preceded business output",
    );
  }
}
