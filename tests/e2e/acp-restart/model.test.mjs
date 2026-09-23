import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, modelServer } from "./model.mjs";
const payload = (phase, stdout) => ({
  model: "restart-model",
  max_tokens: 2048,
  tools: [{ function: { name: "bash" } }],
  messages: [
    { role: "user", content: phase },
    ...(stdout === undefined
      ? []
      : [
          {
            role: "tool",
            content: JSON.stringify({
              exit_code: 0,
              stderr: "",
              truncated: false,
              effect_state: "settled",
              stdout,
            }),
          },
        ]),
  ],
});
test("interruption model has semantic barriers before execution, after settlement, and inside a real shell", () => {
  for (const v of [1, 2]) {
    const p = `v${v}`;
    assert.equal(decide(payload(p + "-model-held-fault")).hold, true);
    assert.equal(
      decide(payload(p + "-tool-held-fault", p + "-tool-held\n")).hold,
      true,
    );
    assert.equal(
      decide(payload(p + "-completed-fault", p + "-completed\n")).text,
      p + "-completed-fault verified",
    );
    const command = decide(payload(p + "-tool-inflight")).call.arguments
      .command;
    assert(command.includes(`acp-unknown-${p}.pid`));
    assert(command.includes(`acp-unknown-${p}.release`));
    assert(command.includes("while"));
    assert.throws(() => decide(payload(p + "-tool-inflight", "unexpected")));
    for (const kind of ["completed", "model-held", "tool-held", "inflight"]) {
      const result = decide(payload(`${p}-${kind}-post`));
      assert.equal(result.call.name, "bash");
      assert.equal(
        result.call.arguments.command.includes(">>"),
        kind === "model-held",
      );
      const marker =
        kind === "inflight" ? `${p}-tool-inflight` : `${p}-${kind}`;
      assert(decide(payload(`${p}-${kind}-post`, marker + "\n")).text);
      assert.throws(() =>
        decide(payload(`${p}-${kind}-post`, marker + "\n" + marker + "\n")),
      );
    }
  }
});

test("an interrupted held HTTP response releases only its own fixture barrier", async (t) => {
  const server = modelServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const phase of ["v1-model-held-fault", "v2-model-held-fault"]) {
    const abort = new AbortController();
    const pending = fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer restart-fixture-key",
        traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
      },
      body: JSON.stringify(payload(phase)),
      signal: abort.signal,
    }).catch(() => null);
    let held;
    for (let n = 0; n < 100; n++) {
      held = (await (await fetch(base + "/status")).json()).held;
      if (held) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(held, phase);
    abort.abort();
    await pending;
    for (let n = 0; n < 100; n++) {
      held = (await (await fetch(base + "/status")).json()).held;
      if (!held) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(held, null);
  }
  assert.deepEqual((await (await fetch(base + "/status")).json()).errors, []);
});
