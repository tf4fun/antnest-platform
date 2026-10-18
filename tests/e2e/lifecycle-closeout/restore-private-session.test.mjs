import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./restore-private-session.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
test("Restore keeps original member and creation organization authority", () => {
  assert.equal(typeof implementation.assertRestoreOwner, "function");
  const principal = { organization_id: "org", user_id: "member" };
  const createdBy = encodeURIComponent(JSON.stringify(["org", "admin"]));
  const initial = { agent_id: "agent", owner_user_id: "member" };
  implementation.assertRestoreOwner(principal, createdBy, initial, "agent");
  for (const changed of [
    { ...principal, user_id: "admin" },
    { ...principal, organization_id: "foreign" },
  ])
    assert.throws(() =>
      implementation.assertRestoreOwner(changed, createdBy, initial, "agent"),
    );
  assert.throws(() =>
    implementation.assertRestoreOwner(
      principal,
      createdBy,
      initial,
      "other-agent",
    ),
  );
});
test("Restore joins all connections despite independent close and archive failures", async () => {
  assert.equal(typeof implementation.closeRestoreConnections, "function");
  const original = new Error("business"),
    close = new Error("close"),
    archive = new Error("archive"),
    errors = [original],
    joined = [];
  await implementation.closeRestoreConnections(
    [close, null, archive].map((error, i) => ({
      async closeAndWait() {
        joined.push(i);
        if (error) throw error;
      },
    })),
    errors,
  );
  assert.deepEqual(joined, [0, 1, 2]);
  assert.deepEqual(errors, [original, close, archive]);
});
test("Restore collects siblings after failed collection and archive while retaining original errors", async () => {
  assert.equal(typeof implementation.collectRestoreTraces, "function");
  const original = new Error("collector"),
    archive = new Error("archive"),
    errors = [],
    seen = [];
  const rows = [
    { requestId: "a", traceID: "ta" },
    { requestId: "b", traceID: "tb" },
  ];
  const result = await implementation.collectRestoreTraces(
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
      ["ta", "failed"],
      ["tb", "passed"],
    ],
  );
});
test("Restore joins the active collector and retains cancellation before ending collection", async () => {
  assert.equal(typeof implementation.collectRestoreTraces, "function");
  const abort = new AbortController(),
    reason = new Error("cancelled"),
    errors = [],
    seen = [];
  let joined = false;
  await implementation.collectRestoreTraces(
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
test("Restore preserves all original business, archive and directory-cleanup failures privately", () => {
  assert.equal(typeof implementation.recordRestoreFailures, "function");
  const a = new Error("business"),
    b = new Error("directory cleanup"),
    result = {};
  implementation.recordRestoreFailures(result, [a, b, a]);
  assert(!Object.keys(result).includes("restoreErrors"));
  assert.deepEqual(result.restoreErrors, [a, b, a]);
  assert.equal(result.private_collection_errors.length, 2);
  assert.throws(
    () => implementation.restoreFailures(result.restoreErrors),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === a &&
      error.errors[1] === b,
  );
  assert.throws(
    () => implementation.restoreFailures([a]),
    (error) => error === a,
  );
});
