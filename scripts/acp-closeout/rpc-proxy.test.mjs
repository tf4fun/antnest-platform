import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { startProxy } from "./rpc-proxy.mjs";

const acquire = {
  request_id: "request-1",
  agent_id: "agent-1",
  session_id: "session-1",
};
const admitted = {
  admission_id: "admission-1",
  admission_deadline: "2026-09-10T00:00:00Z",
  execution_revision: "execution-1",
  credential_ref: "never-serialize-secret",
};
const finish = {
  request_id: "finish-1",
  admission_id: "admission-1",
  terminal_class: "completed",
  tool_effect_state: "settled",
  stop_reason: "end_turn",
};
const prefix = "/rpc/agent-controller/";
const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
async function fixture(t, respond = (_path, _body) => admitted) {
  const received = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    received.push({
      path: req.url,
      body,
      traceparent: req.headers.traceparent,
    });
    const value = respond(req.url, body);
    res.writeHead(value?.http_status ?? 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(value));
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = startProxy(
    `http://127.0.0.1:${upstream.address().port}`,
    0,
    "127.0.0.1",
  );
  await once(proxy, "listening");
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const post = async (path, body, expected = 200) => {
    const res = await fetch(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(res.status, expected);
    return res.json();
  };
  const state = async () => (await fetch(base + "/__test/status")).json();
  const hold = (method, body) => {
    const observed = { headers: false, bytes: 0, code: undefined };
    const req = request(base + prefix + method, {
      method: "POST",
      headers: { "content-type": "application/json", traceparent },
    });
    const done = new Promise((resolve) => {
      req.on("response", (res) => {
        observed.headers = true;
        res.on("data", (chunk) => {
          observed.bytes += chunk.length;
        });
        res.on("end", resolve);
      });
      req.on("error", (error) => {
        observed.code = error.code;
        resolve();
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error("probe timeout")));
    req.end(JSON.stringify(body));
    return {
      observed,
      done,
      abort: () => req.destroy(new Error("caller aborted")),
    };
  };
  return { post, state, hold, received };
}
async function held(state) {
  for (let i = 0; i < 100; i++) {
    const result = await state();
    if (result.held) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("proxy never held a committed response");
}

for (const method of ["acquire-run", "finish-run"])
  test(`${method}: real success precedes loss; no header/body reaches caller; retry passes unchanged`, async (t) => {
    let finishes = 0;
    const f = await fixture(t, (path) =>
      path.endsWith("finish-run")
        ? {
            status: finishes++ === 0 ? "finished" : "already_finished",
            admission_state: "released",
          }
        : admitted,
    );
    if (method === "finish-run") await f.post(prefix + "acquire-run", acquire);
    await f.post("/__test/arm", {
      method,
      agent_id: acquire.agent_id,
      session_id: acquire.session_id,
    });
    const body = method === "acquire-run" ? acquire : finish;
    const probe = f.hold(method, body);
    const before = await held(f.state);
    assert.equal(before.held.method, method);
    assert.equal(before.held.admission_id, admitted.admission_id);
    assert.equal(before.held.status, 200);
    assert.equal(probe.observed.headers, false);
    assert.equal(probe.observed.bytes, 0);
    assert.equal(f.received.at(-1).traceparent, traceparent);
    assert(!JSON.stringify(before).includes(admitted.credential_ref));
    assert.equal(before.records.at(-1).delivery, "held");
    await f.post(
      "/__test/arm",
      { method, agent_id: "other", session_id: "other" },
      409,
    );
    await f.post("/__test/drop", { request_id: body.request_id });
    await probe.done;
    assert.equal(probe.observed.code, "ECONNRESET");
    assert.equal(probe.observed.headers, false);
    await f.post(prefix + method, {
      ...body,
      ...(method === "finish-run" ? { request_id: "finish-retry" } : {}),
    });
    const after = await f.state();
    assert.equal(after.held, null);
    const attempts = after.records.filter((record) => record.method === method);
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map((record) => record.delivery),
      ["dropped", "delivered"],
    );
    assert.equal(attempts[0].semantic_hash, attempts[1].semantic_hash);
    if (method === "acquire-run")
      assert.equal(attempts[0].response_hash, attempts[1].response_hash);
    else {
      assert.deepEqual(
        attempts.map((item) => item.finish_status),
        ["finished", "already_finished"],
      );
      assert(attempts.every((item) => item.admission_state === "released"));
    }
    assert.equal(attempts[0].admission_id, attempts[1].admission_id);
  });

test("unrelated traffic and non-success responses cannot manufacture a response-loss proof", async (t) => {
  const f = await fixture(t, (path, body) =>
    path.endsWith("resolve-credential")
      ? { secret: "credential-canary" }
      : body.request_id === "bad"
        ? { http_status: 409, code: "agent_busy" }
        : admitted,
  );
  await f.post("/__test/arm", {
    method: "acquire-run",
    agent_id: "agent-1",
    session_id: "session-1",
  });
  await f.post(prefix + "resolve-credential", {});
  await f.post(prefix + "acquire-run", { ...acquire, agent_id: "other" });
  await f.post(prefix + "acquire-run", { ...acquire, request_id: "bad" }, 409);
  const state = await f.state();
  assert.equal(state.held, null);
  assert.equal(state.records.length, 0);
  assert(!JSON.stringify(state).includes("credential-canary"));
  await f.post("/__test/drop", { request_id: "bad" }, 409);
});

test("a caller-disconnected response cannot subsequently count as a deliberate drop", async (t) => {
  const f = await fixture(t);
  await f.post("/__test/arm", {
    method: "acquire-run",
    agent_id: "agent-1",
    session_id: "session-1",
  });
  const probe = f.hold("acquire-run", acquire);
  await held(f.state);
  probe.abort();
  await probe.done;
  for (let i = 0; i < 100 && (await f.state()).held; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await f.post("/__test/drop", { request_id: acquire.request_id }, 409);
  const state = await f.state();
  assert.equal(state.held, null);
  assert.equal(state.records[0].delivery, "lost_before_drop");
});
