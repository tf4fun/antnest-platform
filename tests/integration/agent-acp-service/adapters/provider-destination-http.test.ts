import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { buildConnector } from "undici";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { ProviderDestinationPolicy } from "../../../../services/agent-acp-service/src/adapters/model/destination-policy.js";
import { PinnedProviderTransport } from "../../../../services/agent-acp-service/src/adapters/model/provider-transport.js";
import { snapshot } from "../../../../services/agent-acp-service/test/support/fixtures.js";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  return address.port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
}
function request(baseUrl: string, signal = AbortSignal.timeout(3000)) {
  const source = snapshot();
  source.executionSpec.model.baseUrl = baseUrl;
  return {
    snapshot: source,
    messages: [],
    tools: [],
    credential: "synthetic-provider-secret",
    signal,
  };
}

describe("actual Provider socket boundary", () => {
  it("blocks native model access to a private service before any HTTP request", async () => {
    let calls = 0;
    const server = createServer((_r, w) => {
      calls++;
      w.end("private-service");
    });
    const port = await listen(server);
    try {
      await expect(
        new OpenAICompatibleModel().complete(
          request(`http://127.0.0.1:${port}/v1`),
        ),
      ).rejects.toMatchObject({
        code: "provider_endpoint_forbidden",
        retryable: false,
      });
      expect(calls).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("does not follow a Provider redirect or forward credentials to its target", async () => {
    let calls = 0;
    const server = createServer((r, w) => {
      calls++;
      expect(r.url).toBe("/v1/chat/completions");
      expect(r.headers.authorization).toBe("Bearer synthetic-provider-secret");
      w.writeHead(302, { location: "/private-identity" });
      w.end("synthetic-provider-secret in private-service-response");
    });
    const port = await listen(server);
    try {
      await expect(
        new OpenAICompatibleModel({
          destination: { allowPrivateEndpoints: true },
        }).complete(request(`http://127.0.0.1:${port}/v1`)),
      ).rejects.toMatchObject({
        code: "model_http_error",
        status: 302,
        retryable: false,
        message: "Model API returned HTTP 302",
      });
      expect(calls).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("pins checked addresses without a second DNS lookup and ignores environment proxies", async () => {
    let calls = 0,
      proxyCalls = 0;
    const server = createServer((r, w) => {
      calls++;
      expect(r.headers.host).toBe(`provider.fixture:${port}`);
      expect(r.headers.authorization).toBe("Bearer synthetic-provider-secret");
      for (const name of [
        "antnest-service-authorization",
        "antnest-caller-context",
        "x-antnest-user-id",
        "cookie",
        "baggage",
      ])
        expect(r.headers[name]).toBeUndefined();
      w.end("ok");
    });
    const proxy = createServer((_r, w) => {
      proxyCalls++;
      w.end("proxy");
    });
    const port = await listen(server),
      proxyPort = await listen(proxy);
    const previous = Object.fromEntries(
      ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"].map(
        (key) => [key, process.env[key]],
      ),
    );
    let transport: PinnedProviderTransport | undefined;
    try {
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"])
        process.env[key] = `http://127.0.0.1:${proxyPort}`;
      process.env.NODE_USE_ENV_PROXY = "1";
      const resolve = vi
        .fn()
        .mockResolvedValueOnce(["127.0.0.1", "::1"])
        .mockResolvedValueOnce(["0.0.0.0"]);
      const policy = new ProviderDestinationPolicy({
        allowPrivateEndpoints: true,
        resolve,
      });
      const endpoint = await policy.prepare(
        `http://provider.fixture:${port}/v1/chat/completions`,
        AbortSignal.timeout(3000),
      );
      transport = new PinnedProviderTransport(endpoint);
      const response = await transport.fetch(endpoint.url.toString(), {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(3000),
        headers: {
          Authorization: "Bearer synthetic-provider-secret",
          "Antnest-Service-Authorization": "Bearer private-workload",
          "Antnest-Caller-Context": "private-context",
          "X-Antnest-User-ID": "private-subject",
          Cookie: "browser=private",
          Baggage: "private=content",
        },
      });
      expect(await response.text()).toBe("ok");
      expect(calls).toBe(1);
      expect(proxyCalls).toBe(0);
      expect(resolve).toHaveBeenCalledTimes(1);
      await expect(
        policy.prepare(endpoint.url.toString(), AbortSignal.timeout(3000)),
      ).rejects.toMatchObject({ code: "provider_endpoint_forbidden" });
      expect(calls).toBe(1);
    } finally {
      await transport?.close();
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await close(server);
      await close(proxy);
    }
  });

  it("verifies the original TLS hostname and SNI when dialing the checked literal IP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "antnest-provider-tls-"));
    let server: Server | undefined;
    const transports: PinnedProviderTransport[] = [];
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-subj",
          "/CN=provider.fixture",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:provider.fixture",
          "-keyout",
          "key.pem",
          "-out",
          "cert.pem",
        ],
        { cwd: directory, timeout: 10000, stdio: "pipe" },
      );
      const cert = readFileSync(join(directory, "cert.pem"));
      let calls = 0;
      server = createHttpsServer(
        { key: readFileSync(join(directory, "key.pem")), cert },
        (r, w) => {
          calls++;
          expect(r.headers.host).toBe(`provider.fixture:${port}`);
          expect((r.socket as TLSSocket).servername).toBe("provider.fixture");
          expect(r.headers.authorization).toBe(
            "Bearer synthetic-provider-secret",
          );
          w.end("ok");
        },
      );
      const port = await listen(server);
      const resolve = vi.fn(() => Promise.resolve(["127.0.0.1"]));
      const policy = new ProviderDestinationPolicy({
        allowPrivateEndpoints: true,
        resolve,
      });
      for (const hostname of ["provider.fixture", "wrong.fixture"]) {
        const endpoint = await policy.prepare(
          `https://${hostname}:${port}/models`,
          AbortSignal.timeout(3000),
        );
        const transport = new PinnedProviderTransport(
          endpoint,
          buildConnector({ ca: cert, timeout: 1000 }),
        );
        transports.push(transport);
        const operation = transport.fetch(endpoint.url.toString(), {
          method: "GET",
          headers: { Authorization: "Bearer synthetic-provider-secret" },
          signal: AbortSignal.timeout(3000),
        });
        if (hostname === "provider.fixture")
          expect(await (await operation).text()).toBe("ok");
        else await expect(operation).rejects.toThrow();
      }
      expect(calls).toBe(1);
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      for (const transport of transports) await transport.close();
      if (server) await close(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the dispatcher alive through SSE, then closes the completed connection", async () => {
    const disconnected = Promise.withResolvers<void>();
    const server = createServer((r, w) => {
      r.socket.once("close", () => disconnected.resolve());
      w.writeHead(200, { "content-type": "text/event-stream" });
      w.end(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      );
    });
    const port = await listen(server);
    try {
      const result = await new OpenAICompatibleModel({
        destination: { allowPrivateEndpoints: true },
      }).complete(request(`http://127.0.0.1:${port}/v1`));
      expect(result).toMatchObject({
        kind: "message",
        content: [{ type: "text", text: "ok" }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      await disconnected.promise;
    } finally {
      await close(server);
    }
  });

  it("cancels a stalled stream and releases its Provider connection", async () => {
    const started = Promise.withResolvers<void>(),
      disconnected = Promise.withResolvers<void>();
    const server = createServer((r, w) => {
      r.socket.once("close", () => disconnected.resolve());
      w.writeHead(200, { "content-type": "text/event-stream" });
      w.flushHeaders();
      started.resolve();
    });
    const port = await listen(server);
    const stop = new AbortController();
    try {
      const operation = new OpenAICompatibleModel({
        destination: { allowPrivateEndpoints: true },
      }).complete(request(`http://127.0.0.1:${port}/v1`, stop.signal));
      await started.promise;
      stop.abort();
      await expect(operation).rejects.toThrow();
      await disconnected.promise;
    } finally {
      stop.abort();
      await close(server);
    }
  });
});
