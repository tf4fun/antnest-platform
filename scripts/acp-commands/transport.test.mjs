import assert from "node:assert/strict";
import test from "node:test";
import { observeStream, observeFetch } from "./transport.mjs";

test("WebSocket observer records actual SDK IDs without changing messages or retaining payloads", async () => {
  const sent = [],
    observed = [];
  let closed = false;
  const source = {
    readable: new ReadableStream(),
    writable: new WritableStream({
      write: (m) => sent.push(m),
      close: () => {
        closed = true;
      },
    }),
  };
  const stream = observeStream(source, observed);
  assert.equal(stream.readable, source.readable);
  const writer = stream.writable.getWriter();
  const request = {
    jsonrpc: "2.0",
    id: 47,
    method: "session/prompt",
    params: { sessionId: "session", prompt: [{ text: "PRIVATE" }] },
  };
  await writer.write(request);
  await writer.write({ jsonrpc: "2.0", id: 9, result: {} });
  await writer.close();
  assert.equal(sent[0], request);
  assert.equal(closed, true);
  assert.deepEqual(observed, [
    { requestId: "47", method: "session/prompt", sessionId: "session" },
  ]);
});
test("HTTP observer records the Gateway response trace per POST and preserves SDK transport", async () => {
  const observed = [],
    sent = [];
  const fetch = observeFetch(async (url, init) => {
    sent.push({ url, init });
    return new Response("{}", {
      status: 202,
      headers: { "X-Antnest-Trace-ID": String(sent.length).padStart(32, "0") },
    });
  }, observed);
  const init = {
    method: "POST",
    headers: { Cookie: "synthetic" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "actual",
      method: "session/new",
      params: { private: "PRIVATE" },
    }),
  };
  assert.equal((await fetch("http://fixture", init)).status, 202);
  await fetch("http://fixture", { method: "GET" });
  assert.equal(sent[0].init, init);
  assert.deepEqual(observed, [
    {
      requestId: "actual",
      method: "session/new",
      sessionId: undefined,
      traceID: "00000000000000000000000000000001",
    },
  ]);
  await assert.rejects(
    observeFetch(async () => new Response("{}"), [])("http://fixture", init),
  );
});
