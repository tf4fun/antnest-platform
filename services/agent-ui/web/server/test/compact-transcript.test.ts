import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  CompactTranscript,
  HistoryCapacityError,
} from "../src/bridge/compact-transcript.ts";

function batch(
  sequence: number,
  runId: string | null,
  messageId: string,
  ...updates: SessionUpdate[]
) {
  return { sequence, runId, messageId, updates };
}

test("Session metadata survives replay updates and live history limiting", () => {
  const transcript = new CompactTranscript(1024);
  assert.deepEqual(transcript.sessionInfo, { title: null, updatedAt: null });
  transcript.apply(batch(1, null, "info-1", {
    sessionUpdate: "session_info_update", title: "Original title",
    updatedAt: "2026-09-24T00:00:00Z",
  }));
  assert.deepEqual(transcript.sessionInfo, {
    title: "Original title", updatedAt: "2026-09-24T00:00:00Z",
  });
  transcript.enableLiveLimit();
  transcript.apply(batch(2, "run-1", "large", {
    sessionUpdate: "agent_message_chunk", messageId: "answer-1",
    content: { type: "text", text: "a".repeat(2048) },
  }));
  assert.equal(transcript.isLimited, true);
  transcript.apply(batch(3, null, "info-2", {
    sessionUpdate: "session_info_update", title: "Updated title",
    updatedAt: "2026-09-24T01:00:00Z",
  }));
  assert.deepEqual(transcript.sessionInfo, {
    title: "Updated title", updatedAt: "2026-09-24T01:00:00Z",
  });
});

test("a sealed live transcript sheds oversized output and keeps a bounded incomplete preview", () => {
  const transcript = new CompactTranscript(1024);
  transcript.apply(batch(1, "run-1", "prompt", {
    sessionUpdate: "user_message_chunk", messageId: "prompt-1",
    content: { type: "text", text: "Question" },
  }));
  transcript.enableLiveLimit();
  transcript.apply(batch(2, "run-1", "large", {
    sessionUpdate: "agent_message_chunk", messageId: "answer-1",
    content: { type: "text", text: "a".repeat(2048) },
  }));
  assert.equal(transcript.isLimited, true);
  assert.deepEqual(transcript.turns(), []);
  assert.deepEqual(transcript.limitedPreview, { text: "a".repeat(2048), truncated: true });
  transcript.apply(batch(3, "run-1", "later", {
    sessionUpdate: "agent_message_chunk", messageId: "answer-1",
    content: { type: "text", text: "b".repeat(4096) },
  }));
  assert.equal(transcript.limitedPreview.text.length, 4096);
  assert.ok(transcript.limitedPreview.text.endsWith("b".repeat(4096)));
  assert.ok(transcript.estimatedRetainedBytes < 20_000);
});

test("stable Run turn retains every native prompt and final answer content block", () => {
  const transcript = new CompactTranscript();
  transcript.apply(
    batch(
      1,
      "run-1",
      "user-event",
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "question" },
      },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "image", data: "AAAA", mimeType: "image/png" },
      },
    ),
  );
  transcript.apply(
    batch(
      2,
      "run-1",
      "answer-event",
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-1",
        content: { type: "text", text: "part one" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-1",
        content: { type: "text", text: "part two" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-2",
        content: {
          type: "resource_link",
          name: "report",
          uri: "file:///workspace/report.pdf",
        },
      },
    ),
  );
  const [turn] = transcript.turns();
  assert.equal(turn?.turnId, "run-1");
  assert.deepEqual(
    turn?.prompt.map((block) => block.type),
    ["text", "image"],
  );
  assert.deepEqual(
    turn?.finalResponse.map((block) => block.type),
    ["text", "text", "resource_link"],
  );
  assert.equal(turn?.outcome, "unknown");
  assert.equal(turn?.processCount, 0);
});

