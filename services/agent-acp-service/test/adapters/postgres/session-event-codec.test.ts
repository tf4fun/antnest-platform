import { describe, expect, it } from "vitest";

import {
  decodeSessionEvent,
  encodeSessionEvent,
} from "../../../src/adapters/postgres/session-event-codec.js";
import type { SessionEvent } from "../../../src/ports/acp-application.js";

describe("Session event storage codec", () => {
  it("round trips plan entries and all model-call argument copies as escaped JSON", () => {
    const entries = [
      { content: "plan\0\ud800", priority: "high" as const, status: "pending" as const },
    ];
    const events: SessionEvent[] = [
      { kind: "plan", entries },
      {
        kind: "agent_message",
        messageId: "message",
        content: [],
        toolCalls: [{ id: "call", name: "update_plan", arguments: { entries } }],
      },
      {
        kind: "tool_call",
        initial: true,
        toolCallId: "call",
        title: "Plan",
        status: "completed",
        arguments: { entries },
      },
    ];
    for (const event of events) {
      const stored = encodeSessionEvent(event);
      expect(stored).not.toHaveProperty("entries");
      expect(stored).not.toHaveProperty("toolCalls");
      expect(stored).not.toHaveProperty("arguments");
      expect(decodeSessionEvent(stored)).toEqual(event);
    }
  });
  it("stores file observations separately as escaped JSON without changing model content", () => {
    const event: SessionEvent = {
      kind: "tool_call",
      initial: false,
      toolCallId: "write",
      status: "completed",
      content: [{ type: "text", text: "done" }],
      rawOutput: { bytes_written: 5 },
      file: {
        path: "/workspace/notes.txt",
        change: { before: "BEFORE\0", after: "AFTER\0\u{1f600}" },
      },
    };
    const stored = encodeSessionEvent(event);
    expect(stored).not.toHaveProperty("file");
    expect(stored.fileJson).toBe(JSON.stringify(event.file));
    expect(stored).toMatchObject({ content: event.content });
    expect(decodeSessionEvent(stored)).toEqual(event);
    expect(decodeSessionEvent(stored)).not.toHaveProperty("fileJson");
  });
  it.each([
    null,
    false,
    0,
    "",
    { "nul\0key": "\0", lone: "\ud800", literal: "\\u0000", nested: ["\u{1f600}"] },
  ])("round trips raw output without changing its value: %j", (rawOutput) => {
    const event: SessionEvent = {
      kind: "tool_call",
      initial: false,
      toolCallId: "tool",
      status: "completed",
      rawOutput,
    };
    const stored = encodeSessionEvent(event);
    expect(stored).not.toHaveProperty("rawOutput");
    expect(stored.rawOutputJson).toBe(JSON.stringify(rawOutput));
    const decoded = decodeSessionEvent(stored);
    expect(decoded).toEqual(event);
    expect(decoded).not.toHaveProperty("rawOutputJson");
    expect(event.rawOutput).toEqual(rawOutput);
  });

  it("does not add raw output to events without results", () => {
    const event: SessionEvent = {
      kind: "tool_call",
      initial: false,
      toolCallId: "tool",
      status: "failed",
    };
    expect(decodeSessionEvent(encodeSessionEvent(event))).toEqual(event);
    expect(encodeSessionEvent(event)).not.toHaveProperty("rawOutputJson");
  });
});
