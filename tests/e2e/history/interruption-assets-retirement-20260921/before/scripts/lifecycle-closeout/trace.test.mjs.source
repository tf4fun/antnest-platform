import assert from "node:assert/strict";
import test from "node:test";
import { verifyLifecycleTrace } from "./trace.mjs";

for (const encoded of [false, true])
  test(`trace collection rejects a dynamic ${encoded ? "encoded" : "raw"} cookie immediately`, async (t) => {
    const secret = "synthetic-session/unique+cookie=";
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({
        data: [
          { tags: [{ value: encoded ? encodeURIComponent(secret) : secret }] },
        ],
      });
    });
    const deadline = AbortSignal.timeout(500);
    await assert.rejects(
      verifyLifecycleTrace(
        "http://fixture",
        { traceID: "admission", requestID: "request" },
        [secret],
        deadline,
      ),
      (error) => {
        assert.match(error.message, /secret credential appeared in evidence/);
        assert(!error.message.includes(secret));
        assert(!error.message.includes(encodeURIComponent(secret)));
        return true;
      },
    );
    assert(calls <= 2, "must not poll after a detected leak");
  });

test("trace collection requires an explicit nonempty canary set", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw Error("must not fetch");
  });
  await assert.rejects(
    verifyLifecycleTrace("http://fixture", {}, [], AbortSignal.timeout(500)),
    /trace secrets are required/,
  );
  assert.equal(calls, 0);
});

test("malformed Jaeger data must not expose a credential through a parse error", async (t) => {
  const secret = "synthetic-malformed-session";
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(`{"token":"${secret}"`),
  );
  await assert.rejects(
    verifyLifecycleTrace(
      "http://fixture",
      { traceID: "admit" },
      [secret],
      AbortSignal.timeout(500),
    ),
    (error) => {
      assert.match(error.message, /secret credential appeared in evidence/);
      assert(!String(error.stack).includes(secret));
      return true;
    },
  );
});

test("invalid JSON has a bounded generic diagnostic without the response body", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("not-json-sensitive-body"),
  );
  await assert.rejects(
    verifyLifecycleTrace(
      "http://fixture",
      { traceID: "admit" },
      ["synthetic-cookie"],
      AbortSignal.timeout(500),
    ),
    (error) => {
      assert.equal(error.message, "Jaeger returned invalid JSON");
      assert(!String(error.stack).includes("not-json-sensitive-body"));
      return true;
    },
  );
});
