import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
const implementation = await import("./private-requests.mjs").catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes("/workspace-closeout/private-requests.mjs")
  )
    throw error;
  return {};
});
function fixture(method = "session/load", rejection) {
  const identity = {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    agentId: "agent",
    connectionTraceID: "c".repeat(32),
    clientSpanID: "a".repeat(16),
  };
  const row = {
    ...identity,
    method,
    requestId: "2",
    outcome: "succeeded",
    inputSessionID: method === "session/new" ? null : "session",
    sessionId: "session",
    requestParams:
      method === "session/new"
        ? { cwd: "/workspace", mcpServers: [] }
        : { sessionId: "session", cwd: "/workspace", mcpServers: [] },
    requestResult: method === "session/new" ? { sessionId: "session" } : {},
  };
  if (method === "initialize") {
    row.inputSessionID = null;
    delete row.sessionId;
    delete row.requestParams;
    delete row.requestResult;
    row.initializationResult = { protocolVersion: 1 };
  }
  if (method === "session/prompt")
    row.requestParams = {
      sessionId: "session",
      prompt: [{ type: "text", text: "c4-rebuilt" }],
    };
  let frame = { id: 2, result: row.requestResult ?? row.initializationResult };
  const observation = {
    connectionTraceID: identity.connectionTraceID,
    requestId: row.requestId,
    method,
  };
  if (rejection) {
    row.outcome = "failed";
    delete row.requestResult;
    row.failure = "RequestError";
    row.failureCode = -32020;
    row.failureData = { code: rejection, retryable: false };
    row.rejectionReceipt = { rpcCode: -32020, ...row.failureData };
    frame = {
      id: 2,
      error: { code: -32020, data: row.failureData, message: "rejected" },
    };
    observation.rejection = rejection;
  }
  const connection = {
    version: 1,
    agentId: "agent",
    connectionTraceID: identity.connectionTraceID,
    clientSpanID: identity.clientSpanID,
    raw_frames: [frame],
    requests: [
      { requestId: "2", method, sessionId: row.inputSessionID ?? undefined },
    ],
  };
  const project = () => {
    assert.equal(typeof implementation.projectWorkspaceRequest, "function");
    return implementation.projectWorkspaceRequest(connection, row, observation);
  };
  return { row, connection, observation, project };
}
for (const method of ["initialize", "session/new", "session/load"])
  test(`Workspace ${method} projection preserves original RPC fields`, () => {
    const f = fixture(method),
      before = structuredClone({ row: f.row, connection: f.connection });
    const expected = f.project();
    assert.equal(expected.kind, "request");
    if (method === "initialize")
      assert.equal(expected.requestReceipt, undefined);
    else
      assert.deepEqual(expected.requestReceipt, {
        requestId: "2",
        params: f.row.requestParams,
        result: f.row.requestResult,
      });
    assert.deepEqual({ row: f.row, connection: f.connection }, before);
  });
for (const method of ["initialize", "session/new", "session/load"])
  for (const [key, value] of Object.entries({
    rejectionReceipt: {
      rpcCode: -32020,
      code: "access_denied",
      retryable: false,
    },
    failureCode: -32020,
    failureData: { code: "access_denied", retryable: false },
  }))
    test(
      "successful " + method + " projection rejects contradictory " + key,
      () => {
        const f = fixture(method);
        f.row[key] = structuredClone(value);
        assert.throws(f.project);
      },
    );
for (const rejection of [
  "agent_busy",
  "runtime_barrier_required",
  "access_denied",
])
  test(`Workspace ${rejection} projects only its exact original wire rejection`, () => {
    const f = fixture("session/prompt", rejection),
      before = structuredClone(f.row);
    const expected = f.project();
    assert.equal(expected.outcome, "rejected");
    assert.equal(expected.rejection, rejection);
    assert.deepEqual(expected.rejectionReceipt, f.row.rejectionReceipt);
    assert.equal(expected.requestReceipt, undefined);
    assert.deepEqual(f.row, before);
  });
