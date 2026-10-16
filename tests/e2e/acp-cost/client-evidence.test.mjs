import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./client-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
    return {};
  throw error;
});
function client(version, method, params, result) {
  return {
    version,
    rawUpdates: [],
    lastRequest: {
      boundary: "private-acp",
      version,
      protocolVersion: version,
      method,
      requestId: "actual-sdk-request",
      inputSessionID: params.sessionId ?? null,
      sessionId: params.sessionId,
      outcome: "succeeded",
      kind: "request",
      requestReceipt: {
        requestId: "actual-sdk-request",
        params: structuredClone(params),
        result: structuredClone(result),
      },
    },
  };
}
function prompt(version) {
  const result =
    version === 1
      ? { stopReason: "end_turn" }
      : { messageId: "actual-message" };
  const c = client(
    version,
    "session/prompt",
    { sessionId: "session", prompt: [{ type: "text", text: "phase" }] },
    result,
  );
  if (version === 2)
    c.rawUpdates.push({
      sessionId: "session",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      },
    });
  return { c, result };
}
for (const version of [1, 2]) {
  test(`Cost v${version} binds the actual prompt reply and terminal before marking execution`, () => {
    const { c, result } = prompt(version);
    const terminal = structuredClone(c.rawUpdates);
    implementation.bindCostPrompt(c, "session", result, "phase");
    assert.equal(c.lastRequest.kind, "native");
    assert.equal(c.lastRequest.phase, "phase");
    assert.deepEqual(c.lastRequest.promptReceipt, {
      requestId: "actual-sdk-request",
      sessionId: "session",
      result,
      error: null,
      terminals: terminal,
    });
    result.extra = "later mutation";
    c.rawUpdates.length = 0;
    assert.equal(c.lastRequest.promptReceipt.result.extra, undefined);
    assert.deepEqual(c.lastRequest.promptReceipt.terminals, terminal);
  });
  for (const [name, mutate] of [
    [
      "wrong method",
      (c) => {
        c.lastRequest.method = "session/new";
      },
    ],
    [
      "foreign receipt",
      (c) => {
        c.lastRequest.requestReceipt.requestId = "foreign";
      },
    ],
    [
      "rejected request",
      (c) => {
        c.lastRequest.outcome = "rejected";
      },
    ],
    [
      "foreign Session",
      (c) => {
        c.lastRequest.requestReceipt.params.sessionId = "foreign";
      },
    ],
    [
      "changed SDK reply",
      (c) => {
        c.lastRequest.requestReceipt.result.changed = true;
      },
    ],
    [
      "foreign terminal",
      (c) => {
        c.rawUpdates.push({
          sessionId: "foreign",
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        });
      },
    ],
  ])
    test(`Cost v${version} refuses ${name} without claiming a Run`, () => {
      assert.equal(typeof implementation.bindCostPrompt, "function");
      const { c, result } = prompt(version);
      mutate(c);
      assert.throws(() =>
        implementation.bindCostPrompt(c, "session", result, "phase"),
      );
      assert.equal(c.lastRequest.kind, "request");
      assert.equal(c.lastRequest.promptReceipt, undefined);
    });
  test(`Cost v${version} configuration receipt is the actual successful SDK request`, () => {
    const result = {
      configOptions: [
        {
          [version === 1 ? "id" : "configId"]: "model",
          currentValue: "profile:model",
        },
      ],
    };
    const c = client(
      version,
      "session/set_config_option",
      {
        sessionId: "session",
        configId: "model",
        value: "profile:model",
        ...(version === 2 ? { type: "id" } : {}),
      },
      result,
    );
    implementation.bindCostConfiguration(c, "session", "profile:model");
    assert.deepEqual(
      c.lastRequest.configurationReceipt,
      c.lastRequest.requestReceipt,
    );
    assert.notStrictEqual(
      c.lastRequest.configurationReceipt,
      c.lastRequest.requestReceipt,
    );
    assert.equal(c.lastRequest.modelSelection, "profile:model");
    assert.throws(() =>
      implementation.bindCostConfiguration(c, "session", "agent_default"),
    );
  });
}
for (const variant of ["missing", "duplicate", "failed"])
  test(`Cost v2 refuses ${variant} terminal`, () => {
    assert.equal(typeof implementation.bindCostPrompt, "function");
    const { c, result } = prompt(2);
    if (variant === "missing") c.rawUpdates.length = 0;
    if (variant === "duplicate")
      c.rawUpdates.push(structuredClone(c.rawUpdates[0]));
    if (variant === "failed") c.rawUpdates[0].update.stopReason = "_failed";
    assert.throws(() =>
      implementation.bindCostPrompt(c, "session", result, "phase"),
    );
  });
