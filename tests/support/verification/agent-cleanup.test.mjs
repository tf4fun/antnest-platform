import assert from "node:assert/strict";
import test from "node:test";
import { withAgentCleanup } from "./agent-cleanup.mjs";
import { annotateFailure, summarizeFailure } from "./failure.mjs";

test("cleanup observes Agents created during action and returns the business result", async () => {
  const agents = [],
    calls = [];
  const api = async (...args) => {
    calls.push(args);
    return args[0].endsWith("/delete")
      ? { request_id: "op" }
      : { state: "completed" };
  };
  assert.equal(
    await withAgentCleanup(agents, api, async () => {
      agents.push("a");
      return 42;
    }),
    42,
  );
  assert.deepEqual(calls, [
    ["/api/admin/agents/a/delete", {}, 202],
    ["/api/admin/operations/op"],
  ]);
});

test("cleanup attempts every owned Agent and retains both primary and cleanup failures", async () => {
  const primary = new assert.AssertionError({ message: "private-business" });
  const deleted = [];
  const api = async (path) => {
    if (path.endsWith("/delete")) {
      deleted.push(path);
      if (deleted.length === 1)
        throw annotateFailure(new Error("private-transport"), {
          request_phase: "fetch",
          transport_code: "ECONNRESET",
        });
      return { request_id: "op" };
    }
    return {
      kind: "delete",
      phase: "runtime_delete",
      state: "failed",
      error_detail: "private-controller",
    };
  };
  await assert.rejects(
    withAgentCleanup(["a", "b"], api, async () => {
      throw primary;
    }),
    (error) => {
      const summary = summarizeFailure(error);
      assert.equal(summary.stage, "business-and-agent-cleanup");
      assert.equal(error.errors[0], primary);
      const failures = summary.errors[1].errors;
      assert.equal(failures[0].agent_index, 0);
      assert.equal(failures[0].cleanup_phase, "delete-request");
      assert.equal(failures[0].transport_code, "ECONNRESET");
      assert.equal(failures[1].agent_index, 1);
      assert.equal(failures[1].cleanup_phase, "operation-poll");
      assert.equal(failures[1].reason, "operation-failed");
      assert.equal(failures[1].operation_phase, "runtime_delete");
      assert(!JSON.stringify(summary).includes("private"));
      return true;
    },
  );
  assert.equal(deleted.length, 2);
});

test("operation timeout reports the last state without retrying deletion", async () => {
  let now = 0,
    deletes = 0;
  await assert.rejects(
    withAgentCleanup(
      ["a"],
      async (path) => {
        if (path.endsWith("/delete")) {
          deletes++;
          return { request_id: "op" };
        }
        return { kind: "delete", phase: "network_release", state: "running" };
      },
      async () => {},
      {
        now: () => now,
        wait: async (ms) => {
          now += ms;
        },
      },
    ),
    (error) => {
      const summary = summarizeFailure(error).errors[0];
      assert.equal(summary.reason, "operation-timeout");
      assert.equal(summary.timeout_ms, 120000);
      assert.equal(summary.operation_state, "running");
      assert.equal(summary.operation_phase, "network_release");
      return true;
    },
  );
  assert.equal(deletes, 1);
  assert.equal(now, 120000);
});

test("successful cleanup preserves the exact business failure", async () => {
  const primary = new Error("private");
  await assert.rejects(
    withAgentCleanup(
      ["a"],
      async (path) =>
        path.endsWith("/delete")
          ? { request_id: "op" }
          : { state: "completed" },
      async () => {
        throw primary;
      },
    ),
    (error) => error === primary,
  );
});

for (const response of [null, {}, { request_id: "" }])
  test(`invalid delete response ${JSON.stringify(response)} fails before polling`, async () => {
    let calls = 0;
    await assert.rejects(
      withAgentCleanup(
        ["a"],
        async () => {
          calls++;
          return response;
        },
        async () => {},
      ),
      (error) => {
        assert.equal(
          summarizeFailure(error).errors[0].reason,
          "delete-response-invalid",
        );
        return true;
      },
    );
    assert.equal(calls, 1);
  });

test("unknown operation states fail and exclude arbitrary lifecycle values", async () => {
  await assert.rejects(
    withAgentCleanup(
      ["a"],
      async (path) =>
        path.endsWith("/delete")
          ? { request_id: "op" }
          : { state: "private", kind: "private", phase: "private" },
      async () => {},
    ),
    (error) => {
      const summary = summarizeFailure(error).errors[0];
      assert.equal(summary.reason, "operation-response-invalid");
      assert.equal(summary.operation_state, undefined);
      assert(!JSON.stringify(summary).includes("private"));
      return true;
    },
  );
});
