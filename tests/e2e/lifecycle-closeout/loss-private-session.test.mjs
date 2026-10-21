import assert from "node:assert/strict";
import test from "node:test";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
const url = new URL("./loss-private-session.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
test("Loss requires the semantic refusal and preserves unexpected original failures", async () => {
  assert.equal(typeof implementation.expectLossDenial, "function");
  const rejection = admissionErrorReceipt("agent_unavailable");
  const denied = Object.assign(new Error(rejection.message), rejection);
  await implementation.expectLossDenial(async () => {
    throw denied;
  });
  for (const original of [
    new Error("socket closed"),
    admissionErrorReceipt("agent_busy"),
    null,
    undefined,
  ]) {
    let caught = false;
    try {
      await implementation.expectLossDenial(async () => {
        throw original;
      });
    } catch (error) {
      caught = true;
      assert.equal(error, original);
    }
    assert.equal(caught, true);
  }
  await assert.rejects(
    implementation.expectLossDenial(async () => ({ stopReason: "end_turn" })),
    /semantic agent_unavailable refusal/,
  );
});
test("Loss owner must match the original member and creating organization", () => {
  assert.equal(typeof implementation.assertLossOwner, "function");
  const principal = { organization_id: "org", user_id: "member" };
  const creation = encodeURIComponent(JSON.stringify(["org", "admin"]));
  const agent = {
    id: "a",
    initial: { agent: { agent_id: "a", owner_user_id: "member" } },
  };
  implementation.assertLossOwner(principal, creation, agent);
  for (const changed of [
    { ...principal, user_id: "admin" },
    { ...principal, organization_id: "other" },
  ])
    assert.throws(() =>
      implementation.assertLossOwner(changed, creation, agent),
    );
  agent.initial.agent.agent_id = "other";
  assert.throws(() =>
    implementation.assertLossOwner(principal, creation, agent),
  );
});
test("Loss joins all clients even when the first archive and a later close fail", async () => {
  assert.equal(typeof implementation.closeLossConnections, "function");
  const archive = new Error("archive"),
    close = new Error("close"),
    business = new Error("business");
  const joined = [],
    errors = [business];
  const clients = [archive, null, close].map((error, i) => ({
    async closeAndWait() {
      joined.push(i);
      if (error) throw error;
    },
  }));
  await implementation.closeLossConnections(clients, errors);
  assert.deepEqual(joined, [0, 1, 2]);
  assert.deepEqual(errors, [business, archive, close]);
});
test("Loss collects sibling evidence after original collector and archive failures", async () => {
  assert.equal(typeof implementation.collectLossTraces, "function");
  const original = new Error("collector"),
    archive = new Error("archive"),
    errors = [],
    seen = [];
  const rows = [{ traceID: "a" }, { traceID: "b" }];
  const result = await implementation.collectLossTraces(
    rows,
    async (row) => {
      seen.push(row);
      if (row === rows[0]) throw original;
      return { trace_id: row.traceID };
    },
    async () => {
      throw archive;
    },
    undefined,
    errors,
  );
  assert.deepEqual(seen, rows);
  assert.deepEqual(errors, [original, archive]);
  assert.deepEqual(
    result.map((r) => [r.trace_id, r.topology]),
    [
      ["a", "failed"],
      ["b", "passed"],
    ],
  );
});
test("Loss waits for the active collector before observing cancellation", async () => {
  assert.equal(typeof implementation.collectLossTraces, "function");
  const abort = new AbortController(),
    reason = new Error("cancelled"),
    errors = [],
    seen = [];
  let joined = false;
  await implementation.collectLossTraces(
    [0, 1],
    async (row) => {
      seen.push(row);
      abort.abort(reason);
      await Promise.resolve();
      joined = true;
      return {};
    },
    async () => {},
    abort.signal,
    errors,
  );
  assert.equal(joined, true);
  assert.deepEqual(seen, [0]);
  assert.deepEqual(errors, [reason]);
});
test("Loss records actual failures privately and rethrows their original objects after final collection", () => {
  assert.equal(typeof implementation.recordLossFailures, "function");
  assert.equal(typeof implementation.lossFailures, "function");
  const a = new Error("business"),
    b = new Error("archive"),
    result = {};
  implementation.recordLossFailures(result, [a, b, a]);
  assert.deepEqual(result.lossErrors, [a, b, a]);
  assert(!Object.keys(result).includes("lossErrors"));
  assert.equal(result.private_collection_errors.length, 2);
  assert.throws(
    () => implementation.lossFailures(result.lossErrors),
    (e) =>
      e instanceof AggregateError && e.errors[0] === a && e.errors[1] === b,
  );
  assert.throws(
    () => implementation.lossFailures([a]),
    (e) => e === a,
  );
});
