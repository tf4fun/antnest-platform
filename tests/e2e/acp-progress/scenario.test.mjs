import assert from "node:assert/strict";
import test from "node:test";
import { createProgressScenario } from "./scenario.mjs";
import { progressScenarioFixture } from "./scenario.fixture.mjs";

function run(version, source, ending, options = {}) {
  const f = progressScenarioFixture(version, source, ending, options);
  f.execute = () =>
    createProgressScenario(f.dependencies)(
      version,
      source,
      ending,
      "agent",
      f.gate,
    );
  return f;
}
function contains(error, target) {
  return (
    error === target ||
    (error instanceof AggregateError &&
      error.errors.some((item) => contains(item, target)))
  );
}
function hasMessage(error, pattern) {
  return (
    pattern.test(error.message) ||
    (error instanceof AggregateError &&
      error.errors.some((item) => hasMessage(item, pattern)))
  );
}

test("all twelve scenarios retain 28 initializations, 44 business RPCs and four original cancel receipts", async () => {
  let connections = 0,
    requests = 0,
    notifications = 0;
  for (const version of [1, 2])
    for (const source of ["bash", "managed"])
      for (const ending of ["success", "failure", "cancel"]) {
        const f = run(version, source, ending);
        const result = await f.execute();
        assert.equal(result.phase, f.phase);
        assert.equal(result.sessionId, "progress-session");
        assert.equal(result.toolCallId, "tool");
        assert.equal(f.outcomes.length, 1);
        assert(f.clients.every((client) => client.closed));
        assert.deepEqual(
          f.receipts.map((row) => row.role),
          ending === "success"
            ? ["prompt", "live-replay", "terminal-replay"]
            : ["prompt", "terminal-replay"],
        );
        assert.deepEqual(
          f.receipts.map((row) => row.client),
          f.clients,
        );
        for (const row of f.receipts) {
          assert.equal(row.phase, f.phase);
          assert.equal(row.sessionId, result.sessionId);
          assert.equal(row.agentId, "agent");
          connections++;
          requests += row.client.requestEvidence.length;
          notifications += row.client.notifications.length;
        }
        if (ending === "success")
          assert(
            f.events.indexOf("disconnect-for-replay") <
              f.events.indexOf("replay") &&
              f.events.indexOf("replay") < f.events.indexOf("release"),
          );
        if (ending === "cancel") {
          assert(f.events.indexOf("alive") < f.events.indexOf("cancel"));
          assert(f.events.indexOf("cancel") < f.events.indexOf("stopped"));
          assert.equal(
            f.events.find((row) => row.label?.endsWith("process cancellation"))
              .timeout,
            10000,
          );
          assert.strictEqual(
            f.receipts[0].client.notifications[0],
            f.clients[0].notifications[0],
          );
          assert.equal(f.outcomes[0].actual_execution_stopped, true);
        }
      }
  assert.deepEqual(
    { connections, requests, notifications },
    { connections: 28, requests: 44, notifications: 4 },
  );
});

for (const version of [1, 2]) {
  test(`v${version}: another Session's preview cannot satisfy the scenario`, async () => {
    const f = run(version, "bash", "success", { foreignSession: true });
    await assert.rejects(f.execute(), (error) =>
      hasMessage(error, /foreign Progress Session/),
    );
    assert(f.clients.every((client) => client.closed));
    assert.equal(f.outcomes.length, 0);
  });
  test(`v${version}: late foreign frames arriving during close cannot escape validation`, async () => {
    const f = run(version, "bash", "success", { lateForeign: true });
    await assert.rejects(f.execute(), /Session|session/);
    assert.equal(f.outcomes.length, 0);
    assert.equal(
      f.receipts.length,
      1,
      "retain the closed connection even on invalid frames",
    );
    assert.strictEqual(f.receipts[0].client, f.clients[0]);
  });
  test(`v${version}: SDK failure is not accepted as intentional replay disconnect`, async () => {
    const original = new TypeError("original SDK write failure");
    const f = run(version, "managed", "success", { promptFailure: original });
    await assert.rejects(f.execute(), (error) => contains(error, original));
    assert(f.clients.every((client) => client.closed));
    assert.equal(f.outcomes.length, 0);
  });
  test(`v${version}: retryable failure cannot satisfy the Runtime barrier`, async () => {
    const f = run(version, "managed", "cancel", { retryable: true });
    await assert.rejects(f.execute());
    assert(f.clients.every((client) => client.closed));
    assert.equal(f.outcomes.length, 0);
  });
}

