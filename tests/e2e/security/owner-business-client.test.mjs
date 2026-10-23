import assert from "node:assert/strict";
import test from "node:test";
import { exerciseOwnerBusiness } from "./owner-business-client.mjs";

const agentId = `agent_${"1".repeat(32)}`;
// ACP's domain/resource-id.ts generates kind + '_' + 16 lower-hex bytes.
const sessionId = `session_${"2".repeat(32)}`;
const messageId = `message_${"3".repeat(32)}`;
const prompt = [{ type: "text", text: "foreground during review" }];
const frames = [
  {
    sessionId,
    update: {
      sessionUpdate: "user_message_chunk",
      messageId: `message_${"4".repeat(32)}`,
      content: prompt[0],
    },
  },
  {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "Foreground request completed." },
    },
  },
];

function fixture({ held = false, failureAt } = {}) {
  const calls = [];
  const tasks = [];
  const controller = new AbortController();
  const gates = Object.fromEntries(
    ["new", "prompt", "model"].map((name) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      if (!held) release.resolve();
      return [name, { entered, release }];
    }),
  );
  const state = {
    newReply: { sessionId },
    promptReply: { stopReason: "end_turn" },
    frames: structuredClone(frames),
    model: {
      requests: ["foreground-preempt-reply"],
      errors: [],
      pending: [],
      cancelled: [],
    },
  };
  const client = { updates: [] };
  const own = (name, work) => {
    const task = (async () => {
      gates[name].entered.resolve();
      await gates[name].release.promise;
      if (failureAt === name)
        throw new Error(`${name} actual operation failed`);
      const result = work();
      calls.push(`${name}-completed`);
      return result;
    })();
    tasks.push(task);
    void task.catch(() => {});
    return task;
  };
  client.request = (...args) => {
    const [method] = args;
    calls.push({ method, args: structuredClone(args) });
    assert(["new", "prompt"].includes(method), "unexpected ACP operation");
    return own(method, () => {
      if (method === "new") return state.newReply;
      client.updates.push(...structuredClone(state.frames));
      return state.promptReply;
    });
  };
  const input = {
    agentId,
    client,
    signal: controller.signal,
    readModelStatus() {
      calls.push({ method: "model" });
      return own("model", () => state.model);
    },
  };
  return {
    input,
    state,
    calls,
    gates,
    controller,
    start() {
      const pending = { settled: false, promise: undefined };
      pending.promise = Promise.resolve()
        .then(() => exerciseOwnerBusiness(input))
        .then(
          (value) => {
            pending.settled = true;
            return { ok: true, value };
          },
          (error) => {
            pending.settled = true;
            return { ok: false, error };
          },
        );
      return pending;
    },
    async join(pending) {
      controller.abort(new Error("owner business fixture cleanup"));
      for (const gate of Object.values(gates)) gate.release.resolve();
      await pending.promise;
      await Promise.allSettled(tasks);
    },
  };
}

