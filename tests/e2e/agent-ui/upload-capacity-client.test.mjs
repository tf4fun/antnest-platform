import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import * as capacityClient from "./upload-capacity-client.mjs";
const { startHeldUpload } = capacityClient;

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r, j) => server.close((e) => (e ? j(e) : r())));
  });
  return "http://127.0.0.1:" + server.address().port;
}
test("native client holds the actual last byte and joins response/socket after EOF", async (t) => {
  const seen = Promise.withResolvers();
  let eof = false,
    received = 0;
  const url = await fixture(t, (req, res) => {
    req.on("data", (chunk) => {
      received += chunk.length;
      seen.resolve();
    });
    req.on("end", () => {
      eof = true;
      res
        .writeHead(202, {
          "content-type": "application/json",
          "x-antnest-trace-id": "1".repeat(32),
        })
        .end('{"accepted":true}');
    });
  });
  const upload = startHeldUpload(url, {}, Buffer.from('{"body":"abc"}'));
  t.after(() => upload.closeAndWait());
  await upload.flushed;
  await seen.promise;
  assert.equal(eof, false);
  assert.equal(received, 13);
  await upload.finish();
  const response = await upload.response;
  assert.equal(response.status, 202);
  assert.equal(response.response_trace_id, "1".repeat(32));
  assert.equal(eof, true);
  assert.equal(received, 14);
  assert(BigInt(response.complete_ns) >= BigInt(upload.evidence.eof_sent_ns));
  await upload.closeAndWait();
  assert.equal(upload.evidence.joined, true);
});
test("interrupted unfinished body closes socket and joins the rejected response", async (t) => {
  const seen = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const url = await fixture(t, (req) => {
    req.on("data", () => seen.resolve());
    req.on("error", () => {});
    req.on("close", () => closed.resolve());
  });
  const abort = new AbortController(),
    upload = startHeldUpload(url, {}, Buffer.from("unfinished"), abort.signal);
  await upload.flushed;
  await seen.promise;
  abort.abort(new Error("test cancellation"));
  await assert.rejects(upload.response);
  await upload.closeAndWait();
  await closed.promise;
  assert.equal(upload.evidence.joined, true);
  assert.equal(upload.evidence.eof_sent_ns, undefined);
});
test("server rejection before EOF is retained and never passed as an accepted upload", async (t) => {
  const url = await fixture(t, (req, res) => {
    req.resume();
    res
      .writeHead(413, {
        "content-type": "application/json",
        connection: "close",
        "x-antnest-trace-id": "2".repeat(32),
      })
      .end('{"code":"request_too_large"}');
  });
  const upload = startHeldUpload(url, {}, Buffer.from("large body"));
  t.after(() => upload.closeAndWait());
  await upload.flushed;
  const response = await upload.response;
  assert.equal(response.status, 413);
  assert.equal(response.response.code, "request_too_large");
  await upload.closeAndWait();
  assert.equal(upload.evidence.eof_sent_ns, undefined);
});

test("prepared cancellation connects without dispatch and records one actual write", async (t) => {
  let calls = 0,
    received;
  const cookie = "private-cookie-canary",
    csrf = "private-csrf-canary";
  const url = await fixture(t, async (req, res) => {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks)),
    };
    res
      .writeHead(200, { "x-antnest-trace-id": "3".repeat(32) })
      .end('{"phase":"cancelling"}');
  });
  assert.equal(typeof capacityClient.prepareCapacityCancellation, "function");
  const cancel = capacityClient.prepareCapacityCancellation(
    url,
    {
      Cookie: cookie,
      "X-Antnest-CSRF-Token": csrf,
      Origin: url,
    },
    { expectedRunId: "original-run" },
  );
  t.after(() => cancel.closeAndWait());
  assert.throws(() => cancel.send(), /not ready/u);
  await cancel.ready;
  assert.equal(calls, 0, "preparing a socket must not send an HTTP request");
  assert.equal(cancel.evidence.sent_ns, undefined);
  const before = process.hrtime.bigint();
  const response = cancel.send();
  assert.throws(() => cancel.send(), /already sent/u);
  assert.equal((await response).status, 200);
  await cancel.closeAndWait();
  assert.equal(calls, 1);
  assert.deepEqual(received.body, { expectedRunId: "original-run" });
  assert.equal(received.headers.cookie, cookie);
  assert.equal(received.headers["x-antnest-csrf-token"], csrf);
  const e = cancel.evidence;
  assert.equal(e.response_trace_id, "3".repeat(32));
  assert(BigInt(e.socket_ready_ns) <= BigInt(e.sent_ns));
  assert(
    before <= BigInt(e.sent_ns) && BigInt(e.sent_ns) <= BigInt(e.written_ns),
  );
  assert(BigInt(e.written_ns) <= BigInt(e.complete_ns));
  assert.equal(e.joined, true);
  assert(
    !JSON.stringify(e).includes(cookie) && !JSON.stringify(e).includes(csrf),
  );
});

