import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { runOwnerClientSession } from "./owner-business-client.mjs";

const agentId = `agent_${"1".repeat(32)}`;
const sessionId = `session_${"2".repeat(32)}`;
const member = {
  organization_slug: "stage3",
  email: "c4-member@example.com",
  password: "c4-member-password",
};
const privateValues = [
  "PRIVATE_OWNER_COOKIE",
  "PRIVATE_OWNER_ACCESS_TOKEN",
  "PRIVATE_OWNER_CSRF",
];

function fixture({
  businessError,
  resourceError,
  logoutError,
  heldCleanup = false,
  heldLogout = false,
} = {}) {
  const calls = [];
  const browserCalls = [];
  const tasks = [];
  const controller = new AbortController();
  const cleanupEntered = Promise.withResolvers();
  const releaseCleanup = Promise.withResolvers();
  if (!heldCleanup) releaseCleanup.resolve();
  const logoutEntered = Promise.withResolvers();
  const releaseLogout = Promise.withResolvers();
  if (!heldLogout) releaseLogout.resolve();
  const principal = {
    organization_id: "organization_fixture",
    user_id: "user_fixture",
  };
  const telemetry = {};
  const client = {
    updates: [],
    async request(method, params, timeout) {
      calls.push(method);
      if (method === "new") {
        assert.deepEqual(params, { cwd: "/workspace", mcpServers: [] });
        return { sessionId };
      }
      assert.equal(method, "prompt");
      assert.equal(timeout, 90000);
      assert.deepEqual(params, {
        sessionId,
        prompt: [{ type: "text", text: "foreground during review" }],
      });
      if (businessError) throw businessError;
      client.updates.push({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: `message_${"3".repeat(32)}`,
          content: { type: "text", text: "Foreground request completed." },
        },
      });
      return { stopReason: "end_turn" };
    },
  };
  const browser = {
    async request(path, options = {}) {
      browserCalls.push({ path, options });
      const method =
        options.method ?? (options.body === undefined ? "GET" : "POST");
      if (path === "/api/session/login") {
        calls.push("login");
        assert.equal(method, "POST");
        assert.deepEqual(options.body, member);
        browser.cookie = privateValues[0];
        browser.accessToken = privateValues[1];
        browser.csrf = privateValues[2];
        return { status: 200, body: { principal } };
      }
      // Reject the original POST /api/session/logout route rather than making
      // the fixture accept an endpoint the real Gateway does not implement.
      assert.equal(
        path,
        "/api/session",
        "logout must use the actual Gateway session route",
      );
      assert.equal(method, "DELETE");
      assert.equal(options.status, 204);
      assert.equal(Object.hasOwn(options, "body"), false);
      calls.push("logout");
      const task = (async () => {
        logoutEntered.resolve();
        await releaseLogout.promise;
        if (logoutError) throw logoutError;
        return { status: 204, body: null };
      })();
      tasks.push(task);
      void task.catch(() => {});
      return task;
    },
  };
  const input = {
    agentId,
    browser,
    telemetry,
    signal: controller.signal,
    async open(profile, actualAgent, actualBrowser, options) {
      calls.push("open");
      assert.deepEqual(profile, { version: 1 });
      assert.equal(actualAgent, agentId);
      assert.equal(actualBrowser, browser);
      assert.equal(options.principal, principal);
      assert.equal(options.telemetry, telemetry);
      assert.equal(options.signal, controller.signal);
      assert.deepEqual(new Set(options.secrets), new Set(privateValues));
      return client;
    },
    withResources(clients, actualTelemetry, action) {
      const task = (async () => {
        calls.push("resources-enter");
        assert(clients instanceof Set);
        assert.equal(actualTelemetry, telemetry);
        const failures = [];
        let result;
        try {
          result = await action();
        } catch (error) {
          failures.push(error);
        } finally {
          calls.push("resources-cleanup-enter");
          cleanupEntered.resolve();
          // This models completion of the injected resource owner's promise;
          // it deliberately makes no claim about actual SDK socket closure.
          await releaseCleanup.promise;
          assert.equal(clients.size, 1);
          assert(
            clients.has(client),
            "opened client was not handed to the resource owner",
          );
          calls.push("resources-cleanup-complete");
          if (resourceError) failures.push(resourceError);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "injected resource owner failures",
          );
        return result;
      })();
      tasks.push(task);
      void task.catch(() => {});
      return task;
    },
    async readModelStatus() {
      calls.push("model");
      return {
        requests: ["foreground-preempt-reply"],
        errors: [],
        pending: [],
        cancelled: [],
      };
    },
  };
  return {
    input,
    controller,
    calls,
    browserCalls,
    cleanupEntered,
    releaseCleanup,
    logoutEntered,
    releaseLogout,
    start() {
      const pending = { settled: false, promise: undefined };
      pending.promise = Promise.resolve()
        .then(() => runOwnerClientSession(input))
        .then(
          (value) => {
            pending.settled = true;
            return { ok: true, value };
          },
          (error) => {
            pending.settled = true;
            return { ok: false, error };
          },
        );
      return pending;
    },
    async join(pending) {
      releaseCleanup.resolve();
      releaseLogout.resolve();
      await pending.promise;
      await Promise.allSettled(tasks);
      controller.abort(new Error("owner client session fixture cleanup"));
    },
  };
}

