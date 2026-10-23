import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectOwnerBusiness, runOwnerBusiness } from "./owner-business.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function fixture(action) {
  const base = resolve(root, "artifacts/verification/owner-business-unit");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(resolve(base, "run-"));
  const project = "antnest-lifecycle-1234abcd";
  try {
    await action({
      root,
      output,
      image: "antnest/agent-acp-service:owner-candidate",
      fixture: { agentID: `agent_${"a".repeat(32)}` },
      config: {
        project,
        credentials: resolve(
          root,
          "artifacts/verification/authenticated-e2e",
          project,
          "credentials",
        ),
        env: {
          ANTNEST_SERVICE_AUTH_UID: "12345",
          ANTNEST_SERVICE_AUTH_GID: "23456",
          ANTNEST_SERVICE_NETWORK_PREFIX: "10.244.45",
        },
      },
    });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

test("an interrupted business client still joins independent owned-container cleanup", async () => {
  await fixture(async (input) => {
    const primary = new Error("client interrupted");
    const abort = new AbortController();
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const calls = [];
    let removed = false,
      settled = false;
    const operation = runOwnerBusiness({
      ...input,
      signal: abort.signal,
      docker: async (args) => {
        calls.push(args);
        if (args[0] === "logs") return "private client diagnostic";
        assert.equal(args[0], "run");
        abort.abort(primary);
        throw primary;
      },
      cleanupDocker: async (args) => {
        calls.push(args);
        if (args[0] === "ps") return removed ? "" : "owned-client-id";
        assert.deepEqual(args, ["rm", "-f", "owned-client-id"]);
        entered.resolve();
        await release.promise;
        removed = true;
        return "";
      },
    }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    let timer;
    try {
      await Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error("cleanup was skipped");
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("cleanup was not entered")),
            1000,
          );
        }),
      ]);
      assert.equal(settled, false);
      assert.equal(removed, false);
      release.resolve();
      const result = await operation;
      assert(result.error instanceof AggregateError);
      assert(result.error.errors.includes(primary));
      assert.equal(removed, true);
      assert.equal(calls.filter((args) => args[0] === "ps").length, 2);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await operation;
    }
  });
});

test("owned-container removal failure preserves the original client failure", async () => {
  await fixture(async (input) => {
    const primary = new Error("client failed"),
      cleanup = new Error("remove failed");
    await assert.rejects(
      runOwnerBusiness({
        ...input,
        docker: async (args) => {
          if (args[0] === "logs") return "diagnostic";
          throw primary;
        },
        cleanupDocker: async (args) => {
          if (args[0] === "ps") return "owned-client-id";
          throw cleanup;
        },
      }),
      (error) => {
        assert(error instanceof AggregateError);
        assert(error.errors.includes(primary));
        assert(error.errors.includes(cleanup));
        return true;
      },
    );
  });
});

