import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCost, assertAttempts } from "./evidence.mjs";
import { decide, encodeCompletion, createModelFixture } from "./model.mjs";

test("wire oracle distinguishes unknown, zero and cumulative known cost", () => {
  const usage = (cost) => [
    {
      sessionId: "s",
      update: {
        sessionUpdate: "usage_update",
        used: 1100,
        size: 64000,
        ...(cost === undefined ? {} : { cost }),
      },
    },
  ];
  assertCost(usage(), "s", undefined);
  assertCost(usage({ amount: 0, currency: "USD" }), "s", 0);
  assertCost(usage({ amount: 0.0238, currency: "USD" }), "s", 0.0238);
  for (const input of [
    usage(),
    usage({ amount: 0, currency: "USD" }),
    usage({ amount: 0.0238, currency: "EUR" }),
    usage({ amount: 0.0238, currency: "USD", source: "estimated" }),
    [
      ...usage({ amount: 0.0238, currency: "USD" }),
      ...usage({ amount: 0.0238, currency: "USD" }),
    ],
  ]) {
    assert.throws(() => assertCost(input, "s", 0.0238));
  }
  assert.throws(() =>
    assertCost(usage({ amount: 0, currency: "USD" }), "s", undefined),
  );
  assert.throws(() =>
    assertCost(usage({ amount: 0.0238, currency: "USD" }), "other", 0.0238),
  );
  const privateUpdate = usage({ amount: 0.0238, currency: "USD" });
  assert.throws(() =>
    assertCost(
      [...privateUpdate, { ...privateUpdate[0], sessionId: "foreign" }],
      "s",
      0.0238,
    ),
  );
  privateUpdate[0].update.measurement = { source: "estimated" };
  assert.throws(() => assertCost(privateUpdate, "s", 0.0238));
});

test("model fixture constrains selected model and emits exact reported or cache measurements", () => {
  const payload = (phase, model = "priced-model") => ({
    stream: true,
    model,
    messages: [{ role: "user", content: `v1-ws:${phase}` }],
  });
  assert.equal(decide(payload("reported")).usage.cost, 0.01);
  assert.equal(decide(payload("zero")).usage.cost, 0);
  assert.equal(decide(payload("estimated")).usage.cost, undefined);
  assert.equal(decide(payload("cache")).usage.prompt_cache_hit_tokens, 200);
  assert.equal(decide(payload("cache")).usage.cache_creation_input_tokens, 100);
  assert.equal(decide(payload("free")).usage.cost, undefined);
  assert.deepEqual(
    decide(payload("cache-fallback")).usage,
    decide(payload("cache")).usage,
  );
  for (const bad of [
    payload("estimated", "unknown-model"),
    payload("unpriced"),
    payload("invented"),
  ])
    assert.throws(() => decide(bad));
  const wire = encodeCompletion(decide(payload("reported")));
  assert.match(wire, /"cost":0.01/);
  assert.match(wire, /data: \[DONE\]/);
});

test("attempt oracle rejects duplicate, missing and detached Provider requests", () => {
  const expected = [{ phase: "v1-ws:estimated", trace_id: "t" }];
  const actual = [
    { ...expected[0], model_span_id: "m", model: "priced-model" },
  ];
  assertAttempts(actual, expected);
  assert.throws(() => assertAttempts([], expected));
  assert.throws(() => assertAttempts([...actual, ...actual], expected));
  assert.throws(() =>
    assertAttempts([{ ...actual[0], trace_id: "wrong" }], expected),
  );
  assert.throws(() =>
    assertAttempts([{ ...actual[0], model_span_id: "" }], expected),
  );
});

test("restart checkpoint is explicit and model errors never echo request bodies", async () => {
  const server = createModelFixture();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = async () => (await fetch(`${base}/status`)).json();
    assert.equal((await status()).checkpoint, "running");
    await fetch(`${base}/restart`, { method: "POST" });
    assert.equal((await status()).checkpoint, "restart");
    await fetch(`${base}/restarted`, { method: "POST" });
    assert.equal((await status()).checkpoint, "restarted");
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      body: "private-canary",
    });
    assert.equal(response.status, 400);
    assert(!JSON.stringify(await status()).includes("private-canary"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("admission fixture holds a real completion until explicit release", async () => {
  const server = createModelFixture();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let response;
  try {
    let finished = false;
    response = fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: "Bearer cost-model-test",
        traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      },
      body: JSON.stringify({
        stream: true,
        model: "priced-model",
        messages: [{ role: "user", content: "v1-ws:admission" }],
      }),
    }).then((result) => {
      finished = true;
      return result;
    });
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await (await fetch(`${base}/status`)).json();
      if (state.blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(state.blocked, "v1-ws:admission");
    assert.equal(finished, false);
    assert.equal(
      (await fetch(`${base}/release`, { method: "POST" })).status,
      200,
    );
    assert.match(await (await response).text(), /v1-ws:admission verified/);
    assert.equal(
      (await (await fetch(`${base}/status`)).json()).blocked,
      undefined,
    );
    assert.equal(
      (await fetch(`${base}/release`, { method: "POST" })).status,
      409,
    );
  } finally {
    server.closeAllConnections();
    await response?.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
