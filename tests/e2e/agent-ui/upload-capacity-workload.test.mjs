import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { buildPromptBlocks } from "../../../services/agent-ui/web/src/lib/prompt.ts";
import { acpPromptRequestBytes } from "../../../services/agent-ui/web/server/src/adapters/acp-http.ts";
import {
  capacityImages,
  capacityContextWindow,
  capacityDecision,
  capacityCases,
} from "./upload-capacity-workload.mjs";
import { createCapacityModel } from "./upload-capacity-model.mjs";

const payload = (phase, content = phase) => ({
  model: "stage3-model",
  messages: [{ role: "user", content }],
  tools: [{ type: "function", function: { name: "bash" } }],
});
test("three fully decoded PNGs pass the shipped actual-capability converter near the wire limit", async () => {
  const images = capacityImages();
  assert.equal(images.length, 3);
  for (const image of images) {
    const bytes = image.bytes;
    assert.deepEqual(
      bytes.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    let offset = 8;
    const chunks = [];
    while (offset < bytes.length) {
      const size = bytes.readUInt32BE(offset);
      const kind = bytes.toString("ascii", offset + 4, offset + 8),
        data = bytes.subarray(offset + 8, offset + 8 + size);
      let crc = 0xffffffff;
      for (const v of bytes.subarray(offset + 4, offset + 8 + size)) {
        crc ^= v;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      assert.equal(
        (crc ^ 0xffffffff) >>> 0,
        bytes.readUInt32BE(offset + 8 + size),
      );
      chunks.push({ kind, data });
      offset += 12 + size;
    }
    assert.deepEqual(
      chunks.map((c) => c.kind),
      ["IHDR", "IDAT", "IEND"],
    );
    assert.equal(offset, bytes.length);
    assert.equal(chunks[0].data.readUInt32BE(0), 1024);
    assert.equal(chunks[0].data.readUInt32BE(4), 1020);
    const raw = inflateSync(chunks[1].data);
    assert.equal(raw.length, (1024 * 4 + 1) * 1020);
    for (let row = 0; row < 1020; row++)
      assert.equal(raw[row * (1024 * 4 + 1)], 0);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      image.sha256,
    );
  }
  const attachments = images.map((image, i) => ({
    id: String(i),
    name: i + ".png",
    file: new File([image.bytes], i + ".png", { type: "image/png" }),
  }));
  const prompt = await buildPromptBlocks(
    "capacity-parse-cancel-upload",
    attachments,
    { image: true, embeddedContext: true },
  );
  assert.equal(prompt.length, 4);
  const size = acpPromptRequestBytes({
    sessionId: "session-" + "s".repeat(32),
    intentId: "capacity-parse-cancel-upload",
    expectedAppendVersion: 0,
    prompt,
  });
  assert(size >= 16 * 1024 * 1024 * 0.99 && size <= 16 * 1024 * 1024);
  const content = [
    { type: "text", text: "capacity-parse-cancel-upload" },
    ...prompt.slice(1).map((block) => ({
      type: "image_url",
      image_url: { url: "data:image/png;base64," + block.data },
    })),
  ];
  const result = capacityDecision(payload(content[0].text, content));
  assert.deepEqual(
    result.report.images,
    images.map(({ sha256, bytes }) => ({ sha256, size: bytes.length })),
  );
  await assert.rejects(() =>
    buildPromptBlocks("", attachments, { embeddedContext: true }),
  );
});
for (const entry of capacityCases)
  test("actual held bash cannot finish naturally: " + entry.id, () => {
    const result = capacityDecision(payload(entry.id + "-held"));
    assert.equal(result.call.name, "bash");
    assert.equal(result.call.arguments.timeout_ms, 120000);
    assert.match(
      result.call.arguments.command,
      /while :; do sleep 0\.1; done/u,
    );
    assert.match(result.call.arguments.command, /"\$\$"/u);
  });
for (const [name, change] of [
  ["wrong model", (p) => (p.model = "other")],
  ["missing bash", (p) => (p.tools = [])],
  [
    "post-tool continuation",
    (p) => p.messages.push({ role: "tool", content: "finished" }),
  ],
  ["unknown phase", (p) => (p.messages[0].content = "arbitrary command")],
])
  test("model rejects " + name, () => {
    const p = payload("capacity-parse-cancel-held");
    change(p);
    assert.throws(() => capacityDecision(p));
  });
test("model rejects changed image bytes", () => {
  const images = capacityImages();
  const content = [
    { type: "text", text: "capacity-parse-cancel-upload" },
    ...images.map((image) => ({
      type: "image_url",
      image_url: {
        url: "data:image/png;base64," + image.bytes.toString("base64"),
      },
    })),
  ];
  content[1].image_url.url = content[1].image_url.url.slice(0, -4) + "AAAA";
  assert.throws(() => capacityDecision(payload(content[0].text, content)));
});
test("real model HTTP preserves one original phase and refuses duplicate execution", async (t) => {
  const server = createCapacityModel();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const options = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer stage3-model-secret",
      traceparent: "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-01",
    },
    body: JSON.stringify(payload("capacity-parse-cancel-held")),
  };
  const first = await fetch(base + "/v1/chat/completions", options);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).choices[0].finish_reason, "tool_calls");
  const second = await fetch(base + "/v1/chat/completions", options);
  assert.equal(second.status, 400);
  await second.arrayBuffer();
  const state = await (await fetch(base + "/status")).json();
  assert.equal(state.requests.length, 1);
  assert.equal(state.errors.length, 1);
  assert.equal(state.requests[0].trace_id, "1".repeat(32));
});

test("the controlled model context admits the actual near-limit input through the shipped ACP budget", async () => {
  const { tsImport } =
    await import("../../../services/agent-acp-service/node_modules/tsx/dist/esm/api/index.mjs");
  const { assertModelInputBudget, estimateMessages } = await tsImport(
    "../../../services/agent-acp-service/src/application/context-budget.ts",
    import.meta.url,
  );
  const prompt = await buildPromptBlocks(
    "capacity-receive-cancel-upload",
    capacityImages().map((i, n) => ({
      id: String(n),
      name: n + ".png",
      file: new File([i.bytes], n + ".png", { type: "image/png" }),
    })),
    { image: true, embeddedContext: true },
  );
  const messages = [
    { role: "system", content: [{ type: "text", text: "runtime context" }] },
    { role: "user", content: prompt },
  ];
  const snapshot = {
    executionSpec: {
      model: {
        model: "stage3-model",
        tokenizer: "none",
        contextWindow: capacityContextWindow,
        maxOutputTokens: 1024,
      },
    },
  };
  // Wire-sized images have a media reserve, not a base64-length token cost.
  assert(estimateMessages(messages) > 4096);
  assert(estimateMessages(messages) < 8192);
  assert.doesNotThrow(() => assertModelInputBudget(snapshot, [], messages));
  assert.throws(
    () =>
      assertModelInputBudget(
        {
          executionSpec: {
            model: {
              ...snapshot.executionSpec.model,
              contextWindow: 4096,
            },
          },
        },
        [],
        messages,
      ),
    { code: "context_budget_exhausted" },
  );
});
