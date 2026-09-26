import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  CompactTranscript,
} from "../src/bridge/compact-transcript.ts";

function batch(
  sequence: number,
  runId: string | null,
  messageId: string,
  ...updates: SessionUpdate[]
) {
  return { sequence, runId, messageId, updates };
}

test("available commands replace Session metadata without retaining wire history", () => {
  const transcript = new CompactTranscript();
  const emptyBytes = transcript.estimatedRetainedBytes;
  const commands = [{ name: "help", description: "Show help", _meta: { private: "omit" },
    input: { hint: "topic", _meta: { private: "omit" } } }];
  transcript.apply(batch(1, null, "catalog", {
    sessionUpdate: "available_commands_update", availableCommands: commands,
  }));
  assert.deepEqual(transcript.availableCommands,
    [{ name: "help", description: "Show help", input: { hint: "topic" } }]);
  assert.equal(transcript.turnCount, 0);
  assert.equal(transcript.conversationRevision, 0);
  const retained = transcript.estimatedRetainedBytes;
  assert.ok(retained > emptyBytes);
  for (let i = 0; i < 20; i++)
    assert.equal(transcript.applyCommandsNotification(commands), false);
  assert.equal(transcript.estimatedRetainedBytes, retained);
  const snapshot = transcript.availableCommands;
  snapshot[0]!.name = "changed";
  assert.equal(transcript.availableCommands[0]!.name, "help");
  assert.equal(transcript.applyCommandsNotification([]), true);
  assert.deepEqual(transcript.availableCommands, []);
  assert.equal(transcript.estimatedRetainedBytes, emptyBytes);
});

test("tool patches replace current fields, retain omitted fields and clear empty collections", () => {
  const transcript = new CompactTranscript();
  transcript.apply(batch(1, "run", "start", {
    sessionUpdate: "tool_call", toolCallId: "tool", title: "Read", status: "in_progress",
    rawInput: { path: "notes.txt" }, rawOutput: { result: "obsolete" },
    content: [{ type: "content", content: { type: "text", text: "obsolete output" } }],
  }));
  const before = transcript.turns();
  transcript.apply(batch(2, "run", "result", {
    sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed",
    rawOutput: { result: "current" },
    content: [{ type: "content", content: { type: "text", text: "current output" } }],
  }));
  transcript.apply(batch(3, "run", "title", {
    sessionUpdate: "tool_call_update", toolCallId: "tool", title: "Read complete",
  }));
  const current = transcript.turns()[0]!.process[0]!;
  assert.equal(current.status, "completed");
  assert.equal(current.summary, "Read complete");
  assert.deepEqual(current.content, [
    { type: "text", text: 'Input: {"path":"notes.txt"}' },
    { type: "text", text: 'Output: {"result":"current"}' },
    { type: "text", text: "current output" },
  ]);
  assert.deepEqual(current.toolSections,
    { inputIndex: 0, outputIndex: 1, detailStartIndex: 2 });
  assert.match(JSON.stringify(before), /obsolete/u);
  transcript.apply(batch(4, "run", "clear", {
    sessionUpdate: "tool_call_update", toolCallId: "tool", content: [], status: null,
  }));
  assert.equal(transcript.turns()[0]!.process[0]!.status, "completed");
  assert.deepEqual(transcript.turns()[0]!.process[0]!.content, current.content.slice(0, 2));
  assert.deepEqual(transcript.turns()[0]!.process[0]!.toolSections,
    { inputIndex: 0, outputIndex: 1, detailStartIndex: 2 });
});

test("live process revisions identify changed indices within a bounded window", () => {
  const transcript = new CompactTranscript();
  transcript.apply(batch(1, "run", "tool-start", { sessionUpdate: "tool_call",
    toolCallId: "tool", title: "Read", status: "in_progress" }));
  transcript.apply(batch(2, "run", "tool-result", { sessionUpdate: "tool_call_update",
    toolCallId: "tool", status: "completed" }));
  transcript.apply(batch(3, "run", "thought", { sessionUpdate: "agent_thought_chunk",
    messageId: "thought", content: { type: "text", text: "Next" } }));
  assert.deepEqual(transcript.processChanges("run"),
    { fromVersion: 2, indices: [1] });
  for (let sequence = 4; sequence <= 66; sequence++)
    transcript.apply(batch(sequence, "run", `change-${sequence}`, {
      sessionUpdate: "tool_call_update", toolCallId: "tool", title: `Read ${sequence}` }));
  const changes = transcript.processChanges("run");
  assert.deepEqual(changes?.indices, [0]);
  assert.ok(changes && changes.fromVersion >= 58 && changes.fromVersion < 66,
    "Only a bounded number of consecutive same-item changes may be coalesced");
});

test("live change tracking is charged to retained bytes and released at terminal outcome", () => {
  const transcript = new CompactTranscript();
  transcript.apply(batch(1, "run", "start", { sessionUpdate: "tool_call",
    toolCallId: "tool", title: "Read", status: "in_progress" }));
  const first = transcript.estimatedRetainedBytes;
  for (let sequence = 2; sequence <= 21; sequence++)
    transcript.apply(batch(sequence, "run", `change-${sequence}`, {
      sessionUpdate: "tool_call_update", toolCallId: "tool", title: "Read" }));
  const full = transcript.estimatedRetainedBytes;
  assert.ok(full >= first);
  transcript.apply(batch(22, "run", "change-22", {
    sessionUpdate: "tool_call_update", toolCallId: "tool", title: "Read" }));
  assert.equal(transcript.estimatedRetainedBytes, full);
  transcript.setOutcome("run", "completed");
  assert.deepEqual(transcript.processChanges("run"), { fromVersion: 22, indices: [] });
  assert.ok(transcript.estimatedRetainedBytes < full);
});

