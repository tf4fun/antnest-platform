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
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
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

test("outgoing request observation preserves raw private fields before SDK parsing", async () => {
  const { observeStream } = await import("../acp-commands/transport.mjs");
  const observed = [],
    frames = [],
    updates = [],
    sent = [];
  const frame = { jsonrpc: "2.0", id: 7, result: { _meta: { receipt: {} } } };
  const stream = observeWire(
    observeStream(
      {
        readable: new ReadableStream({
          start(c) {
            c.enqueue(frame);
            c.close();
          },
        }),
        writable: new WritableStream({
          write(m) {
            sent.push(m);
          },
        }),
      },
      observed,
    ),
    updates,
    frames,
  );
  const writer = stream.writable.getWriter();
  const outgoing = {
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: { sessionId: "s" },
  };
  await writer.write(outgoing);
  await writer.close();
  assert.deepEqual(sent, [outgoing]);
  assert.deepEqual(observed, [
    { requestId: "7", method: "session/prompt", sessionId: "s" },
  ]);
  const reader = stream.readable.getReader();
  assert.deepEqual((await reader.read()).value, frame);
  assert.equal((await reader.read()).done, true);
  assert.throws(() => assertPublicFrames(frames));
});

test("observer permits only its own public configuration refresh, never foreign usage or replay", async () => {
  const { assertObserverIsolation } = await import("./evidence.mjs");
  const baseline = [
    {
      sessionId: "observer",
      update: {
        sessionUpdate: "usage_update",
        cost: { amount: 0.77, currency: "USD" },
      },
    },
  ];
  const refresh = {
    sessionId: "observer",
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "model", currentValue: "agent_default" }],
    },
  };
  assertObserverIsolation(
    [
      ...baseline,
      refresh,
      {
        sessionId: "observer",
        update: { sessionUpdate: "current_mode_update", currentModeId: "ask" },
      },
    ],
    baseline,
    "observer",
    "ask",
  );
  assert.throws(() =>
    assertObserverIsolation(
      [
        ...baseline,
        {
          sessionId: "observer",
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "auto",
          },
        },
      ],
      baseline,
      "observer",
      "ask",
    ),
  );
  for (const tail of [
    { ...refresh, sessionId: "foreign" },
    baseline[0],
    {
      ...refresh,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "foreign" },
      },
    },
    {
      ...refresh,
      update: {
        ...refresh.update,
        configOptions: [{ id: "model", currentValue: "profile:foreign" }],
      },
    },
  ])
    assert.throws(() =>
      assertObserverIsolation([...baseline, tail], baseline, "observer"),
    );
  assert.throws(() => assertObserverIsolation([], baseline, "observer"));
});

test("multiplexed owned configuration refresh cannot hide foreign content or changed selections", async () => {
  const { operationUpdates } = await import("./evidence.mjs");
  const owned = new Map([["old", { model: "agent_default", mode: "ask" }]]);
  const refresh = {
    sessionId: "old",
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "model", currentValue: "agent_default" }],
    },
  };
  const target = {
    sessionId: "new",
    update: { sessionUpdate: "available_commands_update" },
  };
  assert.deepEqual(operationUpdates([refresh, target], "new", owned), [target]);
  assertOperationUpdates(
    "new",
    {},
    { sessionId: "new" },
    [refresh, target],
    owned,
  );
  for (const bad of [
    { ...refresh, sessionId: "foreign" },
    { ...refresh, update: { sessionUpdate: "usage_update" } },
    { ...refresh, update: { sessionUpdate: "state_update", state: "idle" } },
  ])
    assert.throws(() =>
      assertOperationUpdates(
        "new",
        {},
        { sessionId: "new" },
        [bad, target],
        owned,
      ),
    );
  const changed = structuredClone(refresh);
  changed.update.configOptions[0].currentValue = "profile:other";
  assert.throws(() => operationUpdates([changed], "new", owned));
  assert.throws(() =>
    operationUpdates(
      [
        {
          sessionId: "old",
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "auto",
          },
        },
      ],
      "new",
      owned,
    ),
  );
});

test("SDK set-config responses preserve the existing mode baseline and forks inherit it", async () => {
  const { rememberSelection } = await import("./evidence.mjs");
  const owned = new Map();
  rememberSelection(
    owned,
    "new",
    {},
    {
      sessionId: "parent",
      modes: { currentModeId: "ask" },
      configOptions: [{ id: "model", currentValue: "agent_default" }],
    },
  );
  rememberSelection(
    owned,
    "setConfigOption",
    { sessionId: "parent" },
    { configOptions: [{ id: "model", currentValue: "profile:m" }] },
  );
  assert.deepEqual(owned.get("parent"), { model: "profile:m", mode: "ask" });
  rememberSelection(
    owned,
    "fork",
    { sessionId: "parent" },
    {
      sessionId: "fork",
      configOptions: [{ id: "model", currentValue: "profile:m" }],
    },
  );
  assert.deepEqual(owned.get("fork"), owned.get("parent"));
});
