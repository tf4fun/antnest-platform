import assert from "node:assert/strict";
import test from "node:test";
import { commandFixture, setup } from "../acp-commands/connection.fixture.mjs";
import { replayRequest } from "../managed-mcp/protocol.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";

const implementation = await import("./client-evidence.mjs").catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes("/acp-restart/client-evidence.mjs")
  )
    throw error;
  return {};
});
const { openPrivateCommandConnection } =
  await import("../acp-commands/connection.mjs");

test("trace failure archival retains the original failure when writing also fails", async () => {
  assert.equal(typeof implementation.preserveRestartFailure, "function");
  const original = new Error("original trace inspection failed"),
    archive = new Error("private storage failed"),
    release = Promise.withResolvers();
  let observed;
  const pending = implementation.preserveRestartFailure(
    original,
    async (error) => {
      observed = error;
      await release.promise;
      throw archive;
    },
  );
  const checked = assert.rejects(
    pending,
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(original) &&
      error.errors.includes(archive),
  );
  assert.strictEqual(observed, original);
  release.resolve();
  await checked;
});

test("successful trace failure archival receives the complete original error", async () => {
  assert.equal(typeof implementation.preserveRestartFailure, "function");
  const original = new Error("original trace inspection failed");
  let observed;
  await implementation.preserveRestartFailure(original, (error) => {
    observed = error;
  });
  assert.strictEqual(observed, original);
});

const originalFailure = new Error("original uncertain restart failure");
const meta = {
  version: 1,
  agentId: "agent",
  kind: "model-held",
  role: "prompt",
};
let identity = 0;
function controlledClient(version = 1, options = {}) {
  const n = ++identity;
  const initializationResult = {
    protocolVersion: version,
    _meta: { "antnest.dev/errors": { version: 1 } },
  };
  const client = {
    boundary: "private-acp",
    transport: "websocket",
    version,
    agentId: "agent",
    connectionTraceID: n.toString(16).padStart(32, "0"),
    clientSpanID: n.toString(16).padStart(16, "0"),
    initializationResult,
    requests: [{ requestId: "1", method: "initialize" }],
    rawFrames: [{ id: 1, result: structuredClone(initializationResult) }],
    async request(name, params) {
      const requestId = String(client.requests.length + 1);
      if (!options.noWire)
        client.requests.push({
          requestId,
          method: "session/" + name,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        });
      if (options.fail?.(name)) throw originalFailure;
      if (params.prompt?.[0]?.text === "unresolved-denied") {
        const rejection = admissionErrorReceipt("runtime_barrier_required");
        const error = Object.assign(new Error(rejection.message), rejection);
        client.rawFrames.push({
          id: Number(requestId),
          error: {
            code: error.code,
            message: error.message,
            data: error.data,
          },
        });
        throw error;
      }
      if (options.hold) await options.hold;
      const result =
        name === "new"
          ? { sessionId: "session-" + n + "-" + requestId }
          : name === "prompt" && version === 2
            ? { messageId: "message-" + n }
            : {};
      client.rawFrames.push({
        id: Number(requestId),
        result: structuredClone(result),
      });
      return result;
    },
    async closeAndWait() {
      if (options.close) await options.close();
    },
  };
  return client;
}
function recorder(client, metadata = meta, preserve = async () => {}) {
  assert.equal(typeof implementation.createRestartRecorder, "function");
  return implementation.createRestartRecorder(client, metadata, preserve);
}
function index(value) {
  assert.equal(typeof implementation.indexRestartRequests, "function");
  return implementation.indexRestartRequests(value);
}

