import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const phases = new Set([
  "unpriced",
  "estimated",
  "reported",
  "zero",
  "cache",
  "pinned",
  "selected",
  "unpriced-again",
  "fresh-unknown",
  "fork",
  "post-restart",
  "restored-unpriced",
  "restored-fork",
  "free",
  "cache-fallback",
  "observer",
  "admission",
  "after-admission",
]);
const unpriced = new Set([
  "unpriced",
  "unpriced-again",
  "fresh-unknown",
  "restored-unpriced",
]);

export function decide(payload) {
  assert.equal(payload.stream, true);
  assert(
    !payload.messages.some((m) => m.role === "tool"),
    "unexpected Tool execution",
  );
  const phase = payload.messages.findLast((m) => m.role === "user")?.content;
  assert.match(phase ?? "", /^(v1-ws|v2-ws|v1-http):[a-z-]+$/);
  const action = phase.split(":")[1];
  assert(phases.has(action), "unknown cost scenario");
  assert.equal(
    payload.model,
    unpriced.has(action) ? "unknown-model" : "priced-model",
  );
  const usage = { prompt_tokens: 1000, completion_tokens: 100 };
  if (action === "reported") usage.cost = 0.01;
  if (action === "zero") usage.cost = 0;
  if (action === "observer") usage.cost = 0.77;
  if (["cache", "cache-fallback"].includes(action)) {
    usage.prompt_cache_hit_tokens = 200;
    usage.cache_creation_input_tokens = 100;
  }
  return { phase, model: payload.model, usage, text: `${phase} verified` };
}

export function encodeCompletion(result) {
  return (
    [
      {
        choices: [
          { index: 0, delta: { content: result.text }, finish_reason: null },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: result.usage,
      },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

export function createModelFixture() {
  const requests = [],
    errors = [];
  let checkpoint = "running",
    blocked;
  return createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return json(200, {
        requests,
        errors,
        checkpoint,
        blocked: blocked?.phase,
      });
    if (request.method === "POST" && request.url === "/release") {
      if (!blocked) return json(409, { error: "no held completion" });
      blocked.release();
      return json(200, { released: true });
    }
    if (
      request.method === "POST" &&
      ["/restart", "/restarted"].includes(request.url)
    ) {
      checkpoint = request.url.slice(1);
      return json(200, { checkpoint });
    }
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer cost-model-test");
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
        model: result.model,
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
      });
      const complete = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(encodeCompletion(result));
      };
      if (result.phase.endsWith(":admission")) {
        assert(!blocked, "overlapping held requests");
        const timer = setTimeout(() => {
          errors.push("held completion timed out");
          json(504, { error: "held completion timed out" });
        }, 30000);
        blocked = {
          phase: result.phase,
          release() {
            clearTimeout(timer);
            blocked = undefined;
            complete();
          },
        };
        response.once("close", () => {
          clearTimeout(timer);
          if (blocked?.phase === result.phase) blocked = undefined;
        });
      } else complete();
    } catch {
      errors.push("cost request contract violation");
      json(400, { error: "cost request contract violation" });
    }
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  createModelFixture().listen(8080, "0.0.0.0");