test("prepared cancellation aborts and joins before sending any HTTP bytes", async (t) => {
  let calls = 0;
  const url = await fixture(t, (_req, res) => {
    calls++;
    res.end("{}");
  });
  const abort = new AbortController();
  assert.equal(typeof capacityClient.prepareCapacityCancellation, "function");
  const cancel = capacityClient.prepareCapacityCancellation(
    url,
    {},
    {},
    abort.signal,
  );
  t.after(() => cancel.closeAndWait());
  await cancel.ready;
  abort.abort(new Error("test prepared cancellation interrupted"));
  await assert.rejects(cancel.response);
  await cancel.closeAndWait();
  assert.equal(calls, 0);
  assert.equal(cancel.evidence.sent_ns, undefined);
  assert.equal(cancel.evidence.written_ns, undefined);
  assert.equal(cancel.evidence.joined, true);
  assert.throws(() => cancel.send());
});

test("prepared cancellation rejects an unsolicited response and joins without send", async (t) => {
  const sockets = new Set();
  let received = 0;
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      received += chunk.length;
    });
    socket.end(
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const cancel = capacityClient.prepareCapacityCancellation(
    `http://127.0.0.1:${server.address().port}`,
    {},
    {},
  );
  await cancel.ready;
  const response = await cancel.response.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  let timer;
  try {
    await Promise.race([
      cancel.closeAndWait(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("unsent cancellation cleanup did not join")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.match(response.error?.message ?? "", /response preceded send/u);
  assert.equal(received, 0);
  assert.equal(cancel.evidence.sent_ns, undefined);
  assert.equal(cancel.evidence.written_ns, undefined);
  assert.equal(cancel.evidence.complete_ns, undefined);
  assert.equal(cancel.evidence.joined, true);
  assert.throws(() => cancel.send());
});

test("prepared cancellation preserves a rejected HTTP response without retry", async (t) => {
  let calls = 0;
  const url = await fixture(t, (req, res) => {
    calls++;
    req.resume();
    res
      .writeHead(503, { "x-antnest-trace-id": "4".repeat(32) })
      .end('{"code":"workspace_unavailable"}');
  });
  assert.equal(typeof capacityClient.prepareCapacityCancellation, "function");
  const cancel = capacityClient.prepareCapacityCancellation(
    url,
    {},
    { expectedRunId: "original-run" },
  );
  t.after(() => cancel.closeAndWait());
  await cancel.ready;
  const response = await cancel.send();
  assert.equal(response.status, 503);
  assert.equal(response.response.code, "workspace_unavailable");
  await cancel.closeAndWait();
  assert.equal(calls, 1);
  assert.equal(cancel.evidence.joined, true);
});

test("prepared cancellation joins an incomplete response and cannot resend", async (t) => {
  const url = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "content-length": "1000" });
    res.write('{"unfinished":');
    res.socket.destroy();
  });
  assert.equal(typeof capacityClient.prepareCapacityCancellation, "function");
  const cancel = capacityClient.prepareCapacityCancellation(url, {}, {});
  t.after(() => cancel.closeAndWait());
  await cancel.ready;
  await assert.rejects(cancel.send());
  await cancel.closeAndWait();
  assert.equal(cancel.evidence.joined, true);
  assert.equal(cancel.evidence.complete_ns, undefined);
  assert.throws(() => cancel.send());
});

test("prepared cancellation rejects an already aborted signal before creating work", () => {
  const reason = new Error("already interrupted");
  assert.equal(typeof capacityClient.prepareCapacityCancellation, "function");
  assert.throws(
    () =>
      capacityClient.prepareCapacityCancellation(
        "http://127.0.0.1:1",
        {},
        {},
        AbortSignal.abort(reason),
      ),
    (error) => error === reason,
  );
});
