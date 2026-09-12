import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMessageReplay } from "./replay.mjs";

const catalog = {
  sessionId: "s",
  update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "help", description: "Also /帮助" }],
  },
};

test("replay separates validated command discovery from the durable transcript", () => {
  assertMessageReplay([catalog], [], 1);
  assert.throws(() => assertMessageReplay([catalog, catalog], [], 1));
  assert.throws(() =>
    assertMessageReplay(
      [{ ...catalog, update: { ...catalog.update, availableCommands: [] } }],
      [],
      1,
    ),
  );
  assert.throws(() =>
    assertMessageReplay(
      [
        catalog,
        {
          sessionId: "s",
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: "u",
            content: { type: "text", text: "unauthorized" },
          },
        },
      ],
      [],
      1,
    ),
  );
});

for (const version of [1, 2]) {
  test(`v${version}: replay oracle catches type confusion, cross-type reordering and loss`, () => {
    const text = { type: "text", text: "private" };
    const events = [
      { kind: "user_message", messageId: "user", content: [text, text] },
      {
        kind: "tool_call",
        initial: true,
        toolCallId: "tool",
        status: "in_progress",
        argumentsJson: JSON.stringify({
          command: "printf '\\0'",
          label: "\u0000\ud800",
        }),
      },
      {
        kind: "tool_call",
        initial: false,
        toolCallId: "tool",
        status: "completed",
        content: [text],
      },
      { kind: "agent_message", messageId: "answer", content: [text] },
    ].map((payload) => ({ visible: true, kind: payload.kind, payload }));
    const message = (kind, id, content) => ({
      update: { sessionUpdate: kind, messageId: id, content },
    });
    const history = [
      ...(version === 1
        ? [
            message("user_message_chunk", "user", text),
            message("user_message_chunk", "user", text),
          ]
        : [message("user_message", "user", [text, text])]),
      {
        update: {
          sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
          toolCallId: "tool",
          status: "in_progress",
          rawInput: { command: "printf '\\0'", label: "\u0000\ud800" },
        },
      },
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool",
          status: "completed",
          content: [{ type: "content", content: text }],
        },
      },
      message(
        version === 1 ? "agent_message_chunk" : "agent_message",
        "answer",
        version === 1 ? text : [text],
      ),
    ];
    const wire = [
      ...history.map((item) => ({ sessionId: "s", ...item })),
      catalog,
    ];
    assertMessageReplay(wire, events, version);
    assert.throws(() =>
      assertMessageReplay(wire.slice(0, -1), events, version),
    );
    for (const rawInput of [undefined, {}, { command: "other" }]) {
      const wrongInput = structuredClone(wire);
      wrongInput.find(
        (item) => item.update.rawInput !== undefined,
      ).update.rawInput = rawInput;
      assert.throws(() => assertMessageReplay(wrongInput, events, version));
    }
    const malformed = structuredClone(events);
    malformed.find(
      (item) => item.payload.argumentsJson !== undefined,
    ).payload.argumentsJson = "{";
    assert.throws(() => assertMessageReplay(wire, malformed, version));
    assert.throws(() => assertMessageReplay([], events, version));
    assert.throws(() =>
      assertMessageReplay([...wire, wire[0]], events, version),
    );
    const mistyped = structuredClone(wire);
    mistyped[0].update.sessionUpdate =
      version === 1 ? "agent_message_chunk" : "agent_message";
    assert.throws(() => assertMessageReplay(mistyped, events, version));
    const reordered = [
      ...wire.filter((item) => !item.update.toolCallId),
      ...wire.filter((item) => item.update.toolCallId),
    ];
    assert.throws(() => assertMessageReplay(reordered, events, version));
  });
}
