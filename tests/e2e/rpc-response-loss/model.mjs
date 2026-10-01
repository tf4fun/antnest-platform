import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
export function decide(payload) {
  const user = payload.messages.findLastIndex((m) => m.role === "user"),
    phase = payload.messages[user]?.content;
  const match = /^v([12])-(apply|settle)-(write|read)$/.exec(phase);
  assert(match, "unexpected RPC scenario");
  assert.equal(payload.model, "rpc-model");
  assert.equal(
    payload.max_tokens,
    match[1] === "1" ? 3072 : 4096,
    "current Model parameters missing",
  );
  const marker = `v${match[1]}-${match[2]}`,
    results = payload.messages.slice(user + 1).filter((m) => m.role === "tool");
  assert(results.length <= 1, "duplicate Tool dispatch");
  if (results.length) {
    const result = JSON.parse(results[0].content);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.truncated, false);
    assert.equal(result.effect_state, "settled");
    assert.equal(
      result.stdout,
      marker + "\n",
      "lost or duplicated physical effect",
    );
    return { phase, text: phase + " verified" };
  }
  assert(payload.tools.some((t) => t.function.name === "bash"));
  return {
    phase,
    call: {
      name: "bash",
      arguments: {
        command:
          (match[3] === "write"
            ? `printf '%s\\n' '${marker}' >> /workspace/${marker}.log; `
            : "") + `cat /workspace/${marker}.log`,
        working_dir: ".",
        timeout_ms: 10000,
      },
    },
  };
}
export function modelServer() {
  const requests = [],
    errors = [];
  return createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && req.url === "/status")
      return reply(200, { requests, errors });
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer rpc-fixture-key");
      assert.match(
        req.headers.traceparent ?? "",
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
      );
      const chunks = [];
      let size = 0;
      for await (const b of req) {
        size += b.length;
        assert(size <= 1024 * 1024);
        chunks.push(b);
      }
      const result = decide(JSON.parse(Buffer.concat(chunks))),
        stage = result.call ? "tool" : "reply";
      assert(
        !requests.some((r) => r.phase === result.phase && r.stage === stage),
        "replayed Provider request",
      );
      requests.push({
        phase: result.phase,
        stage,
        trace_id: req.headers.traceparent.split("-")[1],
        model_span_id: req.headers.traceparent.split("-")[2],
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
                      id: result.phase + "-tool",
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
      errors.push("invalid_model_request");
      reply(400, { error: "invalid_model_request" });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  modelServer().listen(8080, "0.0.0.0");