test("thoughts and tools stay in process while later answer remains final", () => {
  const transcript = new CompactTranscript();
  transcript.apply(
    batch(1, "run-1", "intermediate", {
      sessionUpdate: "agent_message_chunk",
      messageId: "intermediate-1",
      content: { type: "text", text: "working" },
    }),
  );
  transcript.apply(
    batch(2, "run-1", "thought", {
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought-1",
      content: { type: "text", text: "reasoning" },
    }),
  );
  transcript.apply(
    batch(3, "run-1", "tool-event", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read file",
      status: "in_progress",
    }),
  );
  transcript.apply(
    batch(4, "run-1", "tool-update", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "file contents" } },
      ],
    }),
  );
  transcript.apply(
    batch(5, "run-1", "answer", {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer-1",
      content: { type: "text", text: "done" },
    }),
  );
  const [turn] = transcript.turns();
  assert.deepEqual(turn?.finalResponse, [{ type: "text", text: "done" }]);
  assert.deepEqual(
    turn?.process.map((item) => item.kind),
    ["thought", "notice", "tool"],
  );
  assert.equal(
    turn?.process.find((item) => item.kind === "tool")?.status,
    "completed",
  );
  assert.equal(
    turn?.process.find((item) => item.kind === "tool")?.content[0]?.type,
    "text",
  );
  assert.ok((turn?.processVersion ?? 0) > 0);
});

test("oversized history fails before mutating a view or accepting a partial batch", () => {
  const transcript = new CompactTranscript(350);
  transcript.apply(
    batch(1, "run-1", "small", {
      sessionUpdate: "user_message_chunk",
      messageId: "user-1",
      content: { type: "text", text: "small" },
    }),
  );
  const before = transcript.turns();
  assert.throws(
    () =>
      transcript.apply(
        batch(2, "run-1", "large", {
          sessionUpdate: "agent_message_chunk",
          messageId: "answer",
          content: { type: "text", text: "x".repeat(1000) },
        }),
      ),
    HistoryCapacityError,
  );
  assert.deepEqual(transcript.turns(), before);
});

test("transcript accounting rises with accepted content and stays put on a rejected batch", () => {
  const transcript = new CompactTranscript(350);
  const initial = transcript.estimatedRetainedBytes;
  transcript.apply(
    batch(1, "run-1", "small", {
      sessionUpdate: "user_message_chunk",
      messageId: "user-1",
      content: { type: "text", text: "small" },
    }),
  );
  const accepted = transcript.estimatedRetainedBytes;
  assert.ok(accepted > initial);
  assert.throws(
    () =>
      transcript.apply(
        batch(2, "run-1", "large", {
          sessionUpdate: "agent_message_chunk",
          messageId: "answer",
          content: { type: "text", text: "x".repeat(1000) },
        }),
      ),
    HistoryCapacityError,
  );
  assert.equal(transcript.estimatedRetainedBytes, accepted);
});

test("initial configuration and later content share one Session history budget", () => {
  const options = [
    {
      id: "auto",
      name: "Automatic",
      description: "x".repeat(100),
      type: "boolean" as const,
      currentValue: true,
    },
  ];
  const update: SessionUpdate = {
    sessionUpdate: "user_message_chunk",
    messageId: "user-1",
    content: { type: "text", text: "y".repeat(100) },
  };
  const configBytes = Buffer.byteLength(JSON.stringify(options));
  const updateBytes = Buffer.byteLength(JSON.stringify([update]));
  const budget = Math.max(configBytes, updateBytes) +
    Buffer.byteLength(JSON.stringify({ title: null, updatedAt: null })) + 10;
  assert.ok(configBytes + updateBytes > budget);
  const transcript = new CompactTranscript(budget);
  transcript.setInitialConfigOptions(options);
  const before = transcript.estimatedRetainedBytes;
  assert.throws(
    () => transcript.apply(batch(1, "run-1", "user", update)),
    HistoryCapacityError,
  );
  assert.equal(transcript.estimatedRetainedBytes, before);
  assert.equal(transcript.turnCount, 0);
});

test("tool arguments and raw output remain available in process detail", () => {
  const transcript = new CompactTranscript();
  transcript.apply(
    batch(1, "run-1", "tool-event", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read file",
      status: "in_progress",
      rawInput: { path: "notes.txt" },
    }),
  );
  transcript.apply(
    batch(2, "run-1", "tool-result", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { lines: ["a", "b"] },
    }),
  );
  const [tool] = transcript.turns()[0]!.process;
  assert.equal(tool?.status, "completed");
  assert.ok(
    tool?.content.some(
      (block) => block.type === "text" && block.text.includes("notes.txt"),
    ),
  );
  assert.ok(
    tool?.content.some(
      (block) => block.type === "text" && block.text.includes('"a"'),
    ),
  );
});

