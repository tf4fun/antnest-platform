import { createServer, request as httpRequest } from "node:http";

export function createAcpGate(upstreamBase) {
  const upstream = new URL(upstreamBase);
  let armedIntent = null;
  let heldIntent = null;
  let forwardedPrompts = 0;
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === "/__fault/state" && incoming.method === "GET") {
      return json(outgoing, 200, { armedIntent, heldIntent, forwardedPrompts });
    }
    if (incoming.url === "/__fault/arm" && incoming.method === "POST") {
      const body = await readBody(incoming, 1024);
      const intentId = JSON.parse(body.toString()).intentId;
      if (typeof intentId !== "string" || !intentId || intentId.length > 200)
        return json(outgoing, 400, { error: "invalid intent" });
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
      return forward(incoming, outgoing, upstream);
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
    if (message?.method === "session/prompt") {
      const intentId = message.params?._meta?.["antnest.dev/intent"]?.intentId;
      if (armedIntent !== null && intentId === armedIntent) {
        heldIntent = intentId;
        return;
      }
      forwardedPrompts++;
    }
    forward(incoming, outgoing, upstream, body);
  });
  return server;
}

function forward(incoming, outgoing, upstream, body) {
  const target = new URL(incoming.url ?? "/", upstream);
  const proxied = httpRequest(
    target,
    {
      method: incoming.method,
      headers: { ...incoming.headers, host: target.host },
    },
    (response) => {
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
