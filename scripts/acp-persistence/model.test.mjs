import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, modelServer } from "./model.mjs";
const payload = (phase, result) => ({
  model: "persistence-model",
  max_tokens: 2048,
  tools: [{ function: { name: "bash" } }],
  messages: [
    { role: "user", content: phase },
    ...(result ? [{ role: "tool", content: JSON.stringify(result) }] : []),
  ],
});
test("Model requires exact physical effects and a final-result barrier for completion loss", () => {
  for (const v of [1, 2])
    for (const phase of ["intent", "accept", "finish"]) {
      const name = `v${v}-${phase}`,
        p = payload(`${name}-post`);
      assert.equal(decide(p).call.name, "bash");
      assert.equal(
        decide(p).call.arguments.command.includes(">>"),
        phase !== "finish",
      );
      if (phase !== "finish")
        assert.throws(() => decide(payload(`${name}-fault`)));
      const result = {
        exit_code: 0,
        stderr: "",
        truncated: false,
        effect_state: "settled",
        stdout: name + "\n",
      };
      assert.equal(
        decide(payload(`${name}-post`, result)).text,
        `${name}-post verified`,
      );
      assert.throws(() =>
        decide(
          payload(`${name}-post`, {
            ...result,
            stdout: name + "\n" + name + "\n",
          }),
        ),
      );
    }
  assert.equal(
    decide(
      payload("v1-finish-fault", {
        exit_code: 0,
        stderr: "",
        truncated: false,
        effect_state: "settled",
        stdout: "v1-finish\n",
      }),
    ).hold,
    true,
  );
});
test("HTTP final-result barrier requires matching phase and rejects duplicate Provider work", async (t) => {
  const server = modelServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = payload("v1-finish-fault", {
    exit_code: 0,
    stderr: "",
    truncated: false,
    effect_state: "settled",
    stdout: "v1-finish\n",
  });
  let completed = false;
  const pending = fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer persistence-fixture-key",
      traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
    },
    body: JSON.stringify(data),
  }).then((r) => {
    completed = true;
    return r.json();
  });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(base + "/status")).json();
    if (state.held) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(state.held, "v1-finish-fault");
  assert.equal(completed, false);
  assert.equal(
    (
      await fetch(base + "/release", {
        method: "POST",
        body: JSON.stringify({ phase: "wrong" }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(base + "/release", {
        method: "POST",
        body: JSON.stringify({ phase: state.held }),
      })
    ).status,
    200,
  );
  assert.equal(
    (await pending).choices[0].message.content,
    "v1-finish-fault verified",
  );
});
