import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelFixture } from "./stage2-model-server.mjs";

const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
const user = { role: "user", content: "write evidence" };
const tool = { role: "tool", content: "done" };
const tools = [{ type: "function", function: { name: "write" } }];

async function fixture(t) {
  const server = createModelFixture({ credential: "first", controls: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, body, credential = "first") => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
        traceparent,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
}
test("each new prompt executes a Tool even when history contains earlier Tool results", async (t) => {
  const request = await fixture(t);
  const next = await request("/v1/chat/completions", {
    messages: [user, tool, user],
    tools,
  });
  assert.equal(next.status, 200);
  assert.equal(next.body.choices[0].finish_reason, "tool_calls");
  const completed = await request("/v1/chat/completions", {
    messages: [user, tool],
    tools,
  });
  assert.equal(completed.body.choices[0].finish_reason, "stop");
});
test("held request retains its admitted credential generation; next request requires replacement", async (t) => {
  const request = await fixture(t);
  await request("/fixture/control", { hold_next: true });
  const pending = request("/v1/chat/completions", { messages: [user], tools });
  let observation;
  for (let i = 0; i < 100; i += 1) {
    observation = (await request("/fixture/state")).body;
    if (observation.held === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(observation.held, 1);
  await request("/fixture/control", {
    credential: "replacement",
    release: true,
  });
  assert.equal((await pending).status, 200);
  assert.equal(
    (await request("/v1/chat/completions", { messages: [user, tool], tools }))
      .status,
    401,
  );
  assert.equal(
    (
      await request(
        "/v1/chat/completions",
        { messages: [user, tool], tools },
        "replacement",
      )
    ).status,
    200,
  );
  const state = (await request("/fixture/state")).body;
  assert.deepEqual(
    state.requests.map((item) => item.credential_generation),
    [1, 2],
  );
  assert.deepEqual(
    state.attempts.map((item) => item.status),
    [200, 401, 200],
  );
  assert.deepEqual(
    state.attempts.map((item) => item.credential_generation),
    [1, null, 2],
  );
  assert.equal(JSON.stringify(state).includes("replacement"), false);
  assert.equal(JSON.stringify(state).includes("first"), false);
});
test("fixture controls are unavailable unless explicitly enabled", async (t) => {
  const server = createModelFixture({ credential: "first" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/fixture/state`,
  );
  assert.equal(response.status, 404);
});
