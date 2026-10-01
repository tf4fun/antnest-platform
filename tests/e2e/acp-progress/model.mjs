import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function decide(payload) {
  assert.equal(payload.stream, true);
  assert(
    !JSON.stringify(payload.messages).includes("progress-payload-canary"),
    "progress polluted messages",
  );
  const last = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[last]?.content;
  assert.match(phase ?? "", /^v[12]-(bash|managed)-(success|failure|cancel)$/);
  const [, source, ending] = phase.split("-");
  const results = payload.messages
    .slice(last + 1)
    .filter((message) => message.role === "tool");
  assert(results.length <= 1, "tool was redispatched");
  const name = source === "bash" ? "bash" : "mcp__fixture__progress";
  assert(
    payload.tools.some((tool) => tool.function.name === name),
    "actual Runtime tool missing",
  );
  if (results.length) {
    assert.notEqual(ending, "cancel", "model continued after cancellation");
    const content = results[0].content;
    assert(
      !content.includes("progress-payload-canary"),
      "progress polluted model context",
    );
    if (source === "managed") {
      assert(
        content.includes(ending === "failure" ? "controlled failure" : "done"),
      );
    } else {
      assert(content.includes(`${phase}-partial`));
      assert(content.includes(`${phase}-tail`));
      const result = JSON.parse(content.slice(content.indexOf("{")));
      assert.equal(result.exit_code, ending === "failure" ? 7 : 0);
    }
    return { phase, text: `${phase} verified` };
  }
  const gate = `/workspace/${phase}`;
  return {
    phase,
    call: {
      name,
      arguments:
        source === "managed"
          ? { gate, fail: ending === "failure" }
          : {
              command: `echo $$ > ${gate}-pid; printf '${phase}-partial\\n'; while [ ! -f ${gate}-release ]; do sleep 0.1; done; printf '${phase}-tail\\n' >&2; exit ${ending === "failure" ? 7 : 0}`,
              working_dir: ".",
              timeout_ms: 120000,
            },
    },
  };
}

export function encodeCompletion(result) {
  const delta = result.call
    ? {
        tool_calls: [
          {
            index: 0,
            id: result.phase,
            type: "function",
            function: {
              name: result.call.name,
              arguments: JSON.stringify(result.call.arguments),
            },
          },
        ],
      }
    : { content: result.text };
  return (
    [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: result.call ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

function start() {
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
      assert.equal(request.headers.authorization, "Bearer progress-model-test");
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
      requests.push({
        phase: result.phase,
        stage: result.call ? "tool" : "final",
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(encodeCompletion(result));
    } catch (error) {
      errors.push(error.message);
      json(400, { error: error.message });
    }
  }).listen(8080, "0.0.0.0");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  start();
