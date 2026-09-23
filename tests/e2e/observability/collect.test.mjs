import assert from "node:assert/strict";
import test from "node:test";
import { collectTrace } from "./collect.mjs";

const trace = {
  traceID: "trace",
  processes: { p: { serviceName: "service" } },
  spans: [{ traceID: "trace", spanID: "root", processID: "p", references: [] }],
};
function stub(response) {
  const events = [];
  return {
    events,
    options: {
      wait: async (ms) => {
        events.push(ms);
      },
      request: async (url) => {
        events.push(url);
        return response;
      },
    },
  };
}
test("touched flows wait six seconds then query once without convergence polling", async () => {
  const { events, options } = stub(Response.json({ data: [trace] }));
  assert.equal(
    await collectTrace(
      "http://jaeger/",
      "trace",
      (t) => t.traceID,
      undefined,
      options,
    ),
    "trace",
  );
  assert.deepEqual(events, [6000, "http://jaeger/api/traces/trace"]);
});
for (const [name, response] of [
  ["404", () => new Response(null, { status: 404 })],
  ["503", () => new Response(null, { status: 503 })],
  [
    "API errors",
    () => Response.json({ data: [trace], errors: [{ message: "failed" }] }),
  ],
  ["missing trace", () => Response.json({ data: [] })],
  [
    "wrong trace",
    () => Response.json({ data: [{ ...trace, traceID: "foreign" }] }),
  ],
  [
    "trace warnings",
    () => Response.json({ data: [{ ...trace, warnings: ["clock skew"] }] }),
  ],
  [
    "span warnings",
    () =>
      Response.json({
        data: [
          {
            ...trace,
            spans: [{ ...trace.spans[0], warnings: ["clock skew"] }],
          },
        ],
      }),
  ],
  [
    "broken parent",
    () =>
      Response.json({
        data: [
          {
            ...trace,
            spans: [
              {
                ...trace.spans[0],
                references: [
                  { refType: "CHILD_OF", traceID: "trace", spanID: "missing" },
                ],
              },
            ],
          },
        ],
      }),
  ],
  ["invalid JSON", () => new Response("private-invalid-json")],
])
  test(`query ${name} is a failure, never a retry`, async () => {
    const { events, options } = stub(response());
    await assert.rejects(
      collectTrace("http://jaeger", "trace", () => true, undefined, options),
    );
    assert.deepEqual(events, [6000, "http://jaeger/api/traces/trace"]);
  });

test("inspection failure is propagated once and asynchronous evidence is awaited", async () => {
  const { events, options } = stub(Response.json({ data: [trace] }));
  await assert.rejects(
    collectTrace(
      "http://jaeger",
      "trace",
      async () => {
        throw Error("missing persisted admission");
      },
      undefined,
      options,
    ),
    /persisted admission/u,
  );
  assert.equal(events.length, 2);
});
test("no query starts before the six-second wait completes", async () => {
  const { events, options } = stub(Response.json({ data: [trace] }));
  const gate = Promise.withResolvers();
  options.wait = () => gate.promise;
  const pending = collectTrace(
    "http://jaeger",
    "trace",
    () => true,
    undefined,
    options,
  );
  try {
    await Promise.resolve();
    assert.deepEqual(events, []);
  } finally {
    gate.resolve();
    await pending;
  }
});

test("malformed Jaeger data must not expose a credential through a parse error", async () => {
  const secret = "synthetic-malformed-session";
  const { options } = stub(new Response(`{"token":"${secret}"`));
  await assert.rejects(
    collectTrace("http://jaeger", "trace", () => true, undefined, options),
    (error) => {
      assert.equal(error.message, "Jaeger returned invalid JSON");
      assert(!error.message.includes(secret));
      assert(!String(error.stack).includes(secret));
      return true;
    },
  );
});

test("invalid JSON has a bounded generic diagnostic without the response body", async () => {
  const body = "not-json-sensitive-body";
  const { options } = stub(new Response(body));
  await assert.rejects(
    collectTrace("http://jaeger", "trace", () => true, undefined, options),
    (error) => {
      assert.equal(error.message, "Jaeger returned invalid JSON");
      assert(!error.message.includes(body));
      assert(!String(error.stack).includes(body));
      return true;
    },
  );
});
