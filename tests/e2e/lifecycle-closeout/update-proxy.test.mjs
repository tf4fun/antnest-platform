import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { startUpdateProxy } from "./update-proxy.mjs";
const tp = "00-11111111111111111111111111111111-2222222222222222-01";
test("holds only a real selected completed Update; cancellation and unchanged retry are observable", async (t) => {
  const calls = [];
  let valid = true;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    calls.push({
      raw,
      key: req.headers["idempotency-key"],
      tp: req.headers.traceparent,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        request_id: req.headers["idempotency-key"],
        agent_id: req.url.split("/")[3],
        kind: "update_runtime",
        state: valid ? "completed" : "running",
        effect: "completed",
        target_revision: "rtv_new",
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = startUpdateProxy(
    `http://127.0.0.1:${upstream.address().port}`,
    0,
    "127.0.0.1",
    { holdMs: 2000 },
  );
  await once(proxy, "listening");
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const post = async (path, body) =>
    fetch(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "idempotency-key": "child", traceparent: tp },
      signal: AbortSignal.timeout(3000),
    });
  const state = async () => (await fetch(base + "/__test/status")).json();
  assert.equal((await post("/__test/arm", { agent_id: "agent" })).status, 200);
  const body = {
    configuration: { secret: "never-persist-this" },
    expected_revision: "old",
  };
  await post("/internal/runtimes/foreign/update", body);
  assert.equal((await state()).records.length, 0);
  valid = false;
  await post("/internal/runtimes/agent/update", body);
  assert.equal((await state()).records.length, 0);
  valid = true;
  const pending = request(base + "/internal/runtimes/agent/update", {
    method: "POST",
    headers: { "idempotency-key": "child", traceparent: tp },
  });
  let delivered = false;
  pending.on("response", () => {
    delivered = true;
  });
  const done = new Promise((r) => pending.once("error", r));
  pending.end(JSON.stringify(body));
  let held;
  for (let i = 0; i < 100; i++) {
    held = (await state()).held;
    if (held) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert(held);
  assert.equal(delivered, false);
  assert.equal(held.request_id, "child");
  assert.equal(held.delivery, "held");
  assert.equal((await post("/__test/arm", { agent_id: "agent" })).status, 409);
  assert(!JSON.stringify(await state()).includes("never-persist-this"));
  pending.destroy();
  await done;
  for (let i = 0; i < 100 && (await state()).held; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal((await state()).records[0].delivery, "caller_disconnected");
  assert.equal(
    (await post("/internal/runtimes/agent/update", body)).status,
    200,
  );
  const records = (await state()).records;
  assert.equal(records.length, 2);
  assert.equal(records[1].delivery, "delivered");
  assert.equal(records[0].request_hash, records[1].request_hash);
  assert.equal(records[0].response_hash, records[1].response_hash);
  assert(
    calls.every(
      (c) => c.tp === tp && c.key === "child" && c.raw === JSON.stringify(body),
    ),
  );
});