test("a late final event page cannot turn parent cancellation into passed business", async () => {
  await fixture(async (input) => {
    const primary = new Error("owner business parent cancelled");
    const abort = new AbortController();
    const cleanupEntered = Promise.withResolvers(),
      cleanupRelease = Promise.withResolvers(),
      eventsEntered = Promise.withResolvers(),
      eventsRelease = Promise.withResolvers();
    const agentId = input.fixture.agentID,
      sessionId = `session_${"b".repeat(32)}`,
      runId = `run_${"c".repeat(32)}`,
      principalId = `user_${"d".repeat(32)}`;
    const prompt = [{ type: "text", text: "foreground during review" }];
    const terminal = {
      state: "completed",
      terminal_class: "completed",
      executor_state: "quiescent",
      tool_effect_state: "none",
      stop_reason: "end_turn",
      error_class: null,
    };
    const clientResult = {
      status: "passed",
      agent_id: agentId,
      session_id: sessionId,
    };
    const runs = [
      {
        id: runId,
        request_id: `request_${"e".repeat(32)}`,
        session_id: sessionId,
        agent_id: agentId,
        principal_id: principalId,
        ...terminal,
      },
    ];
    const audit = {
      run_id: runId,
      session_id: sessionId,
      agent_id: agentId,
      principal_id: principalId,
      ...terminal,
      created_at: "2026-10-23T12:34:56.000001Z",
      updated_at: "2026-10-23T12:34:57.000002Z",
      input: prompt,
      execution_snapshot: {
        providerConnectionId: "foreground-provider",
        modelProfileId: "foreground-model",
        configurationRevision: 1,
        agentSpecRevision: "foreground-spec",
        executionRevision: "foreground-execution",
      },
      unknown_effect_source: null,
      usage_measurements: [],
    };
    const events = {
      stream: "execution",
      next_cursor: null,
      items: [
        {
          id: "message-user",
          sequence: 1,
          kind: "user_message",
          visible: true,
          created_at: audit.created_at,
          payload: {
            kind: "user_message",
            messageId: "message-user",
            content: prompt,
          },
        },
        {
          id: "message-answer",
          sequence: 2,
          kind: "agent_message",
          visible: true,
          created_at: audit.updated_at,
          payload: {
            kind: "agent_message",
            messageId: "message-answer",
            content: [{ type: "text", text: "Foreground request completed." }],
          },
        },
      ],
    };
    assert.equal(
      inspectOwnerBusiness({
        agentId,
        sessionId,
        clientResult,
        runs,
        audit,
        events,
      }).status,
      "passed",
      "the delayed event page must complete an otherwise valid business result",
    );
    const calls = [];
    let removed = false,
      cleanupCompleted = false,
      settled = false;
    const operation = runOwnerBusiness({
      ...input,
      signal: abort.signal,
      fixture: {
        ...input.fixture,
        json: (path) => {
          assert.equal(cleanupCompleted, true);
          calls.push(path);
          if (
            path === `/api/admin/execution-audits?agent_id=${agentId}&limit=100`
          )
            return Promise.resolve({
              items: [{ run_id: runId, session_id: sessionId }],
              next_cursor: null,
            });
          if (path === `/api/admin/execution-audits/${runId}`)
            return Promise.resolve(audit);
          assert.equal(
            path,
            `/api/admin/execution-audits/${runId}/events?stream=execution&limit=100`,
          );
          eventsEntered.resolve();
          return eventsRelease.promise;
        },
      },
      docker: async (args) => {
        if (args[0] === "run") return JSON.stringify(clientResult);
        if (args[0] === "compose") {
          assert(args.includes("ps"));
          assert.equal(args.at(-1), "postgres");
          return "postgres-container";
        }
        if (args[0] === "exec") return JSON.stringify(runs);
        assert.equal(args[0], "inspect");
        if (args[1] === "postgres-container")
          return JSON.stringify([
            {
              Id: "f".repeat(64),
              Config: {
                Labels: {
                  "com.docker.compose.project": input.config.project,
                  "com.docker.compose.service": "postgres",
                },
              },
              State: { Running: true },
            },
          ]);
        assert.equal(args[1], `${input.config.project}-owner-business`);
        return JSON.stringify([
          {
            Config: {
              Image: input.image,
              Labels: { "com.docker.compose.project": input.config.project },
            },
            State: { Running: false, ExitCode: 0 },
          },
        ]);
      },
      cleanupDocker: async (args) => {
        calls.push(args[0]);
        if (args[0] === "ps") return removed ? "" : "owned-client-id";
        assert.deepEqual(args, ["rm", "-f", "owned-client-id"]);
        cleanupEntered.resolve();
        await cleanupRelease.promise;
        removed = true;
        cleanupCompleted = true;
        return "";
      },
    }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    const waitFor = async (entered, label) => {
      let timer;
      try {
        await Promise.race([
          entered,
          operation.then(() => {
            throw new Error(`${label} was skipped`);
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} was not entered`)),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await waitFor(cleanupEntered.promise, "owned-container cleanup");
      assert.equal(settled, false);
      assert.equal(removed, false);
      assert.deepEqual(calls, ["ps", "rm"]);
      cleanupRelease.resolve();
      await waitFor(eventsEntered.promise, "final durable event page");
      assert.equal(cleanupCompleted, true);
      assert.equal(removed, true);
      assert.equal(calls.filter((call) => call === "ps").length, 2);
      assert.equal(calls.length, 6);
      abort.abort(primary);
      await new Promise((complete) => setImmediate(complete));
      assert.equal(
        settled,
        false,
        "cancellation discarded the original event read",
      );
      eventsRelease.resolve(events);
      const result = await operation;
      assert.equal(
        result.error,
        primary,
        "late success replaced parent cancellation",
      );
      assert.equal(result.value, undefined);
    } finally {
      cleanupRelease.resolve();
      eventsRelease.resolve(events);
      await operation;
    }
  });
});
