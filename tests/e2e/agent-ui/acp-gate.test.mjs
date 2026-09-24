import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAcpGate } from "./acp-gate.mjs";

test("ACP gate withholds only the selected Prompt and forwards the rest", async () => {
  const seen = [];
  const upstream = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(202).end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gate = createAcpGate(`http://127.0.0.1:${upstream.address().port}`);
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  const origin = `http://127.0.0.1:${gate.address().port}`;
  const prompt = (intentId) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { _meta: { "antnest.dev/intent": { intentId } } },
    });
  try {
    assert.equal(
      (
        await fetch(`${origin}/__fault/arm`, {
          method: "POST",
          body: JSON.stringify({ intentId: "held" }),
        })
      ).status,
      200,
    );
    const interrupted = new AbortController();
    const blocked = fetch(origin, {
      method: "POST",
      body: prompt("held"),
      signal: interrupted.signal,
    }).catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (await fetch(`${origin}/__fault/state`)).json();
      if (state.heldIntent === "held") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      (await (await fetch(`${origin}/__fault/state`)).json()).heldIntent,
      "held",
    );
    assert.equal(seen.length, 0);
    assert.equal(
      (await fetch(origin, { method: "POST", body: prompt("other") })).status,
      202,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].params._meta["antnest.dev/intent"].intentId, "other");
    interrupted.abort();
    await blocked;
    await fetch(`${origin}/__fault/disarm`, { method: "POST" });
    assert.equal(
      (await fetch(origin, { method: "POST", body: prompt("held") })).status,
      202,
    );
    assert.equal(seen.length, 2);
    const stream = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
    assert.equal(
      stream.status,
      200,
      "SSE headers must reach the Bridge before the first event",
    );
    await stream.body.cancel();
  } finally {
    gate.closeAllConnections();
    gate.close();
    upstream.closeAllConnections();
    upstream.close();
    await Promise.all([once(gate, "close"), once(upstream, "close")]);
  }
});

test("ACP gate closes downstream SSE when the producer dies", async () => {
  let producerStream;
  const upstream = createServer((_request, response) => {
    producerStream = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gate = createAcpGate(`http://127.0.0.1:${upstream.address().port}`);
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  try {
    const stream = await fetch(`http://127.0.0.1:${gate.address().port}`);
    assert.equal(stream.status, 200);
    producerStream.destroy();
    await Promise.race([
      stream.body
        .getReader()
        .read()
        .catch(() => undefined),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("SSE producer close was hidden")),
          500,
        ),
      ),
    ]);
  } finally {
    gate.closeAllConnections();
    gate.close();
    upstream.closeAllConnections();
    upstream.close();
    await Promise.all([once(gate, "close"), once(upstream, "close")]);
  }
});
