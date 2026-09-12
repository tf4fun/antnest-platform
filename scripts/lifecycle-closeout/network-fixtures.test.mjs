import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createNetworkTarget } from "./network-target.mjs";
import { decideNetwork } from "./network-model.mjs";
import { collectTrace } from "../observability/collect.mjs";

test(
  "real TCP target preserves sockets for echo and independent server push",
  { timeout: 8000 },
  async () => {
    const target = createNetworkTarget();
    let socket;
    try {
      target.tcp.listen(0, "127.0.0.1");
      await once(target.tcp, "listening");
      target.http.listen(0, "127.0.0.1");
      await once(target.http, "listening");
      const base = `http://127.0.0.1:${target.http.address().port}`;
      const control = async (path, method = "GET") =>
        fetch(base + path, { method, signal: AbortSignal.timeout(2000) });
      socket = connect(target.tcp.address().port, "127.0.0.1");
      await once(socket, "connect");
      const reader = createInterface({ input: socket });
      const request = { phase: "held-b", nonce: "abc123" };
      let next = once(reader, "line");
      socket.write(JSON.stringify(request) + "\n");
      assert.deepEqual(JSON.parse((await next)[0]), request);
      next = once(reader, "line");
      assert.equal((await control("/push/abc123", "POST")).status, 200);
      assert.deepEqual(JSON.parse((await next)[0]), { push: "abc123" });
      assert.equal((await control("/push/abc123", "POST")).status, 409);
      next = once(reader, "line");
      socket.write(JSON.stringify({ ...request, phase: "held-b-next" }) + "\n");
      assert.equal(JSON.parse((await next)[0]).phase, "held-b-next");
      const state = await (await control("/status")).json();
      assert.deepEqual(state.errors, []);
      assert.deepEqual(
        state.requests.map((r) => r.phase),
        ["held-b", "held-b-next"],
      );
      const closed = once(socket, "close");
      socket.write(JSON.stringify({ phase: "denied", nonce: "def456" }) + "\n");
      await closed;
      assert.deepEqual((await (await control("/status")).json()).errors, [
        "unexpected TCP probe",
      ]);
    } finally {
      socket?.destroy();
      await target.close();
    }
  },
);

test("model dispatches one real bash and requires successful tool result decoding", () => {
  const payload = {
    model: "stage3-model",
    messages: [
      {
        role: "user",
        content: JSON.stringify({ phase: "allowed", nonce: "abc123" }),
      },
    ],
    tools: [{ function: { name: "bash" } }],
  };
  assert.equal(decideNetwork(payload).call.name, "bash");
  const tool = {
    role: "tool",
    content: JSON.stringify({
      exit_code: 0,
      stderr: "",
      stdout: '{"uid":1000}',
    }),
  };
  assert.deepEqual(
    decideNetwork({ ...payload, messages: [...payload.messages, tool] }).report,
    { uid: 1000 },
  );
  for (const content of [
    "{}",
    '{"exit_code":1}',
    '{"exit_code":0,"stderr":"error"}',
    '{"exit_code":0,"stderr":"","stdout":"broken"}',
  ])
    assert.throws(() =>
      decideNetwork({
        ...payload,
        messages: [...payload.messages, { ...tool, content }],
      }),
    );
  assert.throws(() =>
    decideNetwork({ ...payload, messages: [...payload.messages, tool, tool] }),
  );
});

test("trace collection honors caller cancellation before network access", async () => {
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(
    collectTrace(
      "http://127.0.0.1:1",
      "trace",
      () => assert.fail(),
      abort.signal,
    ),
    /cancelled/,
  );
});