test("a sparse update after an answer does not move the answer into process", () => {
  const transcript = new CompactTranscript();
  transcript.apply(batch(1, "run", "tool", {
    sessionUpdate: "tool_call", toolCallId: "tool", title: "Read", status: "completed",
  }));
  transcript.apply(batch(2, "run", "answer", {
    sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "done" },
  }));
  transcript.apply(batch(3, "run", "title", {
    sessionUpdate: "tool_call_update", toolCallId: "tool", title: "Read complete",
  }));
  assert.deepEqual(transcript.turns()[0]!.finalResponse, [{ type: "text", text: "done" }]);
});

test("anonymous plan updates replace the current plan in place within their Run", () => {
  const transcript = new CompactTranscript();
  const entry = { content: "Read", priority: "medium" as const, status: "in_progress" as const };
  transcript.apply(batch(1, "run", "plan-1", { sessionUpdate: "plan", entries: [entry] }));
  const original = transcript.turns()[0]!.process[0]!;
  transcript.apply(batch(2, "run", "plan-2", {
    sessionUpdate: "plan", entries: [{ ...entry, status: "completed" }],
  }));
  const process = transcript.turns()[0]!.process;
  assert.equal(process.length, 1);
  assert.equal(process[0]!.id, original.id);
  assert.deepEqual(process[0]!.content, [{ type: "text", text: JSON.stringify([{ ...entry, status: "completed" }]) }]);
  transcript.apply(batch(3, "other-run", "plan-3", { sessionUpdate: "plan", entries: [entry] }));
  assert.equal(transcript.turns()[1]!.process.length, 1);
});

test("retained accounting replaces metadata and tool results instead of accumulating wire traffic", () => {
  const transcript = new CompactTranscript();
  const usage = { sessionUpdate: "usage_update" as const, used: 1, size: 1000 };
  transcript.apply(batch(1, null, "usage-1", usage));
  const bytes = transcript.estimatedRetainedBytes;
  for (let i = 2; i <= 100; i++) transcript.apply(batch(i, null, `usage-${i}`, usage));
  assert.equal(transcript.estimatedRetainedBytes, bytes);
  transcript.apply(batch(101, "run", "large", {
    sessionUpdate: "tool_call", toolCallId: "tool", title: "Read", rawOutput: { text: "x".repeat(10000) },
  }));
  const large = transcript.estimatedRetainedBytes;
  transcript.apply(batch(102, "run", "small", {
    sessionUpdate: "tool_call_update", toolCallId: "tool", rawOutput: { text: "x" },
  }));
  assert.ok(transcript.estimatedRetainedBytes < large - 9000);
  const small = transcript.estimatedRetainedBytes;
  transcript.apply(batch(103, "run", "same", {
    sessionUpdate: "tool_call_update", toolCallId: "tool", rawOutput: { text: "x" },
  }));
  assert.equal(transcript.estimatedRetainedBytes, small);
});

test("valid large history remains complete and accepts subsequent updates", () => {
  const transcript = new CompactTranscript();
  const text = "x".repeat(65 * 1024 * 1024);
  transcript.apply(batch(1, "run", "large", {
    sessionUpdate: "agent_message_chunk", messageId: "answer",
    content: { type: "text", text },
  }));
  transcript.apply(batch(2, null, "info", {
    sessionUpdate: "session_info_update", title: "Large session",
  }));
  transcript.apply(batch(3, "next-run", "prompt", {
    sessionUpdate: "user_message_chunk", content: { type: "text", text: "continue" },
  }));
  assert.equal(transcript.turnCount, 2);
  assert.equal(transcript.turnById("run")!.finalResponse[0]!.type, "text");
  assert.equal((transcript.turnById("run")!.finalResponse[0] as { text: string }).text.length, text.length);
  assert.equal(transcript.sessionInfo.title, "Large session");
  assert.ok(transcript.estimatedRetainedBytes >= text.length);
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

test("accounting tracks current configuration and Session metadata alongside content", () => {
  const transcript = new CompactTranscript();
  const initial = transcript.estimatedRetainedBytes;
  const options = [{ id: "auto", name: "Automatic", type: "boolean" as const,
    currentValue: true, description: "x".repeat(10000) }];
  transcript.setInitialConfigOptions(options);
  assert.ok(transcript.estimatedRetainedBytes >= initial + 10000);
  const configured = transcript.estimatedRetainedBytes;
  transcript.applyConfigurationNotification(options);
  assert.equal(transcript.estimatedRetainedBytes, configured);
  transcript.applyConfigurationNotification([]);
  assert.equal(transcript.estimatedRetainedBytes, initial);
  transcript.applySessionInfoNotification({ sessionUpdate: "session_info_update", title: "Title" });
  const titled = transcript.estimatedRetainedBytes;
  transcript.applySessionInfoNotification({ sessionUpdate: "session_info_update", title: "Title" });
  assert.equal(transcript.estimatedRetainedBytes, titled);
  transcript.apply(batch(1, "run", "input", { sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "prompt" } }));
  assert.ok(transcript.estimatedRetainedBytes > titled);
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
