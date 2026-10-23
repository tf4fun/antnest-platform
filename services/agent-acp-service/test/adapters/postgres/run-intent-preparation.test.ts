import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createLegacyRunRepositories } from "../../../src/adapters/postgres/run-repositories.js";
import { bridgeIntentDigest } from "../../../src/domain/bridge-intent.js";
import type { CreateRunIntentInput } from "../../../src/ports/run-repository.js";

function fixture() {
  let transactionOpen = false;
  let insertJson: string | undefined;
  let digest: string | undefined;
  let insertValues: unknown[] = [];
  const inserted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const reads: boolean[] = [];
  const queries: string[] = [];
  const input: CreateRunIntentInput = {
    runId: "run",
    requestId: "request",
    sessionId: "session",
    userMessageId: "message",
    expectedAccessRevision: "access",
    createdAt: new Date(0),
    bridgeIntent: { intentId: "intent", expectedAppendVersion: 0 },
    prompt: [
      {
        type: "text",
        get text() {
          reads.push(transactionOpen);
          return "a".repeat(1024 * 1024);
        },
      },
    ],
  };
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes("FROM acp_sessions"))
      return {
        rows: [
          {
            organization_id: "organization-1",
            agent_id: "agent-1",
            state: "active",
            client_mcp_revision_id: "revision",
            configuration: {},
            append_version: "0",
          },
        ],
      };
    if (sql.includes("SELECT intent_digest")) return { rows: [] };
    if (sql.includes("SELECT id FROM runs WHERE session_id")) return { rows: [] };
    if (sql.includes("INSERT INTO runs")) {
      insertValues = values;
      insertJson = values[6] as string;
      digest = values[10] as string;
      inserted.resolve();
      await release.promise;
      const row = {
        id: values[0],
        request_id: values[1],
        session_id: values[2],
        client_mcp_revision_id: "revision",
        expected_access_revision: values[4],
        state: "admitting",
        pending_user_message_id: values[5],
        session_configuration: {},
        ...(sql.split("RETURNING")[1]?.includes("input_prompt")
          ? { input_prompt: JSON.parse(insertJson) as CreateRunIntentInput["prompt"] }
          : {}),
      };
      return { rows: [row] };
    }
    if (sql.includes("UPDATE acp_sessions")) return { rows: [] };
    throw new Error("Unexpected repository query");
  };
  const repository = createLegacyRunRepositories(
    {
      transaction: async (operation: (client: { query: typeof query }) => Promise<unknown>) => {
        order.push("transaction");
        transactionOpen = true;
        try {
          return await operation({ query });
        } finally {
          transactionOpen = false;
        }
      },
    } as never,
    new AbortController().signal,
  ).runs;
  return {
    repository,
    input,
    reads,
    queries,
    order,
    inserted,
    release,
    stored: () => ({ prompt: JSON.parse(insertJson!) as CreateRunIntentInput["prompt"], digest }),
    bindings: () => insertValues,
  };
}

describe("Run intent preparation outside the Session transaction", () => {
  it("reads the original body before acquiring a transaction and does not return the full SQL body", async () => {
    const test = fixture();
    const pending = test.repository.createRunIntent(test.input);
    try {
      await test.inserted.promise;
      test.release.resolve();
      const result = await pending;
      expect(result.prompt).toEqual(test.stored().prompt);
      expect(test.reads.length).toBeGreaterThan(0);
      expect(test.reads.every((locked) => !locked)).toBe(true);
      expect(
        test.queries.find((sql) => sql.includes("INSERT INTO runs"))!.split("RETURNING")[1],
      ).not.toContain("input_prompt");
    } finally {
      test.release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("lets a ready control task run before the large upload opens its transaction", async () => {
    const test = fixture();
    const ready = nextTurn().then(() => {
      test.order.push("control");
    });
    const pending = test.repository.createRunIntent(test.input);
    try {
      await test.inserted.promise;
      test.release.resolve();
      await Promise.all([pending, ready]);
      expect(test.order).toEqual(["control", "transaction"]);
    } finally {
      test.release.resolve();
      await Promise.allSettled([pending, ready]);
    }
  });

  it("binds digest, stored body and returned body to the original input snapshot", async () => {
    const test = fixture();
    const original = [{ type: "text", text: "original", nested: { value: "before" } }];
    test.input.prompt = original;
    const pending = test.repository.createRunIntent(test.input);
    try {
      await test.inserted.promise;
      original[0]!.text = "changed";
      original[0]!.nested.value = "after";
      test.release.resolve();
      const result = await pending;
      const expected = [{ type: "text", text: "original", nested: { value: "before" } }];
      expect(test.stored()).toEqual({ prompt: expected, digest: bridgeIntentDigest(0, expected) });
      expect(result.prompt).toEqual(expected);
      expect(result.prompt).not.toBe(original);
    } finally {
      test.release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("captures target identity and append version before yielding preparation", async () => {
    const test = fixture();
    const original = JSON.parse(
      JSON.stringify(test.input.prompt),
    ) as CreateRunIntentInput["prompt"];
    const pending = test.repository.createRunIntent(test.input);
    test.input.runId = "replacement";
    test.input.requestId = "replacement-request";
    test.input.sessionId = "replacement-session";
    test.input.userMessageId = "replacement-message";
    test.input.expectedAccessRevision = "replacement-access";
    test.input.bridgeIntent!.intentId = "replacement-intent";
    test.input.bridgeIntent!.expectedAppendVersion = 9;
    test.input.createdAt.setTime(999);
    test.input.prompt = [{ type: "text", text: "replacement" }];
    try {
      await test.inserted.promise;
      test.release.resolve();
      const result = await pending;
      expect(result.id).toBe("run");
      expect(result.sessionId).toBe("session");
      expect(test.bindings()).toEqual([
        "run",
        "request",
        "session",
        "revision",
        "access",
        "message",
        expect.any(String),
        new Date(0),
        "{}",
        "intent",
        bridgeIntentDigest(0, original),
        0,
        1,
        "organization-1",
        "agent-1",
        null,
        null,
        null,
        null,
      ]);
      expect(test.stored()).toEqual({ prompt: original, digest: bridgeIntentDigest(0, original) });
    } finally {
      test.release.resolve();
      await Promise.allSettled([pending]);
    }
  });
});