for (const version of [1, 2]) {
  test(`v${version}: actual private SDK requests are archived after joined closure with one initialization`, async (t) => {
    const profile = { version },
      f = await commandFixture(t, profile);
    const client = f.register(
      await openPrivateCommandConnection(profile, "agent", f.browser, {
        ...f.options,
        captureRawFrames: true,
      }),
    );
    const snapshots = [];
    const records = recorder(client, { ...meta, version }, async (row) =>
      snapshots.push(row),
    );
    const created = await records.request("new", setup);
    await records.request("prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: `v${version}-model-held-fault` }],
    });
    const result = await records.closeAndWait();
    assert.deepEqual(
      f.calls.map((row) => row.method),
      ["initialize", "session/new", "session/prompt"],
    );
    assert.equal(f.identities.length, 1);
    await until(
      () => f.sockets.clients.size === 0,
      "actual peer socket close",
      2000,
    );
    assert.equal(result.closed, true);
    assert.equal(
      result.initialization.initializationResult.protocolVersion,
      version,
    );
    assert.equal(result.evidence[0].sessionId, created.sessionId);
    assert.equal(result.evidence[0].inputSessionID, null);
    assert.equal(result.evidence[1].inputSessionID, created.sessionId);
    assert.equal(result.evidence[1].outcome, "succeeded");
    assert.equal(
      result.raw_frames.filter((row) => Object.hasOwn(row, "id")).length,
      3,
    );
    assert.equal(snapshots.at(-1).closed, true);
    assert.deepEqual(await records.closeAndWait(), result);
    assert.equal(
      snapshots.length,
      3,
      "two request archives and one terminal archive",
    );
  });

  test(`v${version}: actual private rejection retains the original error and full raw response`, async (t) => {
    const profile = { version },
      f = await commandFixture(t, profile, { newError: true });
    const client = f.register(
      await openPrivateCommandConnection(profile, "agent", f.browser, {
        ...f.options,
        captureRawFrames: true,
      }),
    );
    const records = recorder(client, { ...meta, version });
    let rejected;
    await assert.rejects(records.request("new", setup), (error) => {
      rejected = error;
      return error.code === -32603;
    });
    const result = await records.closeAndWait();
    assert.equal(result.evidence[0].outcome, "failed");
    assert.match(result.evidence[0].failure, /fixture new refused/);
    assert.equal(result.evidence[0].failureCode, rejected.code);
    assert.equal(result.raw_frames.at(-1).error.code, -32603);
  });
}

test("a failed request is archived before its original error is rethrown", async () => {
  const snapshots = [],
    c = controlledClient(1, { fail: () => true });
  const r = recorder(c, meta, async (row) => snapshots.push(row));
  await assert.rejects(
    r.request("prompt", { sessionId: "s", prompt: [] }),
    (error) => error === originalFailure,
  );
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].evidence[0].outcome, "failed");
  assert.match(
    snapshots[0].evidence[0].failure,
    /original uncertain restart failure/,
  );
  await r.closeAndWait();
});

test("a stale request cannot substitute for a failed send and both errors survive", async () => {
  const c = controlledClient(1, { noWire: true, fail: () => true });
  const r = recorder(c);
  await assert.rejects(
    r.request("prompt", { sessionId: "s", prompt: [] }),
    (error) =>
      error instanceof AggregateError && error.errors.includes(originalFailure),
  );
  await assert.rejects(r.closeAndWait());
});