test("a fixed history cut pages older turns without copying every turn", () => {
  const transcript = new CompactTranscript();
  for (let index = 0; index < 25; index++)
    transcript.apply(
      batch(index + 1, `run-${index}`, `event-${index}`, {
        sessionUpdate: "user_message_chunk",
        messageId: `user-${index}`,
        content: { type: "text", text: String(index) },
      }),
    );
  const cut = transcript.turnCount;
  const recent = transcript.pageBefore(cut, 20);
  assert.equal(recent.items.length, 20);
  assert.equal(recent.items[0]?.turnId, "run-5");
  assert.equal(recent.nextBefore, 5);
  transcript.apply(
    batch(26, "run-25", "event-25", {
      sessionUpdate: "user_message_chunk",
      messageId: "user-25",
      content: { type: "text", text: "new" },
    }),
  );
  const older = transcript.pageBefore(recent.nextBefore!, 20);
  assert.deepEqual(
    older.items.map((turn) => turn.turnId),
    ["run-0", "run-1", "run-2", "run-3", "run-4"],
  );
  assert.equal(older.nextBefore, null);
  const forward = transcript.pageAfter(5, 20);
  assert.deepEqual(forward.items.map((turn) => turn.turnId),
    Array.from({ length: 20 }, (_, offset) => `run-${offset + 5}`));
  assert.equal(forward.nextAfter, 25);
  assert.deepEqual(transcript.pageAfter(forward.nextAfter!, 20).items.map((turn) => turn.turnId),
    ["run-25"]);
  assert.equal(transcript.pageAfter(25, 20).nextAfter, null);
  assert.throws(() => transcript.pageAfter(-1, 20), /boundary/i);
  assert.throws(() => transcript.pageAfter(27, 20), /boundary/i);
});

test("usage and configuration updates remain Session metadata outside turn history", () => {
  const transcript = new CompactTranscript();
  const initial = [
    {
      id: "mode",
      name: "Mode",
      type: "select" as const,
      currentValue: "review",
      options: [{ value: "review", name: "Review" }],
    },
  ];
  const updated = [{ ...initial[0]!, currentValue: "auto" }];
  transcript.setInitialConfigOptions(initial);
  assert.deepEqual(transcript.configOptions, initial);
  transcript.apply(
    batch(1, null, "config-1", {
      sessionUpdate: "config_option_update",
      configOptions: updated,
    }),
  );
  transcript.setInitialConfigOptions(initial);
  assert.deepEqual(transcript.configOptions, updated);
  const version = transcript.configurationSequence;
  transcript.applyConfigurationResponse(initial, version - 1);
  assert.deepEqual(transcript.configOptions, updated);
  transcript.applyConfigurationResponse(initial, version);
  assert.deepEqual(transcript.configOptions, initial);
  transcript.apply(
    batch(2, null, "usage-1", {
      sessionUpdate: "usage_update",
      used: 10,
      size: 100,
      cost: { amount: 0.03, currency: "USD" },
    }),
  );
  transcript.apply(
    batch(3, null, "usage-2", {
      sessionUpdate: "usage_update",
      used: 5,
      size: 200,
    }),
  );
  assert.deepEqual(transcript.usage, {
    used: 5,
    size: 200,
    cost: { amount: 0.03, currency: "USD" },
  });
  assert.equal(transcript.turnCount, 0);
});

test("configuration projection omits ACP metadata from browser choices", () => {
  const transcript = new CompactTranscript();
  transcript.setInitialConfigOptions([
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: "review",
      options: [
        { value: "review", name: "Review", _meta: { secret: "hidden" } },
      ],
      _meta: { secret: "hidden" },
    },
  ]);
  const publicOptions = transcript.configOptions;
  assert.equal(JSON.stringify(publicOptions).includes("hidden"), false);
  assert.equal(publicOptions[0]?.id, "mode");
});
