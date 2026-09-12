import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { encodeCompletion } from "../acp-progress/model.mjs";

export const marker = "F04_PRIVATE_PLAN";
export const first = [
  { content: `${marker}: 准备记录`, priority: "high", status: "in_progress" },
  { content: "校验结果", priority: "low", status: "pending" },
  { content: "可移除步骤", priority: "medium", status: "pending" },
];
export const updated = [
  { content: "校验结果", priority: "medium", status: "in_progress" },
  { content: `${marker}: 准备记录`, priority: "low", status: "completed" },
];
export const phases = [
  { id: "create", before: undefined, plans: [first], remote: 0 },
  { id: "execute", before: first, plans: [updated], remote: 1 },
  { id: "invalid", before: updated, plans: [], remote: 0 },
  { id: "clear", before: updated, plans: [[]], remote: 0 },
  { id: "recall", before: [], plans: [], remote: 0 },
  { id: "fork", before: updated, plans: [], remote: 0 },
];
export function caseFor(phase) {
  assert.match(phase ?? "", /^v[12]-/);
  const item = phases.find((item) => item.id === phase.slice(3));
  assert(item, "unknown plan case");
  return item;
}
export function stepsFor(phase) {
  const item = caseFor(phase);
  const plan = (entries) => ({
    name: "update_plan",
    arguments: { entries },
    result: "Plan updated.",
  });
  switch (item.id) {
    case "create":
      return [plan(first)];
    case "clear":
      return [plan([])];
    case "invalid":
      return [
        {
          ...plan([{ content: "invalid", priority: "high", status: "failed" }]),
          result: "Tool arguments do not match the declared schema:",
        },
      ];
    case "execute": {
      const content = `${phase} runtime result\n`;
      return [
        {
          name: "write",
          arguments: {
            path: { root: "workspace", path: `${phase}.txt` },
            content,
          },
          result: JSON.stringify({
            bytes_written: Buffer.byteLength(content),
            effect_state: "settled",
            effect_source: null,
          }),
        },
        plan(updated),
      ];
    }
    default:
      return [];
  }
}

export function decide(payload) {
  assert.equal(payload.stream, true);
  const last = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[last]?.content;
  const item = caseFor(phase);
  const snapshots = payload.messages.filter(
    (message) =>
      typeof message.content === "string" &&
      message.content.startsWith("Conversation plan at Run start"),
  );
  assert.equal(
    snapshots.length,
    item.before === undefined ? 0 : 1,
    "Run-start plan snapshot missing or duplicated",
  );
  if (item.before !== undefined) {
    assert.equal(
      snapshots[0].role,
      "assistant",
      "plan snapshot became system authority",
    );
    assert.deepEqual(
      JSON.parse(snapshots[0].content.split("\n").slice(1).join("\n")),
      item.before,
      "stale plan snapshot",
    );
  }
  assert(
    !payload.messages.some(
      (message) =>
        message.role === "system" && message.content.includes(marker),
    ),
    "plan leaked into system instructions",
  );
  for (const name of ["write", "update_plan"])
    assert(
      payload.tools.some((tool) => tool.function.name === name),
      "required tool missing",
    );
  const steps = stepsFor(phase);
  const tail = payload.messages.slice(last + 1);
  const calls = tail.flatMap((message) => message.tool_calls ?? []);
  const results = tail.filter((message) => message.role === "tool");
  // This fixture emits exactly one call per model response.
  assert.equal(tail.length, results.length * 2, "unpaired fixture messages");
  for (let index = 0; index < tail.length; index += 2) {
    assert.equal(tail[index].role, "assistant", "call/result order is invalid");
    assert.equal(tail[index].tool_calls?.length, 1, "unpaired fixture call");
    assert.equal(tail[index + 1].role, "tool", "call/result order is invalid");
  }
  assert.equal(calls.length, results.length, "unpaired model tool result");
  assert(results.length <= steps.length, "tool redispatched");
  for (const [index, result] of results.entries()) {
    const step = steps[index];
    assert.equal(
      result.tool_call_id,
      calls[index].id,
      "tool result identity mismatch",
    );
    assert.equal(calls[index].function.name, step.name);
    assert.deepEqual(
      JSON.parse(calls[index].function.arguments),
      step.arguments,
    );
    if (step.name === "write") {
      const actual = JSON.parse(
        result.content.slice(result.content.indexOf("{")),
      );
      const expected = JSON.parse(step.result);
      for (const [key, value] of Object.entries(expected))
        assert.deepEqual(
          actual[key],
          value,
          `incorrect Runtime result: ${key}`,
        );
    } else if (item.id === "invalid")
      assert(
        result.content.startsWith(step.result),
        "invalid plan was accepted",
      );
    else assert.equal(result.content, step.result, "plan result missing");
  }
  const step = steps[results.length];
  return {
    phase,
    stage: results.length,
    ...(step
      ? { call: { name: step.name, arguments: step.arguments } }
      : { text: `${phase} verified`, gated: item.plans.length > 0 }),
  };
}

function start() {
  const requests = [],
    errors = [],
    released = new Set(),
    waiting = new Map();
  function waitForRelease(phase) {
    if (released.has(phase)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(phase);
        reject(new Error(`model gate timed out: ${phase}`));
      }, 30000);
      waiting.set(phase, () => {
        clearTimeout(timer);
        waiting.delete(phase);
        resolve();
      });
    });
  }
  return createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return json(200, { requests, errors });
    try {
      if (request.method === "POST" && request.url.startsWith("/release/")) {
        const phase = request.url.slice(9);
        assert(caseFor(phase).plans.length > 0);
        assert(!released.has(phase), "duplicate gate release");
        released.add(phase);
        waiting.get(phase)?.();
        return json(200, { released: true });
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer plan-model-test");
      assert.match(
        request.headers.traceparent ?? "",
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024);
        chunks.push(chunk);
      }
      const result = decide(JSON.parse(Buffer.concat(chunks).toString()));
      assert(
        !requests.some(
          (item) => item.phase === result.phase && item.stage === result.stage,
        ),
        "duplicate model request",
      );
      requests.push({
        phase: result.phase,
        stage: result.stage,
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
      });
      if (result.gated) await waitForRelease(result.phase);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(encodeCompletion(result));
    } catch {
      errors.push("plan fixture validation failed");
      json(400, { error: "plan fixture validation failed" });
    }
  }).listen(8080, "0.0.0.0");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  start();
