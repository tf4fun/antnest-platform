import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const url = new URL("./private-state.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const principal = { organization_id: "organization", user_id: "owner" };
const state = { agent_id: "agent", availability: "ready" };
function fixture(t, options = {}) {
  assert.equal(typeof implementation.withDevelopmentPrivateState, "function");
  const output = mkdtempSync(join(tmpdir(), "antnest-development-state-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const calls = [],
    browser = { accessToken: "original-cookie-token" };
  const original = structuredClone(principal),
    secrets = [];
  let callbacks;
  const config = { output, privateAccess: { acp: "http://127.0.0.1:19001" } };
  const createAccess = async (actual, values) => {
    calls.push("create");
    assert.equal(actual.privateAccess, config.privateAccess);
    assert.equal(values.secrets, secrets);
    callbacks = values;
    return {
      async state(id, auth, identity) {
        calls.push("state");
        assert.equal(id, "agent");
        assert.deepEqual(auth, { accessToken: "original-cookie-token" });
        assert.deepEqual(identity, principal);
        await values.preserveAuthority(
          { operation_id: 1, kind: "state", index: 1 },
          [{ original: true }],
        );
        await values.preserveState(1, { status: 200, state });
        if (options.readError) throw options.readError;
        return state;
      },
      async closeAndWait() {
        await new Promise((resolve) => setImmediate(resolve));
        calls.push("close");
        if (options.closeError) throw options.closeError;
      },
    };
  };
  return {
    config,
    calls,
    browser,
    original,
    output,
    callbacks: () => callbacks,
    run: (work) =>
      implementation.withDevelopmentPrivateState(
        config,
        { browser, principal: original, secrets },
        work,
        { createAccess },
      ),
    report: () =>
      JSON.parse(readFileSync(join(output, "private-access.private.json"))),
  };
}

test("Development state binds the original login, owns its receipts, and joins before returning", async (t) => {
  const f = fixture(t);
  const result = await f.run(async (access) => {
    assert.deepEqual(Object.keys(access), ["state"]);
    f.browser.accessToken = "later-cookie";
    f.original.user_id = "later-owner";
    return access.state("agent");
  });
  assert.strictEqual(result, state);
  assert.deepEqual(f.calls, ["create", "state", "close"]);
  const report = f.report();
  assert.equal(report.closed, true);
  assert.equal(report.states.length, 1);
  assert.deepEqual(report.authorities[0].receipts, [{ original: true }]);
  assert.deepEqual(report.errors, []);
  assert.equal(
    statSync(join(f.output, "private-access.private.json")).mode & 0o777,
    0o600,
  );
});

test("Development state retains the original business error after joining access", async (t) => {
  const original = new Error("original read failure");
  const f = fixture(t, { readError: original });
  await assert.rejects(
    f.run((access) => access.state("agent")),
    (error) => error === original,
  );
  assert.deepEqual(f.calls, ["create", "state", "close"]);
  assert.equal(f.report().closed, true);
  assert.match(f.report().errors[0], /original read failure/);
});

test("Development state retains independent business and close failures", async (t) => {
  const original = new Error("original read failure"),
    cleanup = new Error("close failure");
  const f = fixture(t, { readError: original, closeError: cleanup });
  await assert.rejects(
    f.run((access) => access.state("agent")),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    },
  );
  assert.equal(f.report().closed, false);
});

test("Development state does not overwrite an existing evidence file or start private effects", async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.output, "private-access.private.json"),
    "original evidence",
  );
  await assert.rejects(
    f.run(() => assert.fail("work must not start")),
    /exist/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(
    readFileSync(join(f.output, "private-access.private.json"), "utf8"),
    "original evidence",
  );
});

test("Development state joins access when private evidence is replaced and retains the business failure", async (t) => {
  const original = new Error("original business failure"),
    f = fixture(t);
  await assert.rejects(
    f.run(async (access) => {
      await access.state("agent");
      const path = join(f.output, "private-access.private.json");
      rmSync(path);
      mkdirSync(path);
      throw original;
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors[0], original);
      assert.match(error.errors[1].message, /replaced/);
      return true;
    },
  );
  assert.equal(f.calls.at(-1), "close");
});

for (const key of ["organization_id", "user_id", "accessToken"])
  test(`Development rejects missing original ${key} before private effects`, async (t) => {
    const f = fixture(t);
    if (key === "accessToken") delete f.browser[key];
    else delete f.original[key];
    await assert.rejects(
      f.run(() => assert.fail("work must not start")),
      /original/,
    );
    assert.deepEqual(f.calls, []);
  });
