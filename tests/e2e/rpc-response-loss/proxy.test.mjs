import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { startProxy } from "./proxy.mjs";
const tp = "00-11111111111111111111111111111111-2222222222222222-01";
const auth = `Bearer ${"a".repeat(43)}`;
const inputs = {
  "apply-execution-snapshot": {
    organization_id: "org",
    revision: 7,
    providers: [{ credential: { secret: "never-expose-this" } }],
    models: [],
    agents: [],
  },
  "settle-agent": {
    organization_id: "org",
    agent_id: "agent",
    operation_id: "operation",
    minimum_revision: 7,
    mode: "wait",
    deadline_at: "2026-09-17T12:00:00Z",
  },
};
const selection = (method) => ({
  method,
  organization_id: "org",
  ...(method === "settle-agent" ? { agent_id: "agent" } : { revision: 7 }),
});
const output = (method) =>
  method === "settle-agent"
    ? { applied_revision: 7, outcome: "settled" }
    : { organization_id: "org", applied_revision: 7 };
async function fixture(
  t,
  reply = (method) => ({ status: 200, body: output(method) }),
  holdMs = 2000,
) {
  const received = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      body: JSON.parse(Buffer.concat(chunks)),
      traceparent: req.headers.traceparent,
      authorization: req.headers["antnest-service-authorization"],
    });
    const result = reply(req.url.split("/").at(-1));
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = startProxy(
    `http://127.0.0.1:${upstream.address().port}`,
    0,
    "127.0.0.1",
    { holdMs },
  );
  await once(proxy, "listening");
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const post = async (path, body, status = 200) => {
    const r = await fetch(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { traceparent: tp, "Antnest-Service-Authorization": auth },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(r.status, status);
    return r.json();
  };
  const state = async () => (await fetch(base + "/__test/status")).json();
  const pending = (method) => {
    const observed = { headers: false, bytes: 0 };
    const req = request(base + "/rpc/agent-acp/" + method, {
      method: "POST",
      headers: { traceparent: tp, "Antnest-Service-Authorization": auth },
    });
    const done = new Promise((resolve) => {
      req.on("response", (res) => {
        observed.headers = true;
        res.on("data", (b) => (observed.bytes += b.length));
        res.on("end", resolve);
      });
      req.on("error", (err) => {
        observed.code = err.code;
        resolve();
      });
    });
    req.setTimeout(3000, () => req.destroy());
    req.end(JSON.stringify(inputs[method]));
    return { observed, done, abort: () => req.destroy() };
  };
  const held = async () => {
    for (let i = 0; i < 100; i++) {
      const value = await state();
      if (value.held) return value.held;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error("no held response");
  };
  return { post, state, pending, held, received };
}
for (const method of Object.keys(inputs))
  test(`${method}: real success is withheld once, then dropped; retry is forwarded unchanged`, async (t) => {
    const f = await fixture(t);
    await f.post("/__test/arm", selection(method));
    const pending = f.pending(method),
      held = await f.held();
    assert.equal(held.method, method);
    assert.equal(held.delivery, "held");
    assert.equal(pending.observed.headers, false);
    assert.equal(pending.observed.bytes, 0);
    assert.deepEqual(f.received, [
      { body: inputs[method], traceparent: tp, authorization: auth },
    ]);
    assert(!JSON.stringify(await f.state()).includes("never-expose-this"));
    await f.post("/__test/drop", { receipt_id: "foreign" }, 409);
    await f.post("/__test/arm", selection(method), 409);
    await f.post("/__test/drop", { receipt_id: held.receipt_id });
    await pending.done;
    assert.equal(pending.observed.code, "ECONNRESET");
    assert.equal(pending.observed.headers, false);
    assert.deepEqual(
      await f.post("/rpc/agent-acp/" + method, inputs[method]),
      output(method),
    );
    const records = (await f.state()).records;
    assert.deepEqual(
      records.map((r) => r.delivery),
      ["dropped", "delivered"],
    );
    assert.equal(records[0].request_hash, records[1].request_hash);
    assert.equal(records[0].response_hash, records[1].response_hash);
    assert.equal(f.received.length, 2);
  });
test("foreign scope, non-success and invalid acknowledgements cannot create a loss receipt", async (t) => {
  const f = await fixture(t, () => ({
    status: 503,
    body: { code: "unavailable" },
  }));
  await f.post("/__test/arm", selection("apply-execution-snapshot"));
  await f.post(
    "/rpc/agent-acp/apply-execution-snapshot",
    inputs["apply-execution-snapshot"],
    503,
  );
  assert.equal((await f.state()).held, null);
  assert.deepEqual((await f.state()).records, []);
  await f.post("/__test/arm", { method: "acquire-run" }, 409);
});
test("revision/Agent scope is exact and malformed 200 is forwarded without an applied receipt", async (t) => {
  const f = await fixture(t, () => ({
    status: 200,
    body: { organization_id: "foreign", applied_revision: 7 },
  }));
  await f.post("/__test/arm", selection("apply-execution-snapshot"));
  await f.post(
    "/rpc/agent-acp/apply-execution-snapshot",
    inputs["apply-execution-snapshot"],
  );
  assert.equal((await f.state()).held, null);
  assert.deepEqual((await f.state()).records, []);
});
test("timeout cannot be mistaken for the requested drop", async (t) => {
  const f = await fixture(t, undefined, 50);
  await f.post("/__test/arm", selection("settle-agent"));
  const pending = f.pending("settle-agent");
  const held = await f.held();
  await pending.done;
  assert.equal((await f.state()).records[0].delivery, "expired");
  await f.post("/__test/drop", { receipt_id: held.receipt_id }, 409);
});
test("foreign revision, organization and Agent are forwarded and never arm a receipt", async (t) => {
  const f = await fixture(t);
  await f.post("/__test/arm", { method: "acquire-run" }, 400);
  for (const method of Object.keys(inputs)) {
    await f.post("/__test/arm", selection(method));
    for (const patch of [
      { organization_id: "foreign" },
      method === "settle-agent" ? { agent_id: "foreign" } : { revision: 6 },
    ]) {
      await f.post("/rpc/agent-acp/" + method, { ...inputs[method], ...patch });
      assert.deepEqual((await f.state()).records, []);
      assert.equal((await f.state()).armed, true);
    }
    const pending = f.pending(method),
      held = await f.held();
    await f.post("/__test/drop", { receipt_id: held.receipt_id });
    await pending.done;
  }
});
test("caller disconnect is recorded separately from explicit fault injection", async (t) => {
  const f = await fixture(t);
  await f.post("/__test/arm", selection("settle-agent"));
  const pending = f.pending("settle-agent"),
    held = await f.held();
  pending.abort();
  await pending.done;
  for (let i = 0; i < 100 && (await f.state()).held; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal((await f.state()).records[0].delivery, "lost_before_drop");
  await f.post("/__test/drop", { receipt_id: held.receipt_id }, 409);
});
test("a malformed successful upstream body is forwarded without claiming settlement", async (t) => {
  const f = await fixture(t, () => ({ status: 200, body: null }));
  await f.post("/__test/arm", selection("settle-agent"));
  assert.equal(
    await f.post("/rpc/agent-acp/settle-agent", inputs["settle-agent"]),
    null,
  );
  assert.deepEqual((await f.state()).records, []);
  assert.equal((await f.state()).armed, true);
});
