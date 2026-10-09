import assert from "node:assert/strict";

export function assertOrdinaryTool(frames, version, phase) {
  const updates = frames.map(({ update }) => update);
  const tools = updates.filter((update) =>
    ["tool_call", "tool_call_update"].includes(update.sessionUpdate),
  );
  assert(tools.length >= 2, "missing Tool lifecycle");
  assert.equal(
    tools[0].sessionUpdate,
    version === 1 ? "tool_call" : "tool_call_update",
  );
  assert(tools[0].toolCallId, "missing Tool ID");
  assert.equal(
    new Set(tools.map((tool) => tool.toolCallId)).size,
    1,
    "unexpected Tool identity",
  );
  assert(
    tools.slice(1).every((tool) => tool.sessionUpdate === "tool_call_update"),
  );
  assert(
    tools.slice(0, -1).every((tool) => tool.status === "in_progress"),
    "repeated or misplaced Tool terminal",
  );
  const terminal = tools.at(-1);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.content?.length, 1, "missing or ambiguous Tool result");
  const block = terminal.content[0];
  assert(
    block.type === "content" && block.content?.type === "text",
    "Bash result must be text JSON",
  );
  let result;
  try {
    result = JSON.parse(block.content.text);
  } catch {
    throw new Error("Bash result is not structured JSON");
  }
  assert(
    result?.exit_code === 0 &&
      result.stderr === "" &&
      result.truncated === false &&
      result.effect_state === "settled",
    "Bash result was not successful, complete and settled",
  );
  assert(
    typeof result.stdout === "string" && result.stdout.includes(phase),
    "missing actual stdout effect",
  );
  const reply = updates.findIndex((update) =>
    ["agent_message", "agent_message_chunk"].includes(update.sessionUpdate),
  );
  assert(
    reply > updates.indexOf(terminal),
    "Tool result did not precede final response",
  );
}

export function assertCatalog(frames, sessionId, skills = []) {
  assert(
    frames.every((frame) => frame.sessionId === sessionId),
    "foreign Session notification",
  );
  const catalogs = frames.filter(
    ({ update }) => update.sessionUpdate === "available_commands_update",
  );
  assert.equal(catalogs.length, 1, "missing or duplicated command catalog");
  const commands = catalogs[0].update.availableCommands;
  // Skill commands are best-effort: ACP omits them when the Runtime read is
  // busy or slow, but never lists anything else.
  const names = commands.map(({ name }) => name);
  assert.deepEqual(names, names.length === 1 ? ["help"] : ["help", ...skills]);
  assert(commands[0].description.includes("/帮助"), "missing localized alias");
}

export function transcript(frames, sessionId) {
  const messages = [];
  for (const { sessionId: actual, update } of frames) {
    assert.equal(actual, sessionId, "foreign Session history");
    const kind = update.sessionUpdate;
    if (
      ![
        "user_message",
        "user_message_chunk",
        "agent_message",
        "agent_message_chunk",
      ].includes(kind)
    )
      continue;
    const role = kind.startsWith("user") ? "user" : "assistant";
    const content = Array.isArray(update.content)
      ? update.content
      : [update.content];
    const previous = messages.at(-1);
    if (
      kind.endsWith("_chunk") &&
      update.messageId &&
      previous?.id === update.messageId &&
      previous.role === role
    ) {
      previous.content.push(...content);
    } else {
      messages.push({ id: update.messageId, role, content: [...content] });
    }
  }
  return messages.map(({ role, content }) => ({ role, content }));
}

export function assertTranscript(frames, sessionId, expected) {
  assert.deepEqual(
    transcript(frames, sessionId),
    expected,
    "changed, missing or duplicated transcript",
  );
}
