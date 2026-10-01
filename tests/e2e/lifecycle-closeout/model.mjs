import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export function decide(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex((m) => m.role === "user");
  const phase = payload.messages[index]?.content;
  assert(
    ["c3-held-run", "c3-after-rebuild"].includes(phase),
    "unexpected lifecycle prompt",
  );
  const system = payload.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  assert(
    system.includes(
      phase === "c3-held-run"
        ? "Synthetic lifecycle test"
        : "Revised immutable fixture",
    ),
    "wrong configuration revision",
  );
  if (phase === "c3-after-rebuild")
    assert(
      JSON.stringify(payload.messages).includes(
        "isolated execution environment was rebuilt",
      ),
      "environment change notice missing",
    );
  const results = payload.messages
    .slice(index + 1)
    .filter((m) => m.role === "tool");
  assert(results.length <= 1, "duplicate tool dispatch");
  if (results.length) {
    if (phase === "c3-held-run")
      assert(
        results[0].content.includes("c3-held-complete"),
        "held tool did not complete",
      );
    else
      assert.equal(
        JSON.parse(results[0].content).content,
        "held\nfinished\n",
        "workspace effect lost or repeated",
      );
    return { phase, text: `${phase} completed` };
  }
  const call =
    phase === "c3-held-run"
      ? {
          name: "bash",
          arguments: {
            command:
              "printf 'held\\n' >> /workspace/.c3-run-effects\nprintf '%s' \"$$\" > /workspace/.c3-run-started\nwhile [ ! -e /workspace/.c3-run-release ]; do sleep 0.1; done\nprintf 'finished\\n' >> /workspace/.c3-run-effects\nprintf 'c3-held-complete\\n'",
            working_dir: ".",
            timeout_ms: 120000,
          },
        }
      : {
          name: "read",
          arguments: {
            path: ".c3-run-effects",
            offset: 1,
            limit: 4096,
          },
        };
  assert(
    payload.tools.some((t) => t.function.name === call.name),
    "Runtime tool not advertised",
  );
  return { phase, call };
}

export function createLifecycleModel(decision = decide) {
  const requests = [],
    errors = [];
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
      assert.equal(request.headers.authorization, "Bearer stage3-model-secret");
      const parent = request.headers.traceparent ?? "";
      assert.match(parent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024);
        chunks.push(chunk);
      }
      const result = decision(JSON.parse(Buffer.concat(chunks).toString()));
      const stage = result.call ? "tool" : "reply";
      assert(
        !requests.some((r) => r.phase === result.phase && r.stage === stage),
        "model execution repeated",
      );
      requests.push({
        phase: result.phase,
        stage,
        trace_id: parent.split("-")[1],
        model_span_id: parent.split("-")[2],
        ...(result.report ? { report: result.report } : {}),
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
      errors.push("lifecycle model request rejected");
      reply(400, { error: "lifecycle model request rejected" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createLifecycleModel().listen(8080, "0.0.0.0");
