import assert from "node:assert/strict";
import { createServer } from "node:http";

export function decide(payload) {
  const user = payload.messages.findLastIndex((item) => item.role === "user");
  const phase = payload.messages[user]?.content;
  assert.match(
    phase,
    /^v[12]-(baseline|model-blocked|tool-blocked|tool-inflight|recovered-effect|after-restart-[123]|read-effects)$/,
  );
  const results = payload.messages
    .slice(user + 1)
    .filter((item) => item.role === "tool");
  assert(results.length <= 1, "duplicate Tool dispatch");
  if (phase.endsWith("tool-inflight") || phase.endsWith("recovered-effect"))
    return uncertainEffect(payload, phase, results);
  if (phase.endsWith("model-blocked")) return { phase, hold: true };
  if (phase.includes("after-restart"))
    return { phase, text: `${phase} verified` };
  if (results.length === 1) {
    if (phase.endsWith("read-effects")) {
      for (const marker of [
        `${phase.slice(0, 2)}-baseline`,
        `${phase.slice(0, 2)}-tool-blocked`,
      ])
        assert(results[0].content.includes(marker), "effect log not read");
    } else assert(results[0].content.includes(phase), "Tool effect missing");
    return phase.endsWith("tool-blocked")
      ? { phase, hold: true }
      : { phase, text: `${phase} verified` };
  }
  const call = phase.endsWith("read-effects")
    ? {
        name: "read",
        arguments: {
          path: "acp-effects.log",
          offset: 1,
          limit: 4096,
        },
      }
    : {
        name: "bash",
        arguments: {
          command: `printf '%s\\n' '${phase}' >> /workspace/acp-effects.log; cat /workspace/acp-effects.log`,
          working_dir: ".",
          timeout_ms: 10000,
        },
      };
  assert(
    payload.tools.some((tool) => tool.function.name === call.name),
    "Runtime Tool missing",
  );
  return { phase, call };
}

function uncertainEffect(payload, phase, results) {
  const version = phase.slice(0, 2);
  const path = `acp-unknown-${version}`;
  const inFlight = phase.endsWith("tool-inflight");
  if (inFlight)
    assert.equal(results.length, 0, "in-flight Tool completed before fault");
  if (results.length) {
    const result = JSON.parse(results[0].content);
    assert.equal(
      result.content,
      `${version}-tool-inflight\n`,
      "lost or repeated physical effect",
    );
    return { phase, text: `${phase} verified` };
  }
  const call = inFlight
    ? {
        name: "bash",
        arguments: {
          command: `printf '%s\\n' '${phase}' >> /workspace/${path}.log\nprintf '%s\\n' "$$" > /workspace/${path}.pid\nwhile [ ! -e /workspace/${path}.release ]; do sleep 1; done\nprintf 'unexpected completion\\n'`,
          working_dir: ".",
          timeout_ms: 120000,
        },
      }
    : {
        name: "read",
        arguments: {
          path: `${path}.log`,
          offset: 1,
          limit: 4096,
        },
      };
  assert(
    payload.tools.some((tool) => tool.function.name === call.name),
    "Runtime Tool missing",
  );
  return { phase, call };
}

export function startModel(decision = decide) {
  const requests = [];
  const errors = [];
  return createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests, errors });
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer acp-closeout-model");
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
      const result = decision(JSON.parse(Buffer.concat(chunks).toString()));
      const stage = result.call ? "tool" : result.hold ? "held" : "reply";
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
      if (result.hold) return; // Host SIGKILL is released only after this recorded barrier.
      reply(200, {
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
      });
    } catch (error) {
      errors.push(error.message);
      console.error(
        JSON.stringify({ event: "fixture_rejected", error: error.message }),
      );
      reply(400, { error: error.message });
    }
  }).listen(8080, "0.0.0.0");
}
if (process.argv[1]?.endsWith("/model.mjs")) startModel();
