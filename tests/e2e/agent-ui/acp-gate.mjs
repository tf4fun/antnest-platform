import { createServer, request as httpRequest } from "node:http";

export function createAcpGate(
  upstreamBase,
  { capture = false, maxCaptureBytes = 1_048_576 } = {},
) {
  const upstream = new URL(upstreamBase);
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 0)
    throw new Error("invalid capture budget");
  let armedIntent = null;
  let heldIntent = null;
  let forwardedPrompts = 0;
  const held = new Set();
  const forwardedByIntent = Object.create(null);
  const records = [];
  const captureErrors = [];
  let remainingCaptureBytes = maxCaptureBytes;
  let captureExhausted = false;
  const captureBytes = (bytes) => {
    if (captureExhausted || bytes.length > remainingCaptureBytes) {
      if (!captureExhausted)
        captureErrors.push("ACP wire capture byte budget exceeded");
      captureExhausted = true;
      remainingCaptureBytes = 0;
      return null;
    }
    remainingCaptureBytes -= bytes.length;
    return bytes;
  };
  const recordRequest = (incoming, body) => {
    if (!capture) return undefined;
    const captured = body === undefined ? undefined : captureBytes(body);
    const record = {
      method: incoming.method,
      path: incoming.url ?? "/",
      body: captured?.toString("utf8") ?? null,
      forwarded: false,
      response: null,
    };
    records.push(record);
    return record;
  };
  const send = (incoming, outgoing, body, message, record) => {
    if (outgoing.destroyed || outgoing.writableEnded) return;
    if (message?.method === "session/prompt") {
      forwardedPrompts++;
      const intentId = message.params?._meta?.["antnest.dev/intent"]?.intentId;
      if (typeof intentId === "string")
        forwardedByIntent[intentId] = (forwardedByIntent[intentId] ?? 0) + 1;
    }
    if (record) record.forwarded = true;
    forward(incoming, outgoing, upstream, body, record, captureBytes);
  };
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === "/__fault/state" && incoming.method === "GET") {
      return json(outgoing, 200, {
        armedIntent,
        heldIntent,
        heldRequests: held.size,
        forwardedPrompts,
        forwardedByIntent,
        records,
        captureErrors,
      });
    }
    if (
      (incoming.url === "/__fault/arm" ||
        incoming.url === "/__fault/release") &&
      incoming.method === "POST"
    ) {
      let intentId;
      try {
        const body = await readBody(incoming, 1024);
        intentId = JSON.parse(body.toString()).intentId;
      } catch {
        return json(outgoing, 400, { error: "invalid intent" });
      }
      if (typeof intentId !== "string" || !intentId || intentId.length > 200)
        return json(outgoing, 400, { error: "invalid intent" });
      if (incoming.url === "/__fault/release") {
        let released = 0;
        for (const request of held) {
          if (request.intentId !== intentId) continue;
          held.delete(request);
          if (request.outgoing.destroyed || request.outgoing.writableEnded)
            continue;
          request.forward();
          released++;
        }
        if (armedIntent === intentId) armedIntent = null;
        return json(outgoing, released ? 200 : 409, { released });
      }
      armedIntent = intentId;
      heldIntent = null;
      return json(outgoing, 200, { armedIntent });
    }
    if (incoming.url === "/__fault/disarm" && incoming.method === "POST") {
      armedIntent = null;
      return json(outgoing, 200, { heldIntent });
    }
    if (incoming.url?.startsWith("/__fault/"))
      return json(outgoing, 404, { error: "unknown control" });

    if (incoming.method !== "POST")
      return send(
        incoming,
        outgoing,
        undefined,
        undefined,
        recordRequest(incoming),
      );
    let body;
    try {
      body = await readBody(incoming, 20 * 1024 * 1024);
    } catch {
      return json(outgoing, 413, { error: "request too large" });
    }
    let message;
    try {
      message = JSON.parse(body.toString());
    } catch {
      /* Forward malformed RPC. */
    }
    const record = recordRequest(incoming, body);
    if (message?.method === "session/prompt") {
      const intentId = message.params?._meta?.["antnest.dev/intent"]?.intentId;
      if (armedIntent !== null && intentId === armedIntent) {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        heldIntent = intentId;
        const request = {
          intentId,
          outgoing,
          forward: () => send(incoming, outgoing, body, message, record),
        };
        held.add(request);
        outgoing.once("close", () => held.delete(request));
        return;
      }
    }
    send(incoming, outgoing, body, message, record);
  });
  return server;
}

function forward(incoming, outgoing, upstream, body, record, captureBytes) {
  const target = new URL(incoming.url ?? "/", upstream);
  const proxied = httpRequest(
    target,
    {
      method: incoming.method,
      headers: { ...incoming.headers, host: target.host },
    },
    (response) => {
      if (record) {
        const captured = {
          statusCode: response.statusCode ?? 502,
          contentType: response.headers["content-type"] ?? null,
          chunks: [],
          complete: false,
          closed: false,
        };
        record.response = captured;
        let truncated = false;
        response.on("data", (chunk) => {
          const bytes = captureBytes(chunk);
          if (bytes === null) truncated = true;
          else captured.chunks.push(bytes.toString("base64"));
        });
        response.once("end", () => {
          captured.complete = response.complete && !truncated;
        });
        response.once("close", () => {
          captured.closed = true;
        });
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      outgoing.flushHeaders();
      response.on("close", () => {
        if (!response.complete) outgoing.destroy();
      });
      response.pipe(outgoing);
    },
  );
  proxied.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  outgoing.on("close", () => proxied.destroy());
  if (body === undefined) incoming.pipe(proxied);
  else proxied.end(body);
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = createAcpGate("http://agent-acp-service:8080");
  server.listen(8080, "0.0.0.0");
}