test("archive failure cannot be swallowed as the expected restart fault", async () => {
  const archive = new Error("private archive failed"),
    c = controlledClient(1, { fail: () => true });
  const r = recorder(c, meta, async () => {
    throw archive;
  });
  await assert.rejects(
    r.request("prompt", { sessionId: "s", prompt: [] }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(originalFailure) &&
      error.errors.includes(archive),
  );
  await assert.rejects(
    r.closeAndWait(),
    (error) => error === archive || error.errors.includes(archive),
  );
});

test("terminal archive waits for the original connection close and retains both close and archive errors", async () => {
  const closed = Promise.withResolvers(),
    started = Promise.withResolvers(),
    snapshots = [];
  const closeError = new Error("original close failed"),
    archive = new Error("archive failed");
  const c = controlledClient(1, {
    close: async () => {
      started.resolve();
      await closed.promise;
      throw closeError;
    },
  });
  const r = recorder(c, meta, async (row) => {
    snapshots.push(row);
    throw archive;
  });
  const pending = r.closeAndWait();
  const checked = assert.rejects(
    pending,
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(closeError) &&
      error.errors.includes(archive),
  );
  await started.promise;
  assert.deepEqual(snapshots, []);
  closed.resolve();
  await checked;
  assert.equal(snapshots[0].closed, false);
});

test("closure joins a pending request archive before capturing the final inventory", async () => {
  const held = Promise.withResolvers(),
    started = Promise.withResolvers(),
    snapshots = [];
  const c = controlledClient(1, {
    hold: held.promise,
    close: () => held.resolve(),
  });
  const r = recorder(c, meta, async (row) => {
    snapshots.push(row);
    started.resolve();
  });
  const request = r.request("new", setup);
  const closing = r.closeAndWait();
  await started.promise;
  await request;
  const result = await closing;
  assert.equal(result.evidence.length, 1);
  assert.equal(result.closed, true);
  assert.equal(snapshots.length, 2);
  await assert.rejects(r.request("new", setup));
});

test("original request inputs and results are independent private snapshots", async () => {
  const c = controlledClient(),
    r = recorder(c);
  const params = structuredClone(setup);
  const result = await r.request("new", params);
  params.cwd = "/foreign";
  result.sessionId = "changed";
  const captured = await r.closeAndWait();
  assert.deepEqual(captured.evidence[0].requestParams, setup);
  assert.notEqual(captured.evidence[0].requestResult.sessionId, "changed");
  assert.equal(
    captured.evidence[0].sessionId,
    captured.evidence[0].requestResult.sessionId,
  );
});

async function completeInventory() {
  const connections = [];
  for (const version of [1, 2])
    for (const kind of ["completed", "model-held", "tool-held", "inflight"]) {
      const label = `v${version}-${kind}`;
      const current = recorder(
        controlledClient(version, {
          fail: (name) =>
            name === "prompt" && version === 1 && kind !== "completed",
        }),
        { ...meta, version, kind },
      );
      const { sessionId } = await current.request("new", setup);
      const other =
        kind === "inflight" ? await current.request("new", setup) : undefined;
      try {
        await current.request("prompt", {
          sessionId,
          prompt: [
            {
              type: "text",
              text:
                kind === "inflight"
                  ? `v${version}-tool-inflight`
                  : label + "-fault",
            },
          ],
        });
      } catch (error) {
        assert.strictEqual(error, originalFailure);
      }
      connections.push(await current.closeAndWait());
      for (const role of [
        "replay-1",
        "replay-2",
        ...(kind === "inflight" ? ["rebuild"] : []),
      ]) {
        const reader = recorder(controlledClient(version), {
          ...meta,
          version,
          kind,
          role,
        });
        const spec = replayRequest(version, sessionId);
        await reader.request(spec.method, spec.params);
        if (role === "replay-2" && kind === "inflight")
          await assert.rejects(
            reader.request("prompt", {
              sessionId: other.sessionId,
              prompt: [{ type: "text", text: "unresolved-denied" }],
            }),
            (error) => error.data.code === "runtime_barrier_required",
          );
        else if (role !== "replay-1")
          await reader.request("prompt", {
            sessionId,
            prompt: [{ type: "text", text: label + "-post" }],
          });
        connections.push(await reader.closeAndWait());
      }
    }
  return { agentId: "agent", connections };
}
test("eight recovery cases bind exactly 26 initializations and 46 original business requests", async () => {
  const f = await completeInventory(),
    before = structuredClone(f);
  const result = index(f);
  assert.equal(result.initializations.length, 26);
  assert.equal(result.requests.length, 46);
  assert.equal(
    result.requests.filter((row) => row.kind === "interruption").length,
    6,
  );
  assert.equal(
    result.requests.filter((row) => row.kind === "ordinary").length,
    10,
  );
  assert.equal(
    result.requests.filter((row) => row.outcome === "failed").length,
    5,
  );
  assert.equal(result.requests.filter((row) => row.rejection).length, 2);
  assert.equal(
    new Set(
      [...result.initializations, ...result.requests].map((row) => row.label),
    ).size,
    72,
  );
  assert.deepEqual(f, before);
});

for (const [name, change] of [
  ["missing connection", (f) => f.connections.pop()],
  [
    "reused connection identity",
    (f) => {
      f.connections[1].connectionTraceID = f.connections[0].connectionTraceID;
    },
  ],
  [
    "unjoined connection",
    (f) => {
      f.connections[0].closed = false;
    },
  ],
  [
    "foreign role",
    (f) => {
      f.connections[0].role = "replay-1";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.connections[0].agentId = "foreign";
    },
  ],
  [
    "wrong protocol",
    (f) => {
      f.connections[0].version = 2;
    },
  ],
  [
    "extra initialization",
    (f) =>
      f.connections[0].requests.push({ requestId: "99", method: "initialize" }),
  ],
  ["missing actual request", (f) => f.connections[0].requests.pop()],
  [
    "stale request ID",
    (f) => {
      f.connections[0].evidence[1].requestId =
        f.connections[0].evidence[0].requestId;
    },
  ],
  [
    "foreign input Session",
    (f) => {
      f.connections[1].evidence[0].inputSessionID = "foreign";
    },
  ],
  [
    "changed replay request",
    (f) => {
      f.connections[1].evidence[0].requestParams.cwd = "/foreign";
    },
  ],
  [
    "changed returned Session",
    (f) => {
      f.connections[0].evidence[0].requestResult.sessionId = "foreign";
    },
  ],
  [
    "missing raw result",
    (f) => {
      f.connections[0].raw_frames.splice(1, 1);
    },
  ],
  [
    "duplicate raw result",
    (f) => {
      f.connections[0].raw_frames.push(f.connections[0].raw_frames[1]);
    },
  ],
  [
    "failed initialization",
    (f) => {
      f.connections[0].initialization.outcome = "failed";
    },
  ],
  [
    "wrong initialization version",
    (f) => {
      f.connections[0].initialization.initializationResult.protocolVersion = 2;
    },
  ],
  [
    "unowned replay error",
    (f) => {
      f.connections[1].evidence[0].outcome = "failed";
    },
  ],
  [
    "unexpected fault success",
    (f) => {
      f.connections[3].evidence[1].outcome = "succeeded";
    },
  ],
  [
    "missing original fault error",
    (f) => {
      delete f.connections[3].evidence[1].failure;
    },
  ],
  [
    "borrowed local close exemption",
    (f) => {
      f.connections[0].evidence[1].closedBeforeResponse = true;
    },
  ],
  [
    "Session attached to initialize",
    (f) => {
      f.connections[0].initialization.inputSessionID = "foreign";
      f.connections[0].requests[0].sessionId = "foreign";
    },
  ],
  ...["missing", "empty", "foreign raw"].map((value) => [
    `${value} v2 interrupted ACK`,
    (f) => {
      const c = f.connections.find(
        (row) =>
          row.version === 2 &&
          row.kind === "model-held" &&
          row.role === "prompt",
      );
      const row = c.evidence[1];
      const raw = c.raw_frames.find(
        (frame) => String(frame.id) === row.requestId,
      );
      if (value === "foreign raw") raw.result.messageId = "foreign-message";
      else if (value === "empty")
        row.requestResult.messageId = raw.result.messageId = "";
      else {
        delete row.requestResult.messageId;
        delete raw.result.messageId;
      }
    },
  ]),
])
  test(`inventory rejects ${name}`, async () => {
    const f = await completeInventory();
    change(f);
    assert.throws(() => index(f));
  });

for (const [name, mutate] of [
  [
    "cross-connection response",
    (f) => {
      f.connections[0].raw_frames[1] = structuredClone(
        f.connections[3].raw_frames[1],
      );
    },
  ],
  [
    "wrong barrier domain",
    (f) => {
      const c = f.connections.find(
        (c) => c.kind === "inflight" && c.role === "replay-2",
      );
      c.evidence[1].failureData.code = "foreign";
    },
  ],
  [
    "missing barrier response",
    (f) => {
      const c = f.connections.find(
        (c) => c.kind === "inflight" && c.role === "replay-2",
      );
      c.raw_frames.pop();
    },
  ],
  [
    "foreign prompt Session",
    (f) => {
      const c = f.connections[0];
      c.evidence[1].sessionId = "foreign";
    },
  ],
])
  test(`inventory rejects ${name}`, async () => {
    const f = await completeInventory();
    mutate(f);
    assert.throws(() => index(f));
  });

test("terminal capture includes late frames and updates after joining transport and pending requests", async () => {
  const held = Promise.withResolvers();
  const client = controlledClient(1, {
    hold: held.promise,
    close: () => {
      client.rawFrames.push({
        method: "session/update",
        params: { sessionId: "late" },
      });
      client.updates.push({ sessionId: "late" });
      held.resolve();
    },
  });
  client.updates = [];
  const r = recorder(client);
  const request = r.request("new", setup);
  const closing = r.closeAndWait();
  await request;
  const snapshot = await closing;
  assert.equal(
    snapshot.raw_frames.some((frame) => frame.method === "session/update"),
    true,
  );
  assert.deepEqual(snapshot.updates, [{ sessionId: "late" }]);
});

async function completeAutoInventory({
  version = 2,
  extraReplay2,
  extraConnection = false,
} = {}) {
  const connections = [],
    kind = "inflight",
    label = `v${version}-${kind}`,
    current = recorder(
      controlledClient(version, {
        fail: (name) => name === "prompt" && version === 1,
      }),
      { ...meta, version, kind },
    );
  let sessionId, other;
  try {
    ({ sessionId } = await current.request("new", setup));
    other = await current.request("new", setup);
    try {
      await current.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: `v${version}-tool-inflight` }],
      });
    } catch (error) {
      assert.strictEqual(error, originalFailure);
    }
  } finally {
    connections.push(await current.closeAndWait());
  }
  for (const role of [
    "replay-1",
    "replay-2",
    "rebuild",
    ...(extraConnection ? ["replay-1"] : []),
  ]) {
    const reader = recorder(controlledClient(version), {
      ...meta,
      version,
      kind,
      role,
    });
    try {
      const spec = replayRequest(version, sessionId);
      await reader.request(spec.method, spec.params);
      if (role === "replay-2" && extraReplay2 === "denied")
        await assert.rejects(
          reader.request("prompt", {
            sessionId: other.sessionId,
            prompt: [{ type: "text", text: "unresolved-denied" }],
          }),
          (error) => error.data.code === "runtime_barrier_required",
        );
      else if (
        role === "rebuild" ||
        (role === "replay-2" && extraReplay2 === "prompt")
      )
        await reader.request("prompt", {
          sessionId,
          prompt: [{ type: "text", text: label + "-post" }],
        });
    } finally {
      connections.push(await reader.closeAndWait());
    }
  }
  return { agentId: "agent", connections, recoveryMode: "auto" };
}

