import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observeWire } from "./wire.mjs";
import {
  assertCost,
  assertPublicFrames,
  assertOperationUpdates,
  assertModelSelection,
} from "./evidence.mjs";

test("privacy oracle sees receipt leakage before the real SDK strips it", async () => {
  const require = createRequire(
    new URL("../../services/agent-acp-service/package.json", import.meta.url),
  );
  const sdk = await import(require.resolve("@agentclientprotocol/sdk"));
  let input, received;
  const parsed = new Promise((resolve) => {
    received = resolve;
  });
  const updates = [];
  const stream = {
    readable: new ReadableStream({
      start(controller) {
        input = controller;
      },
    }),
    writable: new WritableStream(),
  };
  const connection = sdk
    .client()
    .onNotification(sdk.methods.client.session.update, ({ params }) =>
      received(params),
    )
    .connect(observeWire(stream, updates));
  const timeout = setTimeout(() => received(undefined), 2000);
  try {
    input.enqueue({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: {
          sessionUpdate: "usage_update",
          used: 1100,
          size: 64000,
          cost: { amount: 0.01, currency: "USD", source: "estimated" },
          measurement: { pricing: "private" },
        },
      },
    });
    const sanitized = await parsed;
    assert(sanitized, "SDK did not consume notification");
    assert.equal(sanitized.update.measurement, undefined);
    assert.equal(sanitized.update.cost.source, undefined);
    assertCost([sanitized], "s", 0.01);
    assert.throws(() => assertCost(updates, "s", 0.01));
  } finally {
    clearTimeout(timeout);
    connection.close();
  }
});

test("restart health wrapper terminates on unhealthy exhaustion and inspection failure", () => {
  const helper = fileURLToPath(
    new URL("../acp-closeout/container-state.sh", import.meta.url),
  );
  const run = (body) =>
    spawnSync(
      "sh",
      [
        "-c",
        `. "$1"; docker_cmd() { ${body}; }; sleep() { :; }; wait_for_health fixture`,
        "health-test",
        helper,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
  assert.equal(run("printf healthy").status, 0);
  const unhealthy = run("echo inspected >&2; printf unhealthy");
  assert.equal(unhealthy.status, 1);
  assert.equal(unhealthy.stderr.match(/inspected/g)?.length, 60);
  assert.equal(run("return 124").status, 124);
  assert.equal(run("return 1").status, 1);
});

test("client completion requires a successful atomic stopped-state inspection", () => {
  const helper = fileURLToPath(
    new URL("../acp-closeout/container-state.sh", import.meta.url),
  );
  const run = (body) =>
    spawnSync(
      "sh",
      [
        "-c",
        `. "$1"; docker_cmd() { ${body}; }; client_state fixture`,
        "client-test",
        helper,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
  assert.equal(run("printf running:0").stdout.trim(), "running");
  assert.equal(run("printf exited:0").stdout.trim(), "exited:0");
  assert.equal(run("printf exited:2").stdout.trim(), "exited:2");
  for (const body of [
    "return 1",
    "return 124",
    "printf dead:0",
    "printf created:0",
    "printf exited:garbage",
  ])
    assert.notEqual(run(body).status, 0);
});

test("full raw frames reject private receipt metadata in notifications and results", () => {
  const normal = { jsonrpc: "2.0", id: 1, result: { sessionId: "s" } };
  assertPublicFrames([normal]);
  for (const frame of [
    { ...normal, result: { _meta: { pricing: { input_per_million: 2 } } } },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", _meta: { measurement: {} }, update: {} },
    },
    { ...normal, result: { unexpected: "cost-model-test" } },
  ])
    assert.throws(() => assertPublicFrames([frame]));
});

test("configuration operations cannot discard foreign notifications or wrong replay choices", () => {
  for (const name of ["new", "setConfigOption", "fork"]) {
    const params = { sessionId: "parent" },
      result = { sessionId: "created" };
    const sessionId = name === "setConfigOption" ? "parent" : "created";
    assertOperationUpdates(name, params, result, [{ sessionId }]);
    assert.throws(() =>
      assertOperationUpdates(name, params, result, [{ sessionId: "foreign" }]),
    );
  }
  const result = {
    configOptions: [{ id: "model", currentValue: "profile:saved" }],
  };
  assertModelSelection(result, "profile:saved");
  assert.throws(() => assertModelSelection(result, "agent_default"));
});
