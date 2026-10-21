import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { encodeCompletion } from "../acp-progress/model.mjs";

export const contentMarker = "F03_PRIVATE_FILE_PREFIX";
const relative = 'reports /记录".txt';
const before = `${contentMarker}\nold middle\ntail\n`;
const after = `${contentMarker}\nnew middle\ntail\n`;
const success = (result) => ({
  ...result,
  effect_state: "settled",
  effect_source: null,
});
const write = (id, name, oldText, newText, withDiff = true) => ({
  id,
  tool: "write",
  path: `/workspace/${name}`,
  args: { path: name, content: newText },
  result: success({ bytes_written: Buffer.byteLength(newText) }),
  ...(withDiff ? { change: { before: oldText, after: newText } } : {}),
});
const edit = (id, oldString, newString, changed = true) => ({
  id,
  tool: "edit",
  path: `/workspace/${relative}`,
  args: { path: relative, old_string: oldString, new_string: newString },
  result: success({ bytes_written: Buffer.byteLength(after) }),
  ...(changed ? { change: { before, after } } : {}),
});
export const cases = [
  write("create", relative, null, before),
  edit("edit", "old middle", "new middle"),
  {
    id: "read",
    tool: "read",
    path: `/workspace/${relative}`,
    args: { path: relative, offset: 1, limit: 4096 },
    result: success({ content: after, truncated: false, next_offset: null }),
  },
  write("empty-create", "empty.txt", null, ""),
  write("empty-replace", "empty.txt", "", "replaced empty\n"),
  edit("unchanged", "new middle", "new middle", false),
  write("large-write", "large.txt", null, "x".repeat(40000), false),
  {
    ...edit("failed-edit", "missing middle", "must not write", false),
    error: true,
    result: {
      error_code: "old_string_not_found",
      message: "the file was not changed",
      effect_state: "none",
      effect_source: null,
    },
  },
];

export function caseFor(phase) {
  assert.match(phase ?? "", /^v[12]-/);
  const item = cases.find((value) => value.id === phase.slice(3));
  assert(item, "unknown file case");
  return item;
}

export function decide(payload) {
  assert.equal(payload.stream, true);
  const last = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[last]?.content;
  const item = caseFor(phase);
  if (item.id !== "create" && item.id !== "read")
    assert(
      !JSON.stringify(payload.messages).includes(contentMarker),
      "full file context polluted model messages",
    );
  assert(
    payload.tools.some((tool) => tool.function.name === item.tool),
    "actual Runtime tool missing",
  );
  const results = payload.messages
    .slice(last + 1)
    .filter((message) => message.role === "tool");
  assert(results.length <= 1, "tool was redispatched");
  if (results.length === 0)
    return { phase, call: { name: item.tool, arguments: item.args } };
  const content = results[0].content;
  for (const key of [
    "io.antnest.runtime/file",
    "fileJson",
    '"oldText"',
    '"newText"',
  ])
    assert(!content.includes(key), "file metadata polluted model result");
  const result = JSON.parse(content.slice(content.indexOf("{")));
  for (const [key, value] of Object.entries(item.result))
    assert.deepEqual(result[key], value, `incorrect tool result: ${key}`);
  if (item.tool !== "read")
    assert(
      !content.includes(contentMarker),
      "full file metadata polluted model result",
    );
  return { phase, text: `${phase} verified` };
}

// Archive the actual model input, not a reconstruction from the case oracle.
// This stays in private evidence and never enters telemetry or public stdout.
export function observeFileModelRequest(payload) {
  const decision = decide(payload);
  if (decision.call) return decision;
  const last = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const messages = payload.messages.slice(last + 1);
  const calls = messages.flatMap((message, index) =>
    message.role === "assistant"
      ? (message.tool_calls ?? []).map((call) => ({ call, index }))
      : [],
  );
  assert.equal(calls.length, 1, "one actual file Tool call required");
  const results = messages.flatMap((message, index) =>
    message.role === "tool" ? [{ message, index }] : [],
  );
  assert.equal(results.length, 1, "one actual file Tool result required");
  const { call, index } = calls[0];
  const result = results[0];
  const item = caseFor(decision.phase);
  assert(index < result.index, "file result preceded its actual call");
  // ACP scopes the provider ID to the owning Run and model request. The trace
  // inspector independently verifies that derivation against the actual Run.
  assert.match(
    call.id ?? "",
    /^[a-f0-9]{64}$/u,
    "unnormalized file model Tool ID",
  );
  assert.equal(
    result.message.tool_call_id,
    call.id,
    "foreign file model result ID",
  );
  assert.equal(call.type, "function");
  assert.equal(call.function.name, item.tool);
  assert.deepEqual(JSON.parse(call.function.arguments), item.args);
  const content = result.message.content;
  return {
    ...decision,
    tool_result: {
      tool_call_id: result.message.tool_call_id,
      tool: call.function.name,
      result: JSON.parse(content.slice(content.indexOf("{"))),
    },
  };
}

export function createModelServer() {
  const requests = [];
  const errors = [];
  return createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return json(200, { requests, errors });
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer file-model-test");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024);
        chunks.push(chunk);
      }
      const result = observeFileModelRequest(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      const stage = result.call ? "tool" : "final";
      assert(
        !requests.some(
          (item) => item.phase === result.phase && item.stage === stage,
        ),
        "duplicate model request",
      );
      const parent = request.headers.traceparent;
      const trace =
        typeof parent === "string"
          ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-(?:00|01)$/u.exec(parent)
          : null;
      const traced =
        trace !== null &&
        trace[1] !== "0".repeat(32) &&
        trace[2] !== "0".repeat(16);
      requests.push({
        phase: result.phase,
        stage,
        traceparent: parent,
        ...(traced
          ? {
              trace_id: trace[1],
              model_span_id: trace[2],
            }
          : { trace_diagnostic: "traceparent_unavailable" }),
        ...(result.tool_result ? { tool_result: result.tool_result } : {}),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(encodeCompletion(result));
    } catch (error) {
      errors.push(error.message);
      json(400, { error: error.message });
    }
  });
}
function start() {
  return createModelServer().listen(8080, "0.0.0.0");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  start();
