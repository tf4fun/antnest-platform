import assert from "node:assert/strict";
import test from "node:test";
import { commandFixture, setup } from "../acp-commands/connection.fixture.mjs";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
const url = new URL("./connection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const profiles = [
  { name: "v1-ws", version: 1 },
  { name: "v2-ws", version: 2 },
  { name: "v1-http", version: 1, http: true },
];
async function open(f, profile, preserve) {
  assert.equal(typeof implementation.openStage3Connection, "function");
  return f.register(
    await implementation.openStage3Connection(profile, "agent", f.browser, {
      ...f.options,
      preserve,
    }),
  );
}
for (const profile of profiles) {
  test(
    profile.name +
      " retains one actual initialize, complete wire receipts and joined close",
    async (t) => {
      const f = await commandFixture(t, profile),
        saved = [];
      const c = await open(f, profile, (value) =>
        saved.push(structuredClone(value)),
      );
      const params = structuredClone(setup);
      const result = await c.request("new", params);
      params.cwd = "changed-after-request";
      const row = c.lastRequest;
      await c.request("list", {});
      await c.closeAndWait();
      assert.deepEqual(
        f.calls.map((x) => x.method),
        ["initialize", "session/new", "session/list"],
      );
      assert.equal(c.initializationRequest.method, "initialize");
      assert.equal(
        c.initializationRequest.initializationResult.protocolVersion,
        profile.version,
      );
      assert.equal(c.records.length, 2);
      assert.strictEqual(c.records[0], row);
      assert.deepEqual(row.requestReceipt, {
        requestId: row.requestId,
        params: setup,
        result,
      });
      const final = saved.at(-1);
      assert.equal(final.closed, true);
      assert.equal(
        final.raw_frames.filter((x) => Object.hasOwn(x, "result")).length,
        3,
      );
      assert.deepEqual(
        final.evidence.map((x) => x.method),
        ["session/new", "session/list"],
      );
      if (profile.http) {
        assert.equal(row.httpConnection.streamJoined, true);
        assert.equal(row.httpConnection.pendingRequests, 0);
        assert.equal(
          row.httpConnection.requests.filter((x) => x.method === "DELETE")
            .length,
          1,
        );
        assert.deepEqual(final.http_connection, row.httpConnection);
      } else assert.equal(final.requests.length, 3);
      const before = f.calls.length;
      await assert.rejects(
        c.request("prompt", { sessionId: result.sessionId, prompt: [] }),
        /closing|closed/,
      );
      assert.equal(f.calls.length, before);
    },
  );
  test(
    profile.name + " preserves actual RPC failure and archive failure together",
    async (t) => {
      const f = await commandFixture(t, profile, { denyNew: true });
      let failing = false;
      const saved = [];
      const c = await open(f, profile, (value) => {
        saved.push(structuredClone(value));
        if (failing) throw new Error("archive sentinel");
      });
      failing = true;
      const rejection = admissionErrorReceipt("access_denied");
      await assert.rejects(c.request("new", setup), (error) => {
        assert(error instanceof AggregateError);
        const rpcError = error.errors.find((e) => e.code === rejection.code);
        assert(rpcError);
        assert.equal(rpcError.message, rejection.message);
        assert.deepEqual(rpcError.data, rejection.data);
        assert(error.errors.some((e) => e.message === "archive sentinel"));
        return true;
      });
      failing = false;
      await c.closeAndWait();
      assert.equal(saved.at(-1).evidence[0].outcome, "failed");
      assert.deepEqual(saved.at(-1).raw_frames.at(-1).error, rejection);
    },
  );
}