test("Cost list proves the independently known observer Sessions", () => {
  const c = client(
    1,
    "session/list",
    {},
    { sessions: [{ sessionId: "observer" }] },
  );
  const ids = ["observer"];
  implementation.bindCostList(c, ids);
  assert.deepEqual(c.lastRequest.listSessionIds, ids);
  assert.deepEqual(c.lastRequest.listReceipt, c.lastRequest.requestReceipt);
  ids.push("later");
  assert.deepEqual(c.lastRequest.listSessionIds, ["observer"]);
});
for (const [name, mutate, ids] of [
  [
    "foreign Session",
    (r) => {
      r.result.sessions.push({ sessionId: "foreign" });
    },
    ["observer"],
  ],
  [
    "missing observer",
    (r) => {
      r.result.sessions = [];
    },
    ["observer"],
  ],
  [
    "pagination",
    (r) => {
      r.result.nextCursor = "more";
    },
    ["observer"],
  ],
  [
    "foreign params",
    (r) => {
      r.params.cursor = "earlier";
    },
    ["observer"],
  ],
  ["duplicate expected Session", () => {}, ["observer", "observer"]],
])
  test(`Cost list refuses ${name}`, () => {
    assert.equal(typeof implementation.bindCostList, "function");
    const c = client(
      1,
      "session/list",
      {},
      { sessions: [{ sessionId: "observer" }] },
    );
    mutate(c.lastRequest.requestReceipt);
    assert.throws(() => implementation.bindCostList(c, ids));
    assert.equal(c.lastRequest.listReceipt, undefined);
  });
test("frozen Cost release failure still joins the original prompt and retains both errors", async () => {
  assert.equal(typeof implementation.withFrozenCostPrompt, "function");
  const deferred = Promise.withResolvers();
  const released = Promise.withResolvers();
  const releaseError = new Error("release failed"),
    promptError = new Error("original prompt failed");
  let settled = false;
  const task = implementation.withFrozenCostPrompt(
    deferred.promise,
    async () => {},
    async () => {
      released.resolve();
      throw releaseError;
    },
  );
  void task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await released.promise;
  await Promise.resolve();
  assert.equal(
    settled,
    false,
    "release failure must not abandon admitted prompt",
  );
  deferred.reject(promptError);
  await assert.rejects(task, (error) => {
    assert.deepEqual(error.errors, [releaseError, promptError]);
    return true;
  });
});
test("frozen Cost publication failure still releases and joins, preserving all original errors", async () => {
  assert.equal(typeof implementation.withFrozenCostPrompt, "function");
  const errors = [
    new Error("publish"),
    new Error("release"),
    new Error("prompt"),
  ];
  let released = false;
  await assert.rejects(
    implementation.withFrozenCostPrompt(
      Promise.reject(errors[2]),
      async () => {
        throw errors[0];
      },
      async () => {
        released = true;
        throw errors[1];
      },
    ),
    (error) => {
      assert.deepEqual(error.errors, errors);
      return true;
    },
  );
  assert.equal(released, true);
});
test("frozen Cost single original failure is not replaced, and success returns actual prompt value", async () => {
  assert.equal(typeof implementation.withFrozenCostPrompt, "function");
  const error = new Error("original");
  await assert.rejects(
    implementation.withFrozenCostPrompt(
      Promise.reject(error),
      async () => {},
      async () => {},
    ),
    (actual) => actual === error,
  );
  const value = { amount: 0.0028 };
  assert.strictEqual(
    await implementation.withFrozenCostPrompt(
      Promise.resolve(value),
      async () => {},
      async () => {},
    ),
    value,
  );
});
