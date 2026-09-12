import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseVersion,
  initializeParams,
  replayRequest,
  assertPromptComplete,
  assertReplay,
  assertStillRunning,
} from "./protocol.mjs";

const session = "session-1";
const phase = "phase-1";
const frame = (update) => ({ sessionId: session, update });
const running = frame({ sessionUpdate: "state_update", state: "running" });
const idle = frame({
  sessionUpdate: "state_update",
  state: "idle",
  stopReason: "end_turn",
});
test("held v2 Run needs its own current running state, never another Session's state", () => {
  assertStillRunning(1, [tool], session);
  assertStillRunning(2, [running, tool], session);
  for (const invalid of [
    [],
    [running, idle],
    [{ ...running, sessionId: "other" }],
  ])
    assert.throws(() => assertStillRunning(2, invalid, session));
});
const tool = frame({
  sessionUpdate: "tool_call_update",
  toolCallId: "tool-1",
  status: "completed",
  content: [
    { type: "content", content: { type: "text", text: "actual effect" } },
  ],
});
const answer = (version, text = `${phase} verified`) =>
  frame({
    sessionUpdate: version === 1 ? "agent_message_chunk" : "agent_message",
    messageId: "answer-1",
    content: version === 1 ? { type: "text", text } : [{ type: "text", text }],
  });
const input = (text = phase, messageId = "input-1") =>
  frame({
    sessionUpdate: "user_message_chunk",
    messageId,
    content: { type: "text", text },
  });