function recordLogs(t) {
  const logs = [];
  for (const method of ["log", "warn", "error"])
    t.mock.method(console, method, (...args) => {
      logs.push(args);
    });
  return logs;
}

function noPrivateOutput(logs, value) {
  const output = `${inspect(logs, { depth: 8 })}\n${JSON.stringify(value)}`;
  for (const secret of privateValues)
    assert(
      !output.includes(secret),
      "session wrapper exposed private browser authority",
    );
}

function containsError(error, expected) {
  return (
    error === expected ||
    (error instanceof AggregateError &&
      error.errors.some((entry) => containsError(entry, expected)))
  );
}

function actualLogout(f) {
  const requests = f.browserCalls.filter(
    ({ path }) => path !== "/api/session/login",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/session");
  assert.deepEqual(requests[0].options, { method: "DELETE", status: 204 });
  assert(
    f.calls.indexOf("resources-cleanup-complete") < f.calls.indexOf("logout"),
  );
}

test("owner client logs in, runs the original ACP business, joins resources, then DELETEs the actual Gateway session", async (t) => {
  const logs = recordLogs(t);
  const f = fixture({ heldCleanup: true });
  const pending = f.start();
  let timer;
  try {
    await Promise.race([
      f.cleanupEntered.promise,
      pending.promise.then(() => {
        throw new Error("resource owner was not actually entered");
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("resource cleanup did not start")),
          3000,
        );
      }),
    ]);
    clearTimeout(timer);
    assert.deepEqual(f.calls, [
      "resources-enter",
      "login",
      "open",
      "new",
      "prompt",
      "model",
      "resources-cleanup-enter",
    ]);
    assert.equal(pending.settled, false);
    assert.equal(
      f.browserCalls.length,
      1,
      "logout happened before original resource cleanup completed",
    );
    f.releaseCleanup.resolve();
    const outcome = await pending.promise;
    if (!outcome.ok) throw outcome.error;
    assert.deepEqual(outcome.value, {
      status: "passed",
      agent_id: agentId,
      session_id: sessionId,
    });
    actualLogout(f);
    assert.deepEqual(f.calls, [
      "resources-enter",
      "login",
      "open",
      "new",
      "prompt",
      "model",
      "resources-cleanup-enter",
      "resources-cleanup-complete",
      "logout",
    ]);
    noPrivateOutput(logs, outcome.value);
  } finally {
    clearTimeout(timer);
    await f.join(pending);
    t.mock.restoreAll();
  }
});

