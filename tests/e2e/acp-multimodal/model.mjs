import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { providerContent } from "./fixtures.mjs";
import { encodeCompletion } from "../acp-progress/model.mjs";

export function decide(payload) {
  assert.equal(payload.stream, true);
  assert.equal(
    payload.model,
    "native-model",
    "unsupported model reached Provider",
  );
  assert(
    !payload.messages.some((m) => m.role === "tool"),
    "unexpected Tool execution",
  );
  const messages = payload.messages.filter((m) => m.role === "user");
  const native = messages.find((m) => Array.isArray(m.content));
  const label = native?.content[0]?.text;
  assert.match(label ?? "", /^(v1-ws|v2-ws|v1-http) native$/);
  const profile = label.split(" ")[0];
  assert.deepEqual(
    native.content,
    providerContent(profile),
    "native content changed",
  );
  assert.equal(messages.filter((m) => Array.isArray(m.content)).length, 1);
  for (const message of messages.filter((m) => m !== native)) {
    assert.match(
      message.content,
      new RegExp(`^${profile} (continue|mismatch|restored)$`),
    );
  }
  const phase =
    typeof messages.at(-1).content === "string"
      ? messages.at(-1).content
      : label;
  return { phase, text: `${profile} native input verified` };
}

export function createModelFixture() {
  const requests = [],
    errors = [];
  let referenceRequests = 0;
  return createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return json(200, { requests, errors, referenceRequests });
    if (request.url === "/reference") {
      referenceRequests++;
      return json(200, { unexpected: "Reference links must not be fetched" });
    }
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer native-model-test");
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
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(encodeCompletion(result));
    } catch {
      // Assertion diffs may contain native content; only expose a fixed diagnostic.
      errors.push("native request contract violation");
      json(400, { error: "native request contract violation" });
    }
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  createModelFixture().listen(8080, "0.0.0.0");