test("version selection and initialization keep the two official contracts distinct", () => {
  assert.equal(parseVersion(undefined), 1);
  for (const version of [1, 2])
    assert.equal(parseVersion(String(version)), version);
  for (const invalid of ["", "3", "01", "v2", "2;docker"])
    assert.throws(() => parseVersion(invalid));
  assert.deepEqual(initializeParams(1, 1), {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "managed-mcp-integration", version: "1" },
  });
  assert.deepEqual(initializeParams(2, "draft"), {
    protocolVersion: "draft",
    capabilities: {},
    info: { name: "managed-mcp-integration", version: "1" },
  });
  assert.deepEqual(replayRequest(1, session), {
    method: "load",
    params: { sessionId: session, cwd: "/workspace", mcpServers: [] },
  });
  assert.deepEqual(replayRequest(2, session), {
    method: "resume",
    params: {
      sessionId: session,
      cwd: "/workspace",
      mcpServers: [],
      replayFrom: { type: "start" },
    },
  });
});
for (const version of [1, 2]) {
  const result = version === 1 ? { stopReason: "end_turn" } : {};
  const updates =
    version === 1
      ? [tool, answer(version)]
      : [running, tool, answer(version), idle];
  test(`v${version}: only actual Tool/answer/completion can finish a prompt`, () => {
    assertPromptComplete(version, result, updates, phase, session);
    for (const invalid of [
      updates.filter((item) => item !== tool),
      updates.filter((item) => item.update.messageId !== "answer-1"),
      updates.map((item) => ({ ...item, sessionId: "foreign" })),
      updates.map((item) =>
        item === tool
          ? { ...item, update: { ...item.update, status: "in_progress" } }
          : item,
      ),
      [
        answer(version),
        ...updates.filter((item) => item.update.messageId !== "answer-1"),
      ],
    ])
      assert.throws(() =>
        assertPromptComplete(version, result, invalid, phase, session),
      );
  });
  test(`v${version}: replay preserves ordered Tool terminal records and answers`, () => {
    const replayed = [
      ...(version === 1 ? [input()] : []),
      tool,
      answer(version),
      ...(version === 2 ? [idle] : []),
    ];
    assertReplay(version, updates, replayed, [phase], session);
    for (const invalid of [
      replayed.filter((item) => item !== tool),
      [tool, ...replayed],
      replayed.map((item) =>
        item === tool
          ? { ...item, update: { ...item.update, content: [] } }
          : item,
      ),
      replayed.map((item) =>
        item === tool
          ? { ...item, update: { ...item.update, toolCallId: "other" } }
          : item,
      ),
      replayed.map((item) =>
        item.update.messageId === "answer-1"
          ? answer(version, "other answer")
          : item,
      ),
      replayed.map((item) => ({ ...item, sessionId: "foreign" })),
    ])
      assert.throws(() =>
        assertReplay(version, updates, invalid, [phase], session),
      );
  });
}
test("v2 acknowledgment, failed idle, duplicate idle and reversed states are not completion", () => {
  for (const invalid of [
    [running, tool, answer(2)],
    [tool, answer(2), idle],
    [running, tool, answer(2), idle, idle],
    [idle, running, tool, answer(2)],
    [
      running,
      tool,
      answer(2),
      frame({ ...idle.update, stopReason: "_failed" }),
    ],
  ])
    assert.throws(() => assertPromptComplete(2, {}, invalid, phase, session));
  assert.throws(() =>
    assertPromptComplete(1, {}, [tool, answer(1)], phase, session),
  );
  for (const invalid of [
    [tool, answer(2)],
    [tool, answer(2), idle, idle],
  ])
    assert.throws(() =>
      assertReplay(
        2,
        [running, tool, answer(2), idle],
        invalid,
        [phase],
        session,
      ),
    );
});
test("v1 load adds each sent input once before its live Tool/answer sequence", () => {
  const secondTool = frame({ ...tool.update, toolCallId: "tool-2" });
  const secondAnswer = frame({
    ...answer(1, "phase-2 verified").update,
    messageId: "answer-2",
  });
  const secondInput = input("phase-2", "input-2");
  const original = [tool, answer(1), secondTool, secondAnswer];
  const replay = [
    input(),
    tool,
    answer(1),
    secondInput,
    secondTool,
    secondAnswer,
  ];
  assertReplay(1, original, replay, [phase, "phase-2"], session);
  for (const invalid of [
    replay.filter((item) => item.update.messageId !== "input-1"),
    [input(), ...replay],
    [input(phase, "input-extra"), ...replay],
    [input("wrong input"), ...replay.slice(1)],
    [input(phase, ""), ...replay.slice(1)],
    [input(), tool, answer(1), input("phase-2"), secondTool, secondAnswer],
    [tool, input(), answer(1), secondInput, secondTool, secondAnswer],
    [input(), tool, secondInput, answer(1), secondTool, secondAnswer],
    [input(), answer(1), tool, secondInput, secondTool, secondAnswer],
  ])
    assert.throws(() =>
      assertReplay(1, original, invalid, [phase, "phase-2"], session),
    );
});
test("replayed answers cannot be reordered or duplicated across Runs", () => {
  const second = answer(2, "phase-2 verified");
  const original = [running, tool, answer(2), second, idle];
  assertReplay(
    2,
    original,
    [tool, answer(2), second, idle],
    [phase, "phase-2"],
    session,
  );
  for (const replay of [
    [tool, second, answer(2), idle],
    [tool, answer(2), answer(2), second, idle],
  ])
    assert.throws(() =>
      assertReplay(2, original, replay, [phase, "phase-2"], session),
    );
});
test("replay after an explicitly rejected prompt retains failure without changing successful Tool history", () => {
  const original = [running, tool, answer(2), idle];
  const rejected = frame({ ...idle.update, stopReason: "_failed" });
  const replay = [tool, answer(2), rejected];
  assert.throws(() => assertReplay(2, original, replay, [phase], session));
  assertReplay(2, original, replay, [phase], session, "_failed");
  assert.throws(() =>
    assertReplay(
      2,
      original,
      [tool, answer(2), idle],
      [phase],
      session,
      "_failed",
    ),
  );
  assert.throws(() =>
    assertReplay(
      2,
      original,
      [answer(2), rejected],
      [phase],
      session,
      "_failed",
    ),
  );
});
test("replay preserves one mixed message/Tool timeline and idles after business output", () => {
  const user = frame({
    sessionUpdate: "user_message",
    messageId: "input-1",
    content: [{ type: "text", text: phase }],
  });
  const original = [user, running, tool, answer(2), idle];
  const rejected = frame({ ...idle.update, stopReason: "_failed" });
  const catalog = frame({
    sessionUpdate: "available_commands_update",
    availableCommands: [],
  });
  assertReplay(
    2,
    original,
    [user, tool, answer(2), rejected, catalog],
    [phase],
    session,
    "_failed",
  );
  for (const invalid of [
    [user, answer(2), tool, rejected],
    [rejected, user, tool, answer(2)],
    [tool, answer(2), rejected],
    [
      frame({
        ...user.update,
        content: [{ type: "text", text: "different input" }],
      }),
      tool,
      answer(2),
      rejected,
    ],
  ])
    assert.throws(() =>
      assertReplay(2, original, invalid, [phase], session, "_failed"),
    );
});
