import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { startHeldUpload } from "./upload-capacity-client.mjs";

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
