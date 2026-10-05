import assert from "node:assert/strict";
import test from "node:test";
import { modelServer } from "../skill-learning/automatic-model.mjs";

async function withModel(inspect) {
  const server = modelServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await inspect(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

test("deterministic model discovery records actual authorized reads separately from inference", async () => {
  await withModel(async (origin) => {
    const response = await fetch(`${origin}/v1/models`, {
      headers: { Authorization: "Bearer stage3-model-secret" },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: [
        {
          id: "stage3-model",
          name: "Synthetic discovery model",
          context_length: 8192,
          top_provider: { max_completion_tokens: 1024 },
          architecture: { input_modalities: ["text", "image"] },
        },
      ],
    });
    const status = await fetch(`${origin}/status`, {
      signal: AbortSignal.timeout(3000),
    }).then((value) => value.json());
    assert.equal(status.discoveries, 1);
    assert.deepEqual(status.requests, []);
    assert.deepEqual(status.errors, []);
  });
});

test("discovery rejects missing and incorrect synthetic credentials without recording a read", async () => {
  await withModel(async (origin) => {
    for (const authorization of [undefined, "Bearer wrong-fixture-key"]) {
      const response = await fetch(`${origin}/v1/models`, {
        headers: authorization ? { Authorization: authorization } : {},
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
    const status = await fetch(`${origin}/status`, {
      signal: AbortSignal.timeout(3000),
    }).then((value) => value.json());
    assert.equal(status.discoveries, 0);
    assert.deepEqual(status.requests, []);
  });
});
