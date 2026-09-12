import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { observeState, until } from "./state.mjs";

const ready = {
  agent_id: "a1",
  availability: "ready",
  access_allowed: true,
  agent_revision: 1,
  active_session_id: null,
};

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: "synthetic-cookie",
  };
}

test("state probe propagates identity/trace and closes its HTTP request on abort", async (t) => {
  let request,
    response,
    disconnected = false;
  const client = await fixture(t, (req, res) => {
    request = req;
    response = res;
    res.on("close", () => {
      disconnected = true;
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: workspace_state\ndata: ${JSON.stringify(ready)}\n\n`);
  });
  const abort = new AbortController();
  const watch = observeState(client, "a1", abort.signal);
  t.after(watch.close);
  await watch.wait((state) => state.availability === "ready");
  assert.equal(request.headers.cookie, client.cookie);
  assert.equal(request.headers.origin, client.base);
  assert(request.headers.traceparent.includes(watch.traceID));
  const index = watch.states.length;
  response.write(
    `event: workspace_state\ndata: ${JSON.stringify({ ...ready, availability: "busy", active_session_id: "s1" })}\n\n`,
  );
  await watch.wait((state) => state.active_session_id === "s1", index);
  abort.abort();
  await until(() => disconnected, "aborted observer disconnect");
});

test("state probe rejects malformed, foreign and cursor-bearing snapshots", async (t) => {
  for (const frame of [
    "data: {}",
    `data: ${JSON.stringify({ ...ready, agent_id: "a2" })}`,
    `id: 4\ndata: ${JSON.stringify(ready)}`,
  ]) {
    const client = await fixture(t, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: workspace_state\n${frame}\n\n`);
    });
    const watch = observeState(client, "a1");
    t.after(watch.close);
    await assert.rejects(watch.wait(() => true));
    await assert.rejects(watch.waitClosed());
  }
});

test("lost access closes observation and transport failure is never ready", async (t) => {
  const client = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `event: workspace_state\ndata: ${JSON.stringify({ ...ready, availability: "offline", access_allowed: false })}\n\n`,
    );
  });
  const watch = observeState(client, "a1");
  t.after(watch.close);
  await watch.wait((state) => !state.access_allowed);
  await watch.waitClosed();
  const rejected = await fixture(t, (_req, res) => {
    res.writeHead(401);
    res.end();
  });
  const failed = observeState(rejected, "a1");
  t.after(failed.close);
  await assert.rejects(
    failed.wait(() => true),
    /ended/,
  );
  assert.deepEqual(failed.states, []);
});
