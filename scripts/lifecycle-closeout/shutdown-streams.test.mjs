import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  openShutdownWatch,
  openShutdownWatchSet,
} from "./shutdown-streams.mjs";

async function fixture(t, data = '{"agent_id":"agent"}') {
  let response,
    requests = 0;
  const server = createServer((request, reply) => {
    requests++;
    assert.equal(request.headers.cookie, "synthetic-cookie");
    assert.match(
      request.headers.traceparent,
      /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
    );
    response = reply;
    reply.writeHead(200, { "content-type": "text/event-stream" });
    reply.write(`event: agent_event\ndata: ${data}\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const abort = new AbortController();
  const watch = openShutdownWatch(
    {
      base: `http://127.0.0.1:${server.address().port}`,
      cookie: "synthetic-cookie",
    },
    "/watch",
    "agent_event",
    (event) => assert.equal(event.agent_id, "agent"),
    abort.signal,
  );
  t.after(async () => {
    watch.close();
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { watch, abort, end: () => response.end(), requests: () => requests };
}
test("partial watch-set construction disposes all earlier watches", () => {
  let closed = 0,
    created = 0;
  assert.throws(
    () =>
      openShutdownWatchSet([[], []], () => {
        if (++created === 2) throw new Error("second construction failed");
        return { close: () => closed++ };
      }),
    /second construction failed/,
  );
  assert.equal(created, 2);
  assert.equal(closed, 1);
});
test("watch proves initial delivery and remote closure without reconnect", async (t) => {
  const { watch, end, requests } = await fixture(t);
  await watch.ready();
  watch.assertOpen();
  end();
  await watch.waitClosed();
  assert.equal(requests(), 1);
  assert.throws(() => watch.assertOpen(), /not live/);
});
test("test-owned cancellation cannot count as remote closure", async (t) => {
  const { watch } = await fixture(t);
  await watch.ready();
  watch.close();
  await assert.rejects(watch.waitClosed(), /closed by the test/);
});
test("invalid initial events cannot prove a usable watch", async (t) => {
  const { watch } = await fixture(t, "private-invalid-response");
  await assert.rejects(watch.ready(), (error) => {
    assert.equal(error.message, "invalid shutdown watch event");
    assert(!error.message.includes("private-invalid-response"));
    return true;
  });
});
