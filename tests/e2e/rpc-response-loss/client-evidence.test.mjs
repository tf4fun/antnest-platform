import assert from "node:assert/strict";
import test from "node:test";
import { replayRequest } from "../managed-mcp/protocol.mjs";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
const implementation = await import("./client-evidence.mjs").catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes("/rpc-response-loss/client-evidence.mjs")
  )
    throw error;
  return {};
});
const setup = { cwd: "/workspace", mcpServers: [] };
let identity = 0;
function controlledClient(version) {
  const n = ++identity;
  const initializationResult = {
    protocolVersion: version,
    _meta: { "antnest.dev/errors": { version: 1 } },
  };
  const c = {
    boundary: "private-acp",
    transport: "websocket",
    version,
    agentId: "agent",
    connectionTraceID: n.toString(16).padStart(32, "0"),
    clientSpanID: n.toString(16).padStart(16, "0"),
    initializationResult,
    requests: [{ requestId: "1", method: "initialize" }],
    rawFrames: [{ id: 1, result: structuredClone(initializationResult) }],
    updates: [],
    async request(method, params) {
      const id = c.requests.length + 1;
      c.requests.push({
        requestId: String(id),
        method: "session/" + method,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
      if (params.prompt?.[0]?.text.endsWith("-denied")) {
        const rejection = admissionErrorReceipt("agent_unavailable");
        const error = Object.assign(new Error(rejection.message), rejection);
        c.rawFrames.push({
          id,
          error: { code: error.code, message: error.message, data: error.data },
        });
        throw error;
      }
      const result =
        method === "new"
          ? { sessionId: "session-" + n }
          : method === "prompt" && version === 2
            ? { messageId: "message-" + n + "-" + id }
            : {};
      c.rawFrames.push({ id, result: structuredClone(result) });
      return result;
    },
    async closeAndWait() {},
  };
  return c;
}
async function inventory() {
  assert.equal(typeof implementation.createRpcLossRecorder, "function");
  const connections = [];
  for (const version of [1, 2])
    for (const kind of ["apply", "settle"]) {
      const label = `v${version}-${kind}`;
      let sessionId;
      for (const role of ["prompt", "replay-1", "replay-2"]) {
        const r = implementation.createRpcLossRecorder(
          controlledClient(version),
          { version, kind, role, agentId: "agent" },
          async () => {},
        );
        if (role === "prompt") {
          sessionId = (await r.request("new", setup)).sessionId;
          await r.request("prompt", {
            sessionId,
            prompt: [{ type: "text", text: label + "-write" }],
          });
          if (kind === "settle")
            await assert.rejects(
              r.request("prompt", {
                sessionId,
                prompt: [{ type: "text", text: label + "-denied" }],
              }),
              (e) => e.data.code === "agent_unavailable",
            );
        } else {
          const replay = replayRequest(version, sessionId);
          await r.request(replay.method, replay.params);
          if (role === "replay-2")
            await r.request("prompt", {
              sessionId,
              prompt: [{ type: "text", text: label + "-read" }],
            });
        }
        connections.push(await r.closeAndWait());
      }
    }
  return { agentId: "agent", connections };
}
function index(f) {
  assert.equal(typeof implementation.indexRpcLossRequests, "function");
  return implementation.indexRpcLossRequests(f);
}
test("four response-loss cases bind 12 initializations and 22 original requests", async () => {
  const f = await inventory(),
    before = structuredClone(f),
    result = index(f);
  assert.equal(result.initializations.length, 12);
  assert.equal(result.requests.length, 22);
  assert.equal(result.requests.filter((r) => r.kind === "ordinary").length, 8);
  assert.equal(
    result.requests.filter((r) => r.rejection === "agent_unavailable").length,
    2,
  );
  assert.equal(
    new Set([...result.initializations, ...result.requests].map((r) => r.label))
      .size,
    34,
  );
  assert.deepEqual(f, before);
});
for (const [name, mutate] of [
  ["missing connection", (f) => f.connections.pop()],
  [
    "unjoined connection",
    (f) => {
      f.connections[0].closed = false;
    },
  ],
  [
    "reused connection",
    (f) => {
      f.connections[1].connectionTraceID = f.connections[0].connectionTraceID;
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.connections[0].agentId = "foreign";
    },
  ],
  [
    "wrong role",
    (f) => {
      f.connections[0].role = "replay-1";
    },
  ],
  [
    "extra initialize",
    (f) =>
      f.connections[0].requests.push({ requestId: "99", method: "initialize" }),
  ],
  ["missing raw response", (f) => f.connections[0].raw_frames.pop()],
  [
    "wrong replay",
    (f) => {
      f.connections[1].evidence[0].requestParams.cwd = "/foreign";
    },
  ],
  [
    "wrong Session",
    (f) => {
      f.connections[0].evidence[1].sessionId = "foreign";
    },
  ],
  [
    "wrong original error",
    (f) => {
      f.connections[3].evidence[2].failureData.code = "agent_busy";
    },
  ],
  [
    "wrong raw error",
    (f) => {
      f.connections[3].raw_frames.at(-1).error.data.retryable = false;
    },
  ],
  ["missing raw rejection", (f) => f.connections[3].raw_frames.pop()],
  [
    "borrowed interruption",
    (f) => {
      f.connections[0].evidence[1].closedBeforeResponse = true;
    },
  ],
  [
    "invalid v2 ACK",
    (f) => {
      f.connections[6].evidence[1].requestResult.messageId = "";
    },
  ],
])
  test("RPC inventory rejects " + name, async () => {
    const f = await inventory();
    mutate(f);
    assert.throws(() => index(f));
  });
