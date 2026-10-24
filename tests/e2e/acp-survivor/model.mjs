import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const phases = new Set([
  "survivor-a-before",
  "survivor-b-before",
  "survivor-b-held",
  "survivor-b-after",
]);

export function createSurvivorModel() {
  const requests = [],
    errors = [];
  let held;
  return createServer(async (request, response) => {
    const receivedAt = Date.now();
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests, errors, held: held?.phase ?? null });
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer stage3-model-secret");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024);
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(payload.model, "stage3-model");
      assert(Array.isArray(payload.messages));
      const phase = payload.messages.findLast(
        (message) => message?.role === "user",
      )?.content;
      assert(phases.has(phase));
      assert(!requests.some((previous) => previous.phase === phase));
      const parent = request.headers.traceparent;
      const context =
        typeof parent === "string"
          ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-01$/u.exec(parent)
          : null;
      const traced =
        context !== null &&
        context[1] !== "0".repeat(32) &&
        context[2] !== "0".repeat(16);
      requests.push({
        phase,
        received_at_ms: receivedAt,
        ...(traced
          ? { trace_id: context[1], model_span_id: context[2] }
          : { trace_diagnostic: "missing_or_invalid_traceparent" }),
      });
      if (phase === "survivor-b-held") {
        assert.equal(held, undefined);
        held = { phase, response };
        response.once("close", () => {
          if (held?.response === response) held = undefined;
        });
        return;
      }
      reply(200, {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: `${phase} completed` },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    } catch {
      errors.push("survivor model request rejected");
      reply(400, { error: "survivor model request rejected" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createSurvivorModel().listen(8080, "0.0.0.0");
