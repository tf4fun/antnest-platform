import assert from "node:assert/strict";
import test from "node:test";

const marker = "ANTNEST-ACCEPTANCE-1792418000000";
const writePrompt = `Write exactly ${marker} to /workspace/acceptance-note.txt, then read the file to verify it. Use the actual tools, not instructions for me. Report the content you read.`;
const readPrompt =
  "Read /workspace/acceptance-note.txt again with the actual tool and report its content. Do not rewrite it.";
const payload = (prompt = writePrompt) => ({
  model: "deepseek-v4-flash",
  messages: [{ role: "user", content: prompt }],
  tools: ["write", "read"].map((name) => ({
    type: "function",
    function: { name },
  })),
});
const call = (name) => ({
  name,
  arguments:
    name === "write"
      ? { path: "acceptance-note.txt", content: marker }
      : { path: "acceptance-note.txt", offset: 1, limit: 4096 },
});
function result(request, name, value) {
  const id = (name === "write" ? "a" : "b").repeat(64);
  const tool = call(name);
  request.messages.push(
    {
      role: "assistant",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(tool.arguments) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({ effect_state: "settled", ...value }),
    },
  );
  return request;
}
const wrote = () =>
  result(payload(), "write", { bytes_written: marker.length });
const read = () =>
  result(wrote(), "read", { content: marker, truncated: false });

test("Development controlled provider proves write, read and restored read before answering", async () => {
  const { decide } = await import("./model.mjs");
  assert.equal(
    decide(payload("\u4f60\u597d")).text,
    "Hello from the controlled Development provider.",
  );
  assert.deepEqual(decide(payload()).call, call("write"));
  assert.deepEqual(decide(wrote()).call, call("read"));
  assert.equal(decide(read()).text, marker);
  const restored = read();
  restored.messages.push(
    { role: "assistant", content: marker },
    { role: "user", content: readPrompt },
  );
  assert.deepEqual(decide(restored).call, call("read"));
  result(restored, "read", { content: marker, truncated: false });
  assert.equal(decide(restored).text, marker);
});

for (const [name, change] of [
  [
    "missing advertised tool",
    (p) => {
      p.tools = [];
    },
  ],
  [
    "different model",
    (p) => {
      p.model = "foreign";
    },
  ],
  [
    "unknown prompt",
    (p) => {
      p.messages[0].content = "pretend the file was written";
    },
  ],
  [
    "wrong tool arguments",
    (p) => {
      p.messages[1].tool_calls[0].function.arguments = "{}";
    },
  ],
  [
    "foreign tool result",
    (p) => {
      p.messages[2].tool_call_id = "c".repeat(64);
    },
  ],
  [
    "unsettled write",
    (p) => {
      p.messages[2].content = JSON.stringify({
        effect_state: "unknown",
        bytes_written: marker.length,
      });
    },
  ],
  [
    "partial write",
    (p) => {
      p.messages[2].content = JSON.stringify({
        effect_state: "settled",
        bytes_written: 1,
      });
    },
  ],
  [
    "wrong file content",
    (p) => {
      p.messages.at(-1).content = JSON.stringify({
        effect_state: "settled",
        content: "foreign",
        truncated: false,
      });
    },
  ],
  [
    "truncated file read",
    (p) => {
      p.messages.at(-1).content = JSON.stringify({
        effect_state: "settled",
        content: marker,
        truncated: true,
      });
    },
  ],
])
  test(`Development controlled provider rejects ${name}`, async () => {
    const { decide } = await import("./model.mjs");
    const request = read();
    change(request);
    assert.throws(() => decide(request));
  });

test("Development model discovery and six original HTTP calls retain Trace bindings and reject replay", async (t) => {
  const { createDevelopmentModel } = await import("./model.mjs");
  const server = createDevelopmentModel();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "Bearer stage3-model-secret" };
  const discovery = await fetch(base + "/v1/models", { headers });
  assert.equal(discovery.status, 200);
  assert.deepEqual(
    (await discovery.json()).data.map((m) => m.id),
    ["deepseek-v4-flash"],
  );
  const restored = read();
  restored.messages.push(
    { role: "assistant", content: marker },
    { role: "user", content: readPrompt },
  );
  const restoredResult = result(structuredClone(restored), "read", {
    content: marker,
    truncated: false,
  });
  const requests = [
    payload("\u4f60\u597d"),
    payload(),
    wrote(),
    read(),
    restored,
    restoredResult,
  ];
  const send = (body, index) =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        traceparent: `00-${(index === 0 ? "1" : index < 4 ? "2" : "3").repeat(32)}-${String(index + 1).repeat(16)}-01`,
      },
      body: JSON.stringify(body),
    });
  for (const [index, body] of requests.entries()) {
    const response = await send(body, index);
    assert.equal(response.status, 200);
    const message = (await response.json()).choices[0].message;
    if ([1, 2, 4].includes(index)) assert.equal(message.tool_calls.length, 1);
    else assert(message.content.length > 0);
  }
  const status = await (await fetch(base + "/status")).json();
  assert.equal(status.requests.length, 6);
  assert.equal(new Set(status.requests.map((r) => r.trace_id)).size, 3);
  assert.deepEqual(status.errors, []);
  assert.equal((await send(requests[0], 0)).status, 400);
  assert.equal(
    (await (await fetch(base + "/status")).json()).requests.length,
    6,
  );
});
