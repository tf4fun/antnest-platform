import assert from "node:assert/strict";
import { createServer } from "node:http";
import { assertSessionEffects } from "./acp-session-effects.mjs";

export function decide(payload) {
  const index = payload.messages.findLastIndex((item) => item.role === "user");
  const phase = payload.messages[index]?.content;
  assert.match(phase, /^v[12]-(admitted|recovered)$/);
  const results = payload.messages
    .slice(index + 1)
    .filter((item) => item.role === "tool");
  assert(results.length <= 1, "duplicate Tool dispatch");
  if (results.length) {
    assertSessionEffects(results[0].content, phase);
    return { phase, text: `${phase} verified` };
  }
  assert(
    payload.tools.some((tool) => tool.function.name === "bash"),
    "Runtime bash missing",
  );
  return {
    phase,
    hold: phase.endsWith("admitted"),
    call: {
      name: "bash",
      arguments: {
        command: `printf '%s\\n' '${phase}' >> /workspace/session-effects.log; cat /workspace/session-effects.log`,
        working_dir: ".",
        timeout_ms: 10000,
      },
    },
  };
}

function completion(result) {
  return {
    choices: [
      {
        finish_reason: result.call ? "tool_calls" : "stop",
        message: result.call
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `${result.phase}-tool`,
                  type: "function",
                  function: {
                    name: result.call.name,
                    arguments: JSON.stringify(result.call.arguments),
                  },
                },
              ],
            }
          : { role: "assistant", content: result.text },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

export function createSessionModel() {
  const requests = [],
    errors = [],
    held = new Map();
  const reply = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/status")
      return reply(response, 200, { requests, errors, held: [...held.keys()] });
    if (request.method === "POST" && request.url.startsWith("/release/")) {
      const phase = request.url.slice("/release/".length);
      const pending = held.get(phase);
      if (!pending) return reply(response, 409, { error: "no held request" });
      held.delete(phase);
      reply(pending.response, 200, completion(pending.result));
      return reply(response, 200, { released: phase });
    }
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(
        request.headers.authorization,
        "Bearer acp-session-private-key",
      );
      assert.match(
        request.headers.traceparent ?? "",
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024, "fixture body too large");
        chunks.push(chunk);
      }
      const result = decide(JSON.parse(Buffer.concat(chunks).toString()));
      const stage = result.call ? "tool" : "reply";
      assert(
        !requests.some(
          (item) => item.phase === result.phase && item.stage === stage,
        ),
        "model request replayed",
      );
      requests.push({
        phase: result.phase,
        stage,
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
      });
      if (result.hold) {
        held.set(result.phase, { response, result });
        response.once("close", () => {
          if (held.delete(result.phase))
            errors.push("held model request abandoned");
        });
        return;
      }
      reply(response, 200, completion(result));
    } catch {
      errors.push("fixture request rejected");
      reply(response, 400, { error: "fixture request rejected" });
    }
  });
}

if (process.argv[1]?.endsWith("/acp-session-model.mjs"))
  createSessionModel().listen(8080, "0.0.0.0");