for (const stage of ["resource cleanup", "logout"]) {
  test(`owner client joins original ${stage} after cancellation and rejects its late success`, async (t) => {
    const logs = recordLogs(t);
    const f = fixture({
      heldCleanup: stage === "resource cleanup",
      heldLogout: stage === "logout",
    });
    const pending = f.start();
    const cancelled = new Error(`owner client cancelled during ${stage}`);
    const entered =
      stage === "resource cleanup" ? f.cleanupEntered : f.logoutEntered;
    let timer;
    try {
      await Promise.race([
        entered.promise,
        pending.promise.then(() => {
          throw new Error(`${stage} was not actually entered`);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${stage} did not start`)),
            3000,
          );
        }),
      ]);
      clearTimeout(timer);
      assert(f.calls.includes("model"));
      assert.equal(pending.settled, false);
      f.controller.abort(cancelled);
      // Allow abort handlers and their microtasks to run while the original
      // cleanup dependency deliberately remains unresolved.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        pending.settled,
        false,
        `cancellation abandoned the original ${stage} promise`,
      );
      if (stage === "resource cleanup") {
        assert.equal(f.calls.includes("resources-cleanup-complete"), false);
        assert.equal(f.calls.includes("logout"), false);
        f.releaseCleanup.resolve();
      } else {
        assert(f.calls.includes("resources-cleanup-complete"));
        assert.equal(f.calls.filter((call) => call === "logout").length, 1);
        f.releaseLogout.resolve();
      }
      const outcome = await pending.promise;
      actualLogout(f);
      assert.equal(
        outcome.ok,
        false,
        `late ${stage} success after cancellation became a passing receipt`,
      );
      if (outcome.ok)
        assert.fail("cancelled owner session unexpectedly passed");
      assert(
        containsError(outcome.error, cancelled),
        "session cleanup lost the original cancellation",
      );
      assert.equal(
        f.calls.filter((call) => call === "resources-cleanup-complete").length,
        1,
      );
      noPrivateOutput(logs, undefined);
    } finally {
      clearTimeout(timer);
      await f.join(pending);
      t.mock.restoreAll();
    }
  });
}

for (const [name, businessFails, resourcesFail, logoutFails] of [
  ["business failure", true, false, false],
  ["resource cleanup failure", false, true, false],
  ["business and resource cleanup failures", true, true, false],
  ["business and logout failures", true, false, true],
  ["logout failure after completed business", false, false, true],
  ["business, resource cleanup and logout failures", true, true, true],
]) {
  test(`owner client preserves ${name} and still attempts exact session deletion`, async (t) => {
    const logs = recordLogs(t);
    const businessError = businessFails
      ? new Error("original Prompt business failed")
      : undefined;
    const resourceError = resourcesFail
      ? new Error("original resource cleanup failed")
      : undefined;
    const logoutError = logoutFails
      ? new Error("actual Gateway DELETE failed")
      : undefined;
    const f = fixture({ businessError, resourceError, logoutError });
    const pending = f.start();
    try {
      const outcome = await pending.promise;
      actualLogout(f);
      assert.equal(
        outcome.ok,
        false,
        "a failed business or cleanup became a passing receipt",
      );
      if (outcome.ok) assert.fail("failed owner session unexpectedly passed");
      for (const original of [businessError, resourceError, logoutError].filter(
        Boolean,
      ))
        assert(
          containsError(outcome.error, original),
          "session cleanup lost an original failure",
        );
      if (logoutFails && (businessFails || resourcesFail))
        assert(
          outcome.error instanceof AggregateError,
          "logout failure replaced the earlier business/resource failure",
        );
      assert.equal(
        f.calls.filter((call) => call === "resources-cleanup-complete").length,
        1,
      );
      assert.equal(f.calls.filter((call) => call === "logout").length, 1);
      noPrivateOutput(logs, undefined);
    } finally {
      await f.join(pending);
      t.mock.restoreAll();
    }
  });
}
