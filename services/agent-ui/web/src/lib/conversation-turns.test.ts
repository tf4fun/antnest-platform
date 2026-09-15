import assert from "node:assert/strict";
import test from "node:test";
import { conversationTurns } from "./conversation-turns.ts";
import type { Message } from "./types.ts";

const messages: Message[] = [
  { id: "prompt", role: "user", content: "Read the report" },
  { id: "intro", role: "assistant", content: "I will check the file." },
  {
    id: "thought",
    role: "assistant",
    presentation: "thought",
    content: "Look at the numbers",
  },
  {
    id: "tool",
    role: "assistant",
    content: "",
    activities: [
      {
        id: "read",
        tool: "read",
        label: "Read report",
        status: "completed",
        summary: "Completed",
      },
    ],
  },
  { id: "answer", role: "assistant", content: "Revenue grew." },
];

test("projects prompts, process and answer without mutating ACP history", () => {
  const original = JSON.stringify(messages);
  const [turn] = conversationTurns(messages);
  assert.equal(turn.id, "prompt");
  assert.deepEqual(turn.prompt, messages[0]);
  assert.deepEqual(turn.process, messages.slice(1, 4));
  assert.equal(turn.output, messages[4]);
  assert.deepEqual(turn.response, messages.slice(1));
  assert.equal(JSON.stringify(messages), original);
});

test("each user prompt separates exchanges; orphan history and notices are retained", () => {
  const turns = conversationTurns([
    { id: "orphan", role: "assistant", content: "Saved history" },
    ...messages,
    { id: "notice", role: "system", content: "Environment reset" },
    { id: "next", role: "user", content: "Next question" },
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].output?.id, "orphan");
  assert.equal(turns[1].notices[0].content, "Environment reset");
  assert.equal(turns[2].prompt?.id, "next");
  assert.deepEqual(turns[2].response, []);
});

test("trailing tools do not promote an intermediate sentence into an answer", () => {
  const [turn] = conversationTurns(messages.slice(0, 4));
  assert.equal(turn.output, undefined);
  assert.deepEqual(turn.process, messages.slice(1, 4));
});

test("attachments count as answers while reasoning and system notices never do", () => {
  const attachment = {
    id: "file",
    name: "report.txt",
    kind: "file" as const,
    sizeLabel: "12 B",
  };
  const [turn] = conversationTurns([
    ...messages.slice(0, 4),
    {
      id: "attachment",
      role: "assistant",
      content: "",
      attachments: [attachment],
    },
    {
      id: "thought2",
      role: "assistant",
      presentation: "thought",
      content: "Done thinking",
    },
    { id: "system", role: "system", content: "Notice" },
  ]);
  assert.equal(turn.output?.id, "attachment");
  assert.equal(turn.process.at(-1)?.id, "thought2");
  assert.equal(turn.notices.length, 1);
});

test("empty history produces no fabricated exchange", () => {
  assert.deepEqual(conversationTurns([]), []);
});