test("auto recovery binds one v2 in-flight case to four joined connections and seven complete requests", async () => {
  const f = await completeAutoInventory(),
    before = structuredClone(f);
  const result = index(f);
  assert.equal(result.initializations.length, 4);
  assert.equal(result.requests.length, 7);
  assert.deepEqual(
    result.requests.map((row) => row.method),
    [
      "session/new",
      "session/new",
      "session/prompt",
      "session/resume",
      "session/resume",
      "session/resume",
      "session/prompt",
    ],
  );
  assert.deepEqual(
    result.requests.map((row) => row.label),
    [
      "v2-inflight-new",
      "v2-inflight-other-new",
      "v2-tool-inflight",
      "v2-inflight-replay-1",
      "v2-inflight-replay-2",
      "v2-inflight-rebuild-replay",
      "v2-inflight-post",
    ],
  );
  const captured = f.connections.flatMap((connection) => connection.evidence);
  for (const [position, row] of result.requests.entries()) {
    const original = captured[position];
    for (const field of [
      "connectionTraceID",
      "requestId",
      "requestParams",
      "requestResult",
      "inputSessionID",
      "sessionId",
      "outcome",
    ])
      assert.deepEqual(row[field], original[field], `changed auto ${field}`);
    assert.equal(row.version, 2);
  }
  assert.equal(
    result.requests.filter((row) => row.kind === "interruption").length,
    1,
  );
  assert.equal(
    result.requests.filter((row) => row.kind === "ordinary").length,
    1,
  );
  assert.equal(
    result.requests.filter((row) => row.outcome === "failed").length,
    0,
  );
  assert.equal(result.requests.filter((row) => row.rejection).length, 0);
  assert.equal(
    new Set(
      [...result.initializations, ...result.requests].map((row) => row.label),
    ).size,
    11,
  );
  assert.deepEqual(f, before);
});

for (const [name, options] of [
  ["the manual barrier-denial request", { extraReplay2: "denied" }],
  ["an extra successful replay-2 Prompt", { extraReplay2: "prompt" }],
  ["an internally consistent v1 profile", { version: 1 }],
  ["an extra independently recorded connection", { extraConnection: true }],
])
  test(`auto inventory rejects ${name}`, async () => {
    const f = await completeAutoInventory(options),
      before = structuredClone(f);
    assert.throws(() => index(f));
    assert.deepEqual(f, before);
  });

test("auto inventory rejects a connection without its joined-close receipt", async () => {
  const f = await completeAutoInventory();
  delete f.connections[2].closed;
  const before = structuredClone(f);
  assert.throws(() => index(f));
  assert.deepEqual(f, before);
});

test("inventory rejects an unknown recovery mode instead of silently accepting the default manual inventory", async () => {
  const f = { ...(await completeInventory()), recoveryMode: "automatic" },
    before = structuredClone(f);
  assert.throws(() => index(f));
  assert.deepEqual(f, before);
});
