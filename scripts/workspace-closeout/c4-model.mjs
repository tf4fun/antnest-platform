import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { decide as basicDecision, note } from "./browser-model.mjs";

const held = new Set([
  "c4-browser-hold-cancel",
  "c4-browser-hold-offline",
  "c4-browser-hold-close",
]);
export function decide(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex((m) => m.role === "user");
  const content = payload.messages[index]?.content;
  const phase = Array.isArray(content) ? content[0]?.text : content;
  const tail = payload.messages.slice(index + 1);
  if (held.has(phase) || phase === "c4-browser-after-cancel") {
    assert.equal(tail.length, 0);
    return { phase, hold: held.has(phase), text: `${phase} completed` };
  }
  if (["c4-browser-approve", "c4-browser-after-rebuild"].includes(phase)) {
    if (phase === "c4-browser-after-rebuild")
      assert(
        JSON.stringify(payload.messages).includes(
          "isolated execution environment was rebuilt",
        ),
      );
    const call = {
      name: "read",
      arguments: {
        path: { root: "workspace", path: ".c4-browser-note" },
        offset: 0,
        limit: 4096,
      },
    };
    assert(payload.tools.some((tool) => tool.function.name === call.name));
    if (!tail.length) return { phase, call };
    assert.equal(tail.length, 2);
    assert.equal(tail[0].role, "assistant");
    const callID = tail[0].tool_calls?.[0]?.id;
    assert.match(callID ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(tail[0].tool_calls, [
      {
        id: callID,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      },
    ]);
    assert.equal(tail[1].role, "tool");
    assert.equal(tail[1].tool_call_id, callID);
    const result = JSON.parse(tail[1].content);
    assert.equal(result.content, note);
    assert.equal(result.effect_state, "settled");
    return { phase, text: `${phase}: retained note alpha-beta verified.` };
  }
  return basicDecision(payload);
}

export function createC4Model() {
  const requests = [],
    errors = [],
    pending = new Map();
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests, errors, pending: [...pending.keys()] });
    if (request.method === "POST" && request.url.startsWith("/release/")) {
      const release = pending.get(request.url.slice("/release/".length));
      if (!release) return reply(404, { error: "phase not pending" });
      release();
      return reply(200, { released: true });
    }
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
      const result = decide(JSON.parse(Buffer.concat(chunks).toString()));
      const stage = result.call ? "tool" : "reply";
      assert(
        !requests.some((r) => r.phase === result.phase && r.stage === stage),
        "model execution repeated",
      );
      const record = {
        phase: result.phase,
        stage,
        trace_id: parent.split("-")[1],
        model_span_id: parent.split("-")[2],
      };
      requests.push(record);
      const finish = () => {
        pending.delete(result.phase);
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
      };
      if (result.hold) {
        pending.set(result.phase, finish);
        response.once("close", () => {
          if (pending.delete(result.phase)) record.disconnected = true;
        });
      } else finish();
    } catch (error) {
      // This disposable fixture receives only synthetic browser prompts and
      // workspace data; retain assertion diagnostics, never request headers.
      errors.push(
        error instanceof assert.AssertionError
          ? error.message
          : "C4 model request rejected",
      );
      reply(400, { error: "C4 model request rejected" });
    }
  });
  server.once("close", () => pending.clear());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createC4Model().listen(8080, "0.0.0.0");