async function entered(pending, gate, name) {
  let timer;
  try {
    await Promise.race([
      gate.entered.promise,
      pending.promise.then(() => {
        throw new Error(`${name} did not actually execute`);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} did not start`)),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function methods(f) {
  return f.calls
    .filter((call) => typeof call === "object")
    .map((call) => call.method);
}

test("owner business awaits original Session, Prompt and one model read in order", async () => {
  const f = fixture({ held: true });
  const pending = f.start();
  try {
    await entered(pending, f.gates.new, "new Session");
    assert.deepEqual(f.calls, [
      { method: "new", args: ["new", { cwd: "/workspace", mcpServers: [] }] },
    ]);
    assert.equal(pending.settled, false);
    f.gates.new.release.resolve();
    await entered(pending, f.gates.prompt, "original Prompt");
    assert.deepEqual(f.calls, [
      { method: "new", args: ["new", { cwd: "/workspace", mcpServers: [] }] },
      "new-completed",
      { method: "prompt", args: ["prompt", { sessionId, prompt }, 90000] },
    ]);
    assert.equal(pending.settled, false);
    f.gates.prompt.release.resolve();
    await entered(pending, f.gates.model, "model status read");
    assert.deepEqual(f.calls.slice(-2), [
      "prompt-completed",
      { method: "model" },
    ]);
    assert.equal(pending.settled, false);
    f.gates.model.release.resolve();
    const outcome = await pending.promise;
    if (!outcome.ok) throw outcome.error;
    assert.deepEqual(outcome.value, {
      status: "passed",
      agent_id: agentId,
      session_id: sessionId,
    });
    assert.deepEqual(methods(f), ["new", "prompt", "model"]);
    assert.equal(f.calls.at(-1), "model-completed");
    assert.deepEqual(f.input.client.updates, frames);
  } finally {
    await f.join(pending);
  }
});

for (const failureAt of ["new", "prompt", "model"]) {
  test(`owner business does not accept a rejected ${failureAt} operation or run later work`, async () => {
    const f = fixture({ failureAt });
    const pending = f.start();
    try {
      const outcome = await pending.promise;
      assert.equal(outcome.ok, false);
      assert.deepEqual(
        methods(f),
        ["new", "prompt", "model"].slice(
          0,
          ["new", "prompt", "model"].indexOf(failureAt) + 1,
        ),
      );
    } finally {
      await f.join(pending);
    }
  });
}

test("owner business rejects pre-cancellation without starting ACP or model work", async () => {
  const f = fixture();
  f.controller.abort(new Error("cancel before business"));
  const pending = f.start();
  try {
    assert.equal((await pending.promise).ok, false);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.join(pending);
  }
});

for (const stage of ["new", "prompt", "model"]) {
  test(`owner business cancellation joins an already-started ${stage} before rejecting`, async () => {
    const f = fixture({ held: true });
    for (const name of ["new", "prompt", "model"].slice(
      0,
      ["new", "prompt", "model"].indexOf(stage),
    ))
      f.gates[name].release.resolve();
    const pending = f.start();
    try {
      await entered(pending, f.gates[stage], stage);
      f.controller.abort(new Error(`cancel held ${stage}`));
      // One event-loop turn lets cancellation handlers and their microtasks
      // execute; the original dependency deliberately remains unresolved.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        pending.settled,
        false,
        "cancellation abandoned an original operation",
      );
      assert(!f.calls.includes(`${stage}-completed`));
      f.gates[stage].release.resolve();
      assert.equal(
        (await pending.promise).ok,
        false,
        "late success after cancellation became a pass",
      );
      assert(f.calls.includes(`${stage}-completed`));
      assert.deepEqual(
        methods(f),
        ["new", "prompt", "model"].slice(
          0,
          ["new", "prompt", "model"].indexOf(stage) + 1,
        ),
      );
    } finally {
      await f.join(pending);
    }
  });
}

for (const [name, change] of [
  [
    "duplicate model request",
    (f) => {
      f.state.model.requests.push("foreground-preempt-reply");
    },
  ],
  [
    "wrong model request",
    (f) => {
      f.state.model.requests = ["other-model-request"];
    },
  ],
  [
    "missing model request",
    (f) => {
      f.state.model.requests = [];
    },
  ],
  [
    "model error",
    (f) => {
      f.state.model.errors.push("model failed");
    },
  ],
  [
    "pending model task",
    (f) => {
      f.state.model.pending.push("still-running");
    },
  ],
  [
    "cancelled model task",
    (f) => {
      f.state.model.cancelled.push("cancelled-request");
    },
  ],
]) {
  test(`owner business rejects ${name} after one actual model inventory read`, async () => {
    const f = fixture();
    change(f);
    const pending = f.start();
    try {
      assert.equal((await pending.promise).ok, false);
      assert.deepEqual(methods(f), ["new", "prompt", "model"]);
      assert(f.calls.includes("model-completed"));
    } finally {
      await f.join(pending);
    }
  });
}

for (const [name, change] of [
  [
    "foreign Session frame",
    (f) => {
      f.state.frames[1].sessionId = `session_${"f".repeat(32)}`;
    },
  ],
  [
    "wrong assistant text",
    (f) => {
      f.state.frames[1].update.content.text = "Unexpected response.";
    },
  ],
  [
    "missing assistant",
    (f) => {
      f.state.frames.pop();
    },
  ],
  [
    "extra assistant",
    (f) => {
      const extra = structuredClone(f.state.frames[1]);
      extra.update.messageId = `message_${"5".repeat(32)}`;
      f.state.frames.push(extra);
    },
  ],
]) {
  test(`owner business rejects transcript with ${name}`, async () => {
    const f = fixture();
    change(f);
    const pending = f.start();
    try {
      assert.equal((await pending.promise).ok, false);
      assert.deepEqual(methods(f).slice(0, 2), ["new", "prompt"]);
      assert(f.calls.includes("prompt-completed"));
    } finally {
      await f.join(pending);
    }
  });
}

for (const promptReply of [{ stopReason: "cancelled" }, {}]) {
  test(`owner business requires an actual end_turn receipt: ${JSON.stringify(promptReply)}`, async () => {
    const f = fixture();
    f.state.promptReply = promptReply;
    const pending = f.start();
    try {
      assert.equal((await pending.promise).ok, false);
      assert(f.calls.includes("prompt-completed"));
    } finally {
      await f.join(pending);
    }
  });
}

for (const invalid of [
  "",
  `session_${"A".repeat(32)}`,
  "12345678-1234-4abc-8abc-1234567890ab",
]) {
  test(`owner business rejects a noncanonical new Session ID ${JSON.stringify(invalid)}`, async () => {
    const f = fixture();
    f.state.newReply = { sessionId: invalid };
    const pending = f.start();
    try {
      assert.equal((await pending.promise).ok, false);
      assert.deepEqual(methods(f), ["new"]);
    } finally {
      await f.join(pending);
    }
  });
}

for (const invalid of ["agent_short", `agent_${"A".repeat(32)}`, sessionId]) {
  test(`owner business rejects a foreign Agent ID shape ${JSON.stringify(invalid)} before effects`, async () => {
    const f = fixture();
    f.input.agentId = invalid;
    const pending = f.start();
    try {
      assert.equal((await pending.promise).ok, false);
      assert.deepEqual(f.calls, []);
    } finally {
      await f.join(pending);
    }
  });
}
