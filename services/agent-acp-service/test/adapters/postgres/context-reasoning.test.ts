import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { createLegacyRunRepositories } from "../../../src/adapters/postgres/run-repositories.js";

describe("Context reasoning projection", () => {
  it("keeps streamed reasoning with its assistant response and never the next user", async () => {
    const rows = [
      {
        sequence: "1",
        kind: "user_message",
        payload: { content: [{ type: "text", text: "hello" }] },
      },
      {
        sequence: "2",
        kind: "agent_thought",
        payload: { content: [{ type: "text", text: "inspect " }] },
      },
      {
        sequence: "3",
        kind: "agent_thought",
        payload: { content: [{ type: "text", text: "first" }] },
      },
      {
        sequence: "4",
        kind: "agent_message",
        payload: { responseId: "r1", content: [{ type: "text", text: "hello" }] },
      },
      {
        sequence: "5",
        kind: "agent_message",
        payload: { responseId: "r1", content: [{ type: "text", text: " world" }] },
      },
      {
        sequence: "6",
        kind: "agent_thought",
        payload: { content: [{ type: "text", text: "unfinished response" }] },
      },
      {
        sequence: "7",
        kind: "user_message",
        payload: { content: [{ type: "text", text: "retry" }] },
      },
      {
        sequence: "8",
        kind: "agent_message",
        payload: { content: [{ type: "text", text: "fresh" }] },
      },
    ];
    const pool = new Pool();
    const kernel = new PostgresKernel(pool);
    const result = <Row>(data: Row[]) => ({
      rows: data,
      rowCount: data.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    });
    const query = vi
      .spyOn(kernel, "query")
      .mockResolvedValueOnce(
        result([
          {
            through_sequence: "0",
            summary: "prior",
            compaction_prompt_version: "context-summary-v1",
            pinned_message_ids: ["msg-1"],
          },
        ]),
      )
      .mockResolvedValueOnce(
        result([
          {
            id: "msg-1",
            sequence: "1",
            kind: "user_message",
            payload: { content: [{ type: "text", text: "oldest task" }] },
          },
        ]),
      )
      .mockResolvedValueOnce(result(rows))
      .mockResolvedValueOnce(result([]));
    try {
      const context = await createLegacyRunRepositories(
        kernel,
        new AbortController().signal,
      ).contexts.load("session");
      expect(query.mock.calls[2]?.[0]).toContain("'agent_thought'");
      expect(context.checkpoint).toMatchObject({
        throughSequence: 0,
        summary: "prior",
        compactionPromptVersion: "context-summary-v1",
        pinnedMessageIds: ["msg-1"],
      });
      expect(context.pinned).toMatchObject([
        {
          id: "msg-1",
          sequence: 1,
          kind: "user_message",
          content: [{ type: "text", text: "oldest task" }],
        },
      ]);
      expect(context.messages).toHaveLength(4);
      expect(context.messages[1]).toMatchObject({
        sequence: 2,
        endSequence: 5,
        kind: "agent_message",
        content: [{ type: "text", text: "hello world" }],
        thought: [{ type: "text", text: "inspect first" }],
      });
      expect(context.messages[2]).not.toHaveProperty("thought");
      expect(context.messages[3]).not.toHaveProperty("thought");
    } finally {
      query.mockRestore();
      await pool.end();
    }
  });
});
