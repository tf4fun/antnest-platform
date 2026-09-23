import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { observeState, until } from "./state.mjs";

const ready = {
  agent_id: "a1",
  availability: "ready",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
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

test("state probe captures the server Trace ID without inventing a parent and closes on abort", async (t) => {
  let request,
    response,
    disconnected = false;
  const client = await fixture(t, (req, res) => {
    request = req;
    response = res;
    res.on("close", () => {
      disconnected = true;
    });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-antnest-trace-id": "a".repeat(32),
    });
    res.write(`event: workspace_state\ndata: ${JSON.stringify(ready)}\n\n`);
  });
  const abort = new AbortController();
  const watch = observeState(client, "a1", abort.signal);
  t.after(watch.close);
  await watch.wait((state) => state.availability === "ready");
  assert.equal(request.headers.cookie, client.cookie);
  assert.equal(request.headers.origin, client.base);
  assert.equal(request.headers.traceparent, undefined);
  assert.equal(watch.traceID, "a".repeat(32));
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
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-antnest-trace-id": "a".repeat(32),
      });
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
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-antnest-trace-id": "a".repeat(32),
    });
    res.write(
      `event: workspace_state\ndata: ${JSON.stringify({ ...ready, availability: "offline", access_allowed: false, configuration_revision: null, unavailable_reason: "access_denied" })}\n\n`,
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
    /ended|invalid Workspace watch response identity/,
  );
  assert.deepEqual(failed.states, []);
});

test("state probe refuses a success response without the actual server Trace ID", async (t) => {
  const client = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: workspace_state\ndata: ${JSON.stringify(ready)}\n\n`);
  });
  const watch = observeState(client, "a1");
  t.after(watch.close);
  await assert.rejects(watch.wait(() => true));
});
