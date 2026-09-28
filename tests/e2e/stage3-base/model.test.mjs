import assert from "node:assert/strict";
import test from "node:test";
import { decide, modelServer, registryDenialCommand } from "./model-server.mjs";

const payload = (phase, results = []) => ({
  model: "stage3-model",
  max_tokens: phase === "v1-baseline" ? 1024 : 2048,
  messages: [{ role: "user", content: phase }, ...results],
  tools: [{ function: { name: "bash" } }],
});
test("base fixture requires real Bash results and preserves the API model identity", () => {
  const result = decide(payload("v1-baseline"));
  assert.equal(result.call.name, "bash");
  assert.match(result.call.arguments.command, /stage3-effects.log/);
  const tool = {
    role: "tool",
    content: JSON.stringify({
      exit_code: 0,
      stderr: "",
      stdout: "v1-baseline\n",
      effect_state: "settled",
      truncated: false,
    }),
  };
  assert.equal(
    decide(payload("v1-baseline", [tool])).text,
    "v1-baseline verified",
  );
  assert.throws(() => decide(payload("unknown")));
  assert.throws(() =>
    decide({ ...payload("v1-baseline"), model: "changed-api-name" }),
  );
  assert.throws(() =>
    decide(payload("v1-baseline", [{ ...tool, content: "fake success" }])),
  );
  assert.throws(
    () => decide(payload("after-rebuild", [tool])),
    /persist|effect/,
  );
});
test("Registry network probe requires service-name and exact IPv4 denial", () => {
  const command = registryDenialCommand("172.28.0.9");
  assert.match(command, /skill-registry:8080\/status/);
  assert.match(command, /--resolve skill-registry:8080:172\.28\.0\.9/);
  assert.match(command, /ip -4 route get 172\.28\.0\.9 uid 1000/);
  assert.match(command, /dev antnest0/);
  assert.match(command, /registry-dns-blocked/);
  assert.match(command, /registry-ip-blocked/);
  assert.throws(() => registryDenialCommand("not-an-ip"));
});
test("HTTP model component enforces credential rotation, trace identity and no duplicate effects", async () => {
  const server = modelServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (phase, key) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: `Bearer ${key}`,
        traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      },
      body: JSON.stringify(payload(phase)),
    });
  try {
    let response = await send("v1-baseline", "stage3-initial-key");
    assert.equal(response.status, 200);
    await response.json();
    response = await send("v1-baseline", "stage3-initial-key");
    assert.equal(response.status, 400);
    await response.json();
    response = await send("v2-baseline", "stage3-initial-key");
    assert.equal(response.status, 400);
    await response.json();
    response = await send("v2-baseline", "stage3-rotated-key");
    assert.equal(response.status, 200);
    await response.json();
    const state = await (
      await fetch(`${base}/status`, { signal: AbortSignal.timeout(5000) })
    ).json();
    assert.equal(state.requests.length, 2);
    assert.equal(state.errors.length, 2);
    assert(!JSON.stringify(state).includes("stage3-rotated-key"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