test("the scenario rejects retired Gateway connections and still joins cleanup", async () => {
  const f = run(1, "bash", "failure", { boundary: "gateway" });
  await assert.rejects(f.execute(), /private-acp/);
  assert(f.clients.every((client) => client.closed));
  assert.equal(f.outcomes.length, 0);
});
test("missed actual stop deadline stays failed after diagnostics", async () => {
  const diagnostic = new Error("diagnostic failure");
  const f = run(2, "managed", "cancel", {
    neverStopped: true,
    diagnosticFailure: diagnostic,
  });
  await assert.rejects(
    f.execute(),
    (error) =>
      contains(error, diagnostic) &&
      JSON.stringify(error.errors?.map((item) => item.message)).includes(
        "process cancellation",
      ),
  );
  assert.equal(f.outcomes.length, 0);
  assert(f.events.includes("diagnose"));
  assert(f.clients.every((client) => client.closed));
});
test("a business failure and a close failure are both retained", async () => {
  const business = new Error("gate failure"),
    cleanup = new Error("transport cleanup failure");
  const f = run(1, "bash", "failure", {
    gateFailure: business,
    closeFailure: { at: 0, error: cleanup },
  });
  await assert.rejects(
    f.execute(),
    (error) => contains(error, business) && contains(error, cleanup),
  );
  assert.equal(f.outcomes.length, 0);
  assert(f.clients.every((client) => client.closed));
});
test("a failed next connection retains all preceding closed inventories", async () => {
  const original = new Error("next connection failed");
  const f = run(1, "bash", "success", {
    connectFailure: { at: 1, error: original },
  });
  await assert.rejects(f.execute(), (error) => contains(error, original));
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].role, "prompt");
  assert(f.clients.every((client) => client.closed));
  assert.equal(f.outcomes.length, 0);
});
test("final inventory failure prevents a success outcome", async () => {
  const original = new Error("inventory persistence failed");
  const f = run(2, "bash", "failure", { receiptFailure: original });
  await assert.rejects(f.execute(), (error) => contains(error, original));
  assert.equal(f.outcomes.length, 0);
  assert(f.clients.every((client) => client.closed));
});
for (const option of ["corruptReplay", "duplicateTerminal"])
  test(`${option} cannot pass a completed business scenario`, async () => {
    const f = run(2, "managed", "success", { [option]: true });
    await assert.rejects(f.execute());
    assert.equal(f.outcomes.length, 0);
    assert(f.clients.every((client) => client.closed));
  });

for (const option of ["notifyElapsed", "probeElapsed"])
  test(`the cancellation deadline includes ${option}`, async () => {
    const f = run(2, "managed", "cancel", { [option]: 10001 });
    await assert.rejects(f.execute(), (error) =>
      hasMessage(error, /cancellation|deadline/),
    );
    assert.equal(f.outcomes.length, 0);
    assert(f.clients.every((client) => client.closed));
  });
test("notification time is subtracted from the remaining stop deadline", async () => {
  const f = run(2, "managed", "cancel", {
    notifyElapsed: 4000,
    probeElapsed: 5000,
  });
  await f.execute();
  assert.equal(
    f.events.find((row) => row.label?.endsWith("process cancellation")).timeout,
    6000,
  );
});
test("every host stop probe receives the remaining original cancellation budget", async () => {
  const f = run(2, "managed", "cancel", { notifyElapsed: 4000 });
  const original = f.gate.stopped,
    observed = [];
  let elapsed = 4000;
  // The scenario's clock starts immediately before notify, at zero.
  let first = true;
  f.dependencies.now = () => {
    if (first) {
      first = false;
      return 0;
    }
    return elapsed;
  };
  const until = f.dependencies.until;
  f.dependencies.until = async (check, label, timeout) => {
    if (label.endsWith("process cancellation"))
      assert((await check()) || (await check()));
    else await until(check, label, timeout);
  };
  f.gate.stopped = async (...args) => {
    observed.push(args[2]);
    if (observed.length === 1) {
      elapsed += 2000;
      return false;
    }
    return original(...args);
  };
  await f.execute();
  assert.deepEqual(observed, [{ timeoutMS: 6000 }, { timeoutMS: 4000 }]);
});

test("timeout diagnosis follows joined close, captures final frames and keeps the business failure", async () => {
  const f = run(1, "bash", "cancel", { neverStopped: true, latePreview: true });
  let observed;
  f.dependencies.diagnose = async (context) => {
    observed = context;
    assert(context.client.closed);
    assert.equal(f.receipts.length, 1);
  };
  await assert.rejects(f.execute(), (error) =>
    hasMessage(error, /process cancellation/),
  );
  assert(observed.client.closed);
  assert.equal(observed.version, 1);
  assert.equal(observed.agentId, "agent");
  assert.equal(observed.sessionId, "progress-session");
  assert.equal(observed.cancelStarted, 0);
  assert.equal(
    observed.frames.at(-1).update.content[0].content.text,
    "last preview before EOF",
  );
  assert.deepEqual(f.outcomes, []);
});

test("timeout, close and diagnostic failures all survive without a success outcome", async () => {
  const close = new Error("failed joined close"),
    diagnostic = new Error("failed diagnostic save");
  const f = run(2, "managed", "cancel", {
    neverStopped: true,
    closeFailure: { at: 0, error: close },
  });
  f.dependencies.diagnose = async ({ client }) => {
    assert(client.closed);
    throw diagnostic;
  };
  await assert.rejects(
    f.execute(),
    (error) =>
      hasMessage(error, /process cancellation/) &&
      contains(error, close) &&
      contains(error, diagnostic),
  );
  assert.deepEqual(f.outcomes, []);
});
test("replay uses the complete observed preview through joined close", async () => {
  const f = run(1, "bash", "success", { latePreview: true });
  await f.execute();
  assert.equal(f.outcomes.length, 1);
});
for (const version of [1, 2])
  test(`v${version}: actual assistant chunks form the verified response`, async () => {
    const f = run(version, "bash", "success", { splitResponse: true });
    await f.execute();
    assert.equal(f.outcomes.length, 1);
  });
test("v2 complete assistant messages are valid after reconnect", async () => {
  const f = run(2, "managed", "success", { wholeMessage: true });
  await f.execute();
  assert.equal(f.outcomes.length, 1);
});
test("deliberate disconnect precondition failure still joins the actual connection", async () => {
  const original = new Error("connection closed before replay disconnect");
  const f = run(2, "bash", "success", { disconnectFailure: original });
  await assert.rejects(f.execute(), (error) => contains(error, original));
  assert(f.clients.every((client) => client.closed));
  assert.equal(f.receipts.length, 1);
  assert.equal(f.outcomes.length, 0);
});
