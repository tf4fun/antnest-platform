import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { encodeCompletion } from "../acp-progress/model.mjs";

export function decide(payload) {
  if (
    payload.messages[0]?.content?.startsWith(
      "Classify one tool call as strictly read-only.",
    )
  ) {
    const call = JSON.parse(payload.messages[1].content);
    return {
      phase: call.arguments.value,
      stage: "judge",
      text: JSON.stringify({
        request_id: call.request_id,
        read_only: call.arguments.value.endsWith("judge-safe"),
      }),
    };
  }
  const last = payload.messages.findLastIndex((item) => item.role === "user");
  const phase = payload.messages[last]?.content;
  assert.match(phase, /^(v[12]-|browser-)/);
  const results = payload.messages
    .slice(last + 1)
    .filter((item) => item.role === "tool");
  if (phase.endsWith("chat")) {
    assert(!payload.tools?.length);
    return { phase, stage: 0, text: `${phase} verified` };
  }
  if (results.length) {
    assert.equal(results.length, 1);
    const denied = /deny|reject/.test(phase);
    assert.equal(
      /Tool was not executed:|disabled by the Session authorization policy/.test(
        results[0].content,
      ),
      denied,
      "incorrect approval effect",
    );
    if (!denied && !phase.includes("judge") && !phase.endsWith("read-hint"))
      assert(
        results[0].content.includes("bytes_written"),
        "missing Runtime write result",
      );
    if (!denied && phase.includes("judge"))
      assert(results[0].content.includes(phase), "missing managed Tool result");
    if (phase.endsWith("read-hint")) {
      const result = JSON.parse(results[0].content);
      assert.equal(result.content, `${phase.slice(0, 2)}-once\n`);
    }
    return { phase, stage: 1, text: `${phase} verified` };
  }
  if (phase.includes("judge"))
    return {
      phase,
      stage: 0,
      call: { name: "mcp__fixture__echo", arguments: { value: phase } },
    };
  if (phase.endsWith("read-hint"))
    return {
      phase,
      stage: 0,
      call: {
        name: "read",
        arguments: {
          path: `${phase.slice(0, 2)}-once.txt`,
          limit: 1024,
        },
      },
    };
  return {
    phase,
    stage: 0,
    call: {
      name: "write",
      arguments: {
        path: `${phase}.txt`,
        content: `${phase}\n`,
      },
    },
  };
}

function start() {
  const requests = [],
    errors = [];
  let browserReleased = false;
  createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/status")
      return json(200, { requests, errors, browserReleased });
    if (req.url === "/release-ui" && req.method === "POST") {
      browserReleased = true;
      return json(200, { released: true });
    }
    try {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer permission-model-test");
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert(size < 1024 * 1024);
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(payload.stream, true);
      const result = decide(payload);
      const trace = req.headers.traceparent?.split("-");
      assert.equal(trace?.[1]?.length, 32);
      requests.push({
        phase: result.phase,
        stage: result.stage,
        trace_id: trace[1],
        model_span_id: trace[2],
        model: payload.model,
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(encodeCompletion(result));
    } catch {
      errors.push("permission fixture validation failed");
      json(400, { error: "permission fixture validation failed" });
    }
  }).listen(8080, "0.0.0.0");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  start();
