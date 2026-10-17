import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { capacityDecision } from "./upload-capacity-workload.mjs";

export function createCapacityModel() {
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
      assert.equal(request.headers.authorization, "Bearer stage3-model-secret");
      const parent = request.headers.traceparent ?? "";
      assert.match(parent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes <= 24 * 1024 * 1024);
        chunks.push(chunk);
      }
      const decision = capacityDecision(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      assert(
        !requests.some((r) => r.phase === decision.phase),
        "phase executed more than once",
      );
      const stage = decision.call ? "tool" : "reply";
      requests.push({
        phase: decision.phase,
        stage,
        trace_id: parent.split("-")[1],
        model_span_id: parent.split("-")[2],
        request_bytes: bytes,
        ...decision.report,
      });
      reply(200, {
        choices: [
          {
            finish_reason: decision.call ? "tool_calls" : "stop",
            message: decision.call
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: decision.phase + "-tool",
                      type: "function",
                      function: {
                        name: decision.call.name,
                        arguments: JSON.stringify(decision.call.arguments),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: decision.text },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    } catch (error) {
      errors.push({ name: error.name, message: error.message.slice(0, 500) });
      reply(400, { error: "capacity model request rejected" });
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  createCapacityModel().listen(8080, "0.0.0.0");