for (const phase of ["c4-cancel", "c4-offline"])
  test(`${phase} projection does not invent a wire reply or disconnect proof`, () => {
    const f = fixture("session/prompt");
    f.row.outcome = "failed";
    f.row.failure = "original local-close error";
    delete f.row.requestResult;
    f.connection.raw_frames = [];
    f.row.requestParams.prompt[0].text = phase;
    Object.assign(f.observation, {
      phase,
      kind: phase === "c4-cancel" ? "cancelled" : "ordinary",
      runId: "run",
      run: { run_id: "run" },
      runtime: {
        runtime_execution_id: "process",
        runtime_revision: "revision",
      },
    });
    const expected = f.project();
    assert.equal(expected.phase, phase);
    assert.equal(expected.closedBeforeResponse, undefined);
    assert.equal(expected.requestReceipt, undefined);
    assert.equal(expected.outcome, "failed");
  });
test("rebuilt Prompt retains the actual success response and read Tool annotation", () => {
  const f = fixture("session/prompt");
  f.row.requestResult = { stopReason: "end_turn" };
  f.connection.raw_frames[0].result = f.row.requestResult;
  Object.assign(f.observation, {
    phase: "c4-rebuilt",
    kind: "ordinary",
    toolName: "read",
  });
  const expected = f.project();
  assert.equal(expected.toolName, "read");
  assert.equal(expected.requestReceipt.result.stopReason, "end_turn");
});
for (const [name, change] of Object.entries({
  wrong_rpc_id: (f) => {
    f.observation.requestId = "foreign";
  },
  wrong_connection: (f) => {
    f.observation.connectionTraceID = "other";
  },
  overwritten_outcome: (f) => {
    f.observation.outcome = "succeeded";
  },
  assumed_disconnect: (f) => {
    f.observation.closedBeforeResponse = true;
  },
  missing_wire: (f) => {
    f.connection.raw_frames = [];
  },
  duplicate_wire: (f) => {
    f.connection.raw_frames.push(structuredClone(f.connection.raw_frames[0]));
  },
  conflicting_result: (f) => {
    f.connection.raw_frames[0].result = {};
  },
  wrong_error: (f) => {
    f.connection.raw_frames[0].error.data = {
      code: "agent_unavailable",
      retryable: false,
    };
  },
  retryable_error: (f) => {
    f.row.rejectionReceipt.retryable = true;
  },
  different_receipt: (f) => {
    f.row.rejectionReceipt.rpcCode = -32603;
  },
  invented_receipt: (f) => {
    f.observation.requestReceipt = {};
  },
  foreign_agent: (f) => {
    f.row.agentId = "other";
  },
}))
  test(`request projection rejects ${name}`, () => {
    const f = fixture("session/prompt", "access_denied");
    change(f);
    assert.throws(f.project);
  });
test("one malformed row does not stop independent row projection", () => {
  const broken = fixture("session/prompt", "access_denied"),
    good = fixture();
  broken.connection.raw_frames = [];
  const seen = [broken, good].map((f) => {
    try {
      return f.project();
    } catch (error) {
      return error;
    }
  });
  assert(seen[0] instanceof Error);
  assert.equal(seen[1].method, "session/load");
});
for (const [name, create] of Object.entries({
  wire_result: (canary) => {
    const f = fixture("session/load");
    f.connection.raw_frames[0].result = { private: canary };
    return f;
  },
  request_prompt: (canary) => {
    const f = fixture("session/prompt");
    f.row.requestParams.prompt[0].text = canary;
    Object.assign(f.observation, {
      phase: "c4-rebuilt",
      kind: "ordinary",
    });
    return f;
  },
  wire_rejection_code: (canary) => {
    const f = fixture("session/prompt", "access_denied");
    f.connection.raw_frames[0].error.data = {
      ...f.connection.raw_frames[0].error.data,
      code: canary,
    };
    return f;
  },
}))
  test(
    "projection keeps private " + name + " contents out of error diagnostics",
    () => {
      const canary = "workspace-projection-secret-canary";
      const f = create(canary);
      assert.throws(f.project, (error) => {
        assert(
          !inspect(error, { depth: 8 }).includes(canary),
          "Workspace projection exposed a private field in error diagnostics",
        );
        return true;
      });
    },
  );
