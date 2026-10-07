import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCatalog,
  assertOrdinaryTool,
  assertTranscript,
} from "./evidence.mjs";

test("ordinary Tool evidence follows each protocol and requires an actual result before reply", () => {
  for (const version of [1, 2]) {
    const result = {
      exit_code: 0,
      stdout: "phase",
      stderr: "",
      truncated: false,
      effect_state: "settled",
    };
    const frames = [
      {
        update: {
          sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
          toolCallId: "t",
          status: "in_progress",
        },
      },
      {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: JSON.stringify(result) },
            },
          ],
        },
      },
      {
        update: {
          sessionUpdate:
            version === 1 ? "agent_message_chunk" : "agent_message",
        },
      },
    ];
    assertOrdinaryTool(frames, version, "phase");
    for (const override of [
      { exit_code: 1 },
      { stdout: "", stderr: "phase" },
      { truncated: true },
      { effect_state: "unknown" },
    ]) {
      const broken = structuredClone(frames);
      broken[1].update.content[0].content.text = JSON.stringify({
        ...result,
        ...override,
      });
      assert.throws(() => assertOrdinaryTool(broken, version, "phase"));
    }
    for (const broken of [
      [],
      frames.slice(1),
      [frames[0], frames[2], frames[1]],
      [...frames.slice(0, 2), frames[1], frames[2]],
      [
        frames[0],
        { update: { ...frames[1].update, toolCallId: "other" } },
        frames[2],
      ],
      [frames[0], { update: { ...frames[1].update, content: [] } }, frames[2]],
      [
        {
          update: {
            ...frames[0].update,
            sessionUpdate: version === 1 ? "tool_call_update" : "tool_call",
          },
        },
        ...frames.slice(1),
      ],
    ]) {
      assert.throws(() => assertOrdinaryTool(broken, version, "phase"));
    }
  }
});

const catalog = {
  sessionId: "s",
  update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "help", description: "Show commands /帮助" }],
  },
};
test("catalog is complete and belongs to the requested Session", () => {
  assertCatalog([catalog], "s");
  for (const frames of [
    [],
    [catalog, catalog],
    [{ ...catalog, sessionId: "foreign" }],
    [{ ...catalog, update: { ...catalog.update, availableCommands: [] } }],
    [
      {
        ...catalog,
        update: {
          ...catalog.update,
          availableCommands: [{ name: "fake", description: "fake" }],
        },
      },
    ],
  ]) {
    assert.throws(() => assertCatalog(frames, "s"));
  }
});

test("catalog may list delivered Skill commands after the built-in commands", () => {
  const skill = { name: "skill:system:code-review", description: "Review" };
  const withSkill = {
    ...catalog,
    update: {
      ...catalog.update,
      availableCommands: [...catalog.update.availableCommands, skill],
    },
  };
  assertCatalog([withSkill], "s", [skill.name]);
  assert.throws(() => assertCatalog([withSkill], "s"));
  assertCatalog([catalog], "s", [skill.name]);
  const foreign = structuredClone(withSkill);
  foreign.update.availableCommands[1].name = "skill:system:other";
  assert.throws(() => assertCatalog([foreign], "s", [skill.name]));
});

test("transcript compares block identity and order, excluding derived notifications", () => {
  const expected = [
    { role: "user", content: [{ type: "text", text: "/help" }] },
    { role: "assistant", content: [{ type: "text", text: "help reply" }] },
  ];
  for (const version of [1, 2]) {
    const frames = expected.map((message) => ({
      sessionId: "s",
      update: {
        sessionUpdate:
          message.role === "user"
            ? version === 1
              ? "user_message_chunk"
              : "user_message"
            : version === 1
              ? "agent_message_chunk"
              : "agent_message",
        messageId: message.role,
        content: version === 1 ? message.content[0] : message.content,
      },
    }));
    assertTranscript([...frames, catalog], "s", expected);
    for (const broken of [
      frames.slice(1),
      [...frames, frames[1]],
      frames.toReversed(),
      [{ ...frames[0], sessionId: "foreign" }, frames[1]],
    ]) {
      assert.throws(() => assertTranscript(broken, "s", expected));
    }
    const attachment = {
      type: "resource",
      resource: { uri: "file:///notes.txt", text: "private" },
    };
    const withFile = structuredClone(frames);
    if (version === 1)
      withFile.splice(1, 0, {
        ...frames[0],
        update: { ...frames[0].update, content: attachment },
      });
    else withFile[0].update.content.push(attachment);
    assertTranscript(withFile, "s", [
      { ...expected[0], content: [...expected[0].content, attachment] },
      expected[1],
    ]);
    assert.throws(() =>
      assertTranscript(frames, "s", [
        { ...expected[0], content: [...expected[0].content, attachment] },
        expected[1],
      ]),
    );
  }
});
