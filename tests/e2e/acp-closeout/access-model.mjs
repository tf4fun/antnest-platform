import assert from "node:assert/strict";
import { createServer } from "node:http";

export function decideAccess(payload) {
  assert.equal(payload.model, "closeout-access");
  const index = payload.messages.findLastIndex((m) => m.role === "user");
  const phase = payload.messages[index]?.content;
  assert.match(phase, /^v[12]-(owner|peer|foreign|restored)$/);
  assert(
    payload.messages.slice(0, index).every((m) => m.role === "system"),
    "fresh Session contains prior conversation",
  );
  for (const version of [1, 2])
    for (const scope of ["owner", "peer", "foreign", "restored"])
      if (`v${version}-${scope}` !== phase)
        assert(
          !JSON.stringify(payload.messages).includes(
            `Private history v${version}-${scope}`,
          ),
          "foreign history in model context",
        );
  const results = payload.messages
    .slice(index + 1)
    .filter((m) => m.role === "tool");
  assert(results.length <= 1, "duplicate Tool dispatch");
  if (results.length) {
    const result = JSON.parse(results[0].content);
    assert.equal(result.effect_state, "settled");
    assert.equal(result.exit_code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.truncated, false);
    assert.equal(
      result.stdout,
      `${phase}\n`,
      "missing, repeated or foreign physical effect",
    );
    return { phase, text: `Private history ${phase}` };
  }
  assert(payload.tools.some((t) => t.function.name === "bash"));
  return {
    phase,
    call: {
      name: "bash",
      arguments: {
        command: `printf '%s\\n' '${phase}' >> /workspace/${phase}.log; cat /workspace/${phase}.log`,
        working_dir: ".",
        timeout_ms: 10000,
      },
    },
  };
}

export function createCloseoutAccessModel() {
  const requests = [],
    errors = [];
  return createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests, errors });
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(
        request.headers.authorization,
        "Bearer closeout-access-private-key",
      );
      const parent = request.headers.traceparent;
      assert.match(parent ?? "", /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024);
        chunks.push(chunk);
      }
      const result = decideAccess(JSON.parse(Buffer.concat(chunks).toString()));
      const stage = result.call ? "tool" : "reply";
      assert(
        !requests.some((r) => r.phase === result.phase && r.stage === stage),
        "replayed model request",
      );
      requests.push({
        phase: result.phase,
        stage,
        trace_id: parent.split("-")[1],
        model_span_id: parent.split("-")[2],
      });
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
    } catch {
      errors.push("fixture request rejected");
      reply(400, { error: "fixture request rejected" });
    }
  });
}
if (process.argv[1]?.endsWith("/access-model.mjs"))
  createCloseoutAccessModel().listen(8080, "0.0.0.0");
