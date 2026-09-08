import assert from "node:assert/strict";
import { createServer } from "node:http";

export function authorizeCompletion(payload, credential) {
  const phase = payload.messages.findLast(
    (item) => item.role === "user",
  )?.content;
  assert.match(phase, /^v[12]-[ab]$/);
  const organization = phase.at(-1),
    other = organization === "a" ? "b" : "a";
  assert(
    credential === `Bearer scope-credential-${organization}`,
    "wrong model credential",
  );
  assert.equal(payload.model, `scope-${organization}`);
  const system = payload.messages
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n");
  assert(
    system.includes(`Private organization ${organization} guidance`),
    "own context missing",
  );
  assert(
    !JSON.stringify(payload.messages).includes(
      `Private organization ${other} guidance`,
    ),
    "foreign context injected",
  );
  for (const version of [1, 2])
    assert(
      !JSON.stringify(payload.messages).includes(
        `Private history v${version}-${other}`,
      ),
      "foreign history injected",
    );
  return { phase, text: `Private history ${phase}` };
}

export function createAccessModel() {
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
      const parent = request.headers.traceparent ?? "";
      assert.match(parent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024, "fixture request too large");
        chunks.push(chunk);
      }
      const result = authorizeCompletion(
        JSON.parse(Buffer.concat(chunks).toString()),
        request.headers.authorization,
      );
      assert(
        !requests.some((item) => item.phase === result.phase),
        "model execution repeated",
      );
      requests.push({
        phase: result.phase,
        trace_id: parent.split("-")[1],
        model_span_id: parent.split("-")[2],
      });
      reply(200, {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: result.text },
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

if (process.argv[1]?.endsWith("/agent-access-model.mjs"))
  createAccessModel().listen(8080, "0.0.0.0");
