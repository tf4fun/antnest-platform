import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const readPrompt =
  "Read /workspace/acceptance-note.txt again with the actual tool and report its content. Do not rewrite it.";
const writePattern =
  /^Write exactly (ANTNEST-ACCEPTANCE-[0-9]+) to \/workspace\/acceptance-note\.txt, then read the file to verify it\. Use the actual tools, not instructions for me\. Report the content you read\.$/u;
function promptText(message) {
  if (typeof message?.content === "string") return message.content;
  assert.equal(
    message?.content?.length,
    1,
    "one synthetic text prompt required",
  );
  assert.equal(message.content[0].type, "text");
  return message.content[0].text;
}
const writeCall = (marker) => ({
  name: "write",
  arguments: { path: "acceptance-note.txt", content: marker },
});
const readCall = () => ({
  name: "read",
  arguments: { path: "acceptance-note.txt", offset: 1, limit: 4096 },
});
function inspectResult(pair, call, marker) {
  assert.equal(pair.length, 2, "one issued Tool and its result required");
  const [issued, result] = pair;
  assert.equal(issued.role, "assistant");
  const id = issued.tool_calls?.[0]?.id;
  assert.match(
    id ?? "",
    /^[a-f0-9]{64}$/u,
    "Run-scoped Tool identity required",
  );
  assert.deepEqual(issued.tool_calls, [
    {
      id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    },
  ]);
  assert.equal(result.role, "tool");
  assert.equal(result.tool_call_id, id);
  const output = JSON.parse(result.content);
  assert.equal(output.effect_state, "settled");
  if (call.name === "write")
    assert.equal(output.bytes_written, Buffer.byteLength(marker));
  else {
    assert.equal(output.truncated, false);
    assert.equal(
      output.content,
      marker,
      "the actual file read must match the original marker",
    );
  }
}

export function decide(payload) {
  assert.equal(payload.model, "deepseek-v4-flash");
  const index = payload.messages.findLastIndex((item) => item.role === "user");
  assert(index >= 0, "original user prompt required");
  const text = promptText(payload.messages[index]);
  const tail = payload.messages.slice(index + 1);
  if (text === "\u4f60\u597d") {
    assert.equal(tail.length, 0);
    return {
      phase: "greeting",
      step: 0,
      text: "Hello from the controlled Development provider.",
    };
  }
  for (const name of ["write", "read"])
    assert(
      payload.tools?.some(
        (item) => item.type === "function" && item.function?.name === name,
      ),
      "actual Runtime Tool must be advertised",
    );
  const write = writePattern.exec(text);
  if (write) {
    const marker = write[1];
    assert([0, 2, 4].includes(tail.length), "unexpected write/read exchange");
    if (tail.length === 0)
      return { phase: "write-read", step: 0, call: writeCall(marker) };
    inspectResult(tail.slice(0, 2), writeCall(marker), marker);
    if (tail.length === 2)
      return { phase: "write-read", step: 1, call: readCall() };
    inspectResult(tail.slice(2), readCall(), marker);
    return { phase: "write-read", step: 2, text: marker };
  }
  assert.equal(text, readPrompt, "unexpected Development prompt");
  const priorWrites = payload.messages
    .slice(0, index)
    .filter((item) => item.role === "user")
    .map(promptText)
    .map((value) => writePattern.exec(value))
    .filter(Boolean);
  assert.equal(priorWrites.length, 1, "one original workspace write required");
  const marker = priorWrites[0][1];
  assert([0, 2].includes(tail.length), "restored prompt must only read");
  if (tail.length === 0)
    return { phase: "restored-read", step: 0, call: readCall() };
  inspectResult(tail, readCall(), marker);
  return { phase: "restored-read", step: 1, text: marker };
}

export function createDevelopmentModel() {
  const requests = [],
    discoveries = [],
    errors = [];
  return createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests, discoveries, errors });
    try {
      assert.equal(request.headers.authorization, "Bearer stage3-model-secret");
      if (request.method === "GET" && request.url === "/v1/models") {
        discoveries.push({ model: "deepseek-v4-flash" });
        return reply(200, {
          object: "list",
          data: [
            {
              id: "deepseek-v4-flash",
              object: "model",
              owned_by: "development-controlled",
            },
          ],
        });
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const parent = request.headers.traceparent ?? "";
      assert.match(parent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024, "model request too large");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const decision = decide(payload);
      assert(
        !requests.some(
          (row) => row.phase === decision.phase && row.step === decision.step,
        ),
        "model execution repeated",
      );
      requests.push({
        phase: decision.phase,
        step: decision.step,
        trace_id: parent.split("-")[1],
        model_span_id: parent.split("-")[2],
        payload,
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
                      id: `${decision.phase}-${decision.step}`,
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
    } catch {
      errors.push("Development model request rejected");
      reply(400, { error: "Development model request rejected" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createDevelopmentModel().listen(8080, "0.0.0.0");
