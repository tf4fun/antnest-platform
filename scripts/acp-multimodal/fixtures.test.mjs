import assert from "node:assert/strict";
import { test } from "node:test";
import { nativePrompt, providerContent } from "./fixtures.mjs";
import { decide, createModelFixture } from "./model.mjs";

function payload() {
  return {
    stream: true,
    model: "native-model",
    messages: [{ role: "user", content: providerContent("v1-ws") }],
  };
}

test("model oracle verifies all native bytes and original part order", () => {
  assert.equal(nativePrompt("v1-ws").length, 7);
  assert.equal(decide(payload()).text, "v1-ws native input verified");
  for (const mutate of [
    (p) => {
      p.messages[0].content[1].image_url.url += "wrong";
    },
    (p) => {
      p.messages[0].content[2].input_audio.data = "wrong";
    },
    (p) => {
      p.messages[0].content[4].file.file_data = "wrong";
    },
    (p) => {
      p.messages[0].content.reverse();
    },
    (p) => {
      p.messages[0].content.pop();
    },
    (p) => {
      p.model = "text-model";
    },
  ]) {
    const p = payload();
    mutate(p);
    assert.throws(() => decide(p));
  }
});

test("continuation cannot drop native history or reexecute a Tool", () => {
  const p = payload();
  p.messages.push({
    role: "assistant",
    content: "v1-ws native input verified",
  });
  p.messages.push({ role: "user", content: "v1-ws continue" });
  assert.equal(decide(p).phase, "v1-ws continue");
  const missing = structuredClone(p);
  missing.messages.shift();
  assert.throws(() => decide(missing));
  p.messages.push({ role: "tool", content: "unexpected" });
  assert.throws(() => decide(p));
});

test("reference sentinel records even a failed or ignored fetch attempt", async () => {
  const server = createModelFixture();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = async () => (await fetch(`${base}/status`)).json();
    assert.equal((await status()).referenceRequests, 0);
    await fetch(`${base}/reference`);
    assert.equal((await status()).referenceRequests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
