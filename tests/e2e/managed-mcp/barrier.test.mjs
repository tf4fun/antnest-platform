import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createModelFixture, guidance, skillSummary } from "./model.mjs";

function payload(step) {
  return {
    tools: [{ function: { name: "mcp__alpha__echo" } }],
    messages: [
      {
        role: "system",
        content: `Current Runtime information ${guidance(2)} ${skillSummary} .antnest/skills/fixture/SKILL.md`,
      },
      { role: "user", content: "managed-draining" },
      ...Array.from({ length: step }, (_, index) => ({
        role: "tool",
        content: JSON.stringify({
          value: "managed-draining",
          calls: 3 + index,
          uid: 2000,
          home: "/run/antnest-mcp-home/2000",
          cwd: "/workspace",
          gid: 1000,
          explicit_env: true,
          supervisor_env: false,
          launcher_env: false,
        }),
      })),
    ],
  };
}
async function fixture(t, timeoutMs = 2000) {
  const server = createModelFixture({ timeoutMs }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async () => (await fetch(`${base}/status`)).json();
  return {
    status,
    release: (step) => fetch(`${base}/release/${step}`, { method: "POST" }),
    model: (step) =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(payload(step)),
        headers: {
          authorization: "Bearer managed-model-test",
          traceparent:
            "00-11111111111111111111111111111111-2222222222222222-01",
        },
      }),
    async held(step) {
      for (let i = 0; i < 100; i++) {
        const value = await status();
        if (value.held?.step === step) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail("model barrier not reached");
    },
  };
}

test("each response barrier needs its own matching release; duplicate requests cannot replay", async (t) => {
  const api = await fixture(t);
  assert.equal((await api.release(1)).status, 409);
  assert.equal((await api.model(0)).status, 200);
  for (const step of [1, 2]) {
    let completed = false;
    const pending = api.model(step).then((response) => {
      completed = true;
      return response;
    });
    const state = await api.held(step);
    assert.equal(completed, false);
    assert(state.held.received_at > 0);
    assert.equal((await api.release(step === 1 ? 2 : 1)).status, 409);
    assert.equal((await api.release(step)).status, 200);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).choices[0].finish_reason,
      step === 1 ? "tool_calls" : "stop",
    );
    assert.equal((await api.release(step)).status, 409);
  }
  assert.equal((await api.status()).requests.length, 3);
  assert.deepEqual((await api.status()).errors, []);
  assert.equal((await api.model(2)).status, 400);
  assert.equal((await api.status()).requests.length, 3);
});

test("a missing release expires instead of fabricating model success", async (t) => {
  const api = await fixture(t, 30);
  assert.equal((await api.model(1)).status, 504);
  const state = await api.status();
  assert.equal(state.held, null);
  assert.deepEqual(state.errors, ["barrier_timeout"]);
  assert.equal((await api.release(1)).status, 409);
  assert(!JSON.stringify(state).includes("managed-model-test"));
});
