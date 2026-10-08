import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeConnections } from "../../../../services/agent-acp-service/src/adapters/runtime-connections.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

type RequestFact = {
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
};
type HttpPeer = {
  url: string;
  facts: RequestFact[];
  arrived: Promise<void>;
  close(): Promise<void>;
};
describe("private Runtime transport over HTTP", () => {
  const connections: RuntimeConnections[] = [];
  const peers: HttpPeer[] = [];
  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      await connection.close();
      expect(existsSync(connection.directory)).toBe(false);
    }
    for (const fixture of peers.splice(0)) await fixture.close();
    vi.unstubAllEnvs();
  });
  async function peer(
    respond: (request: IncomingMessage, response: ServerResponse) => void = (
      _request,
      response,
    ) => response.end("ok"),
  ): Promise<HttpPeer> {
    const facts: RequestFact[] = [];
    const arrived = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        facts.push({
          path: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        arrived.resolve();
        respond(request, response);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture did not listen");
    const fixture = {
      url: "http://127.0.0.1:" + address.port,
      facts,
      arrived: arrived.promise,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    };
    peers.push(fixture);
    return fixture;
  }
  function install(origin: string) {
    const authority = new RuntimeConnections({
      authMode: "token",
      allowInsecureTransport: "true",
    });
    connections.push(authority);
    const configuration = executionConfiguration();
    const token = randomBytes(32).toString("base64url");
    configuration.agents[0]!.runtime!.mcp_endpoint = origin + "/mcp";
    configuration.agents[0]!.runtime!.credential!.token = token;
    authority.prepare(parseExecutionConfiguration(configuration)).commit();
    const binding = resolveExecutionConfiguration(
      publicExecutionConfiguration(configuration),
      executionIdentity(),
      {},
    ).runtime;
    return { authority, binding, token, send: authority.fetchFor(binding) };
  }

  it("authenticates every Runtime consumer path while preserving tickets and protocol fences", async () => {
    const fixture = await peer();
    const { send, token, binding } = install(fixture.url);
    const paths = [
      "/mcp",
      "/status",
      ...["install", "digest"].map(
        (action) => "/internal/skill-maintenance/" + action,
      ),
      "/internal/skill-temporary/install",
      "/internal/skill-temporary/release",
    ];
    for (const path of paths) {
      const response = await send(fixture.url + path, {
        method: path === "/status" ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: path.startsWith("/internal/")
            ? "AntnestMaintenance a.b.c"
            : "Bearer unrelated-user-key",
          Cookie: "session=unrelated-user-key",
          "Antnest-Caller-Context": "unrelated-context",
          "Antnest-Service-Authorization": "Bearer unrelated-service-key",
          "MCP-Protocol-Version": "2026-07-28",
          "MCP-Session-ID": "session-1",
          "X-Antnest-Expected-Execution-ID": "forged-fence",
        },
        ...(path === "/status" ? {} : { body: "{}" }),
        signal: AbortSignal.timeout(5000),
      });
      expect(await response.text()).toBe("ok");
    }
    expect(fixture.facts.map((fact) => fact.path)).toEqual(paths);
    for (const fact of fixture.facts) {
      expect(fact.headers["antnest-service-authorization"]).toBe(
        "Bearer " + token,
      );
      expect(fact.headers["x-antnest-expected-execution-id"]).toBe(
        binding.executionId,
      );
      expect(fact.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(fact.headers["authorization"]).toBe(
        fact.path.startsWith("/internal/")
          ? "AntnestMaintenance a.b.c"
          : undefined,
      );
      expect(fact.headers["cookie"]).toBeUndefined();
      expect(fact.headers["antnest-caller-context"]).toBeUndefined();
    }
  });

  it("does not follow a redirect to another Runtime or leak its instance token", async () => {
    const target = await peer();
    const redirector = await peer((_request, response) => {
      response.writeHead(307, { Location: target.url + "/mcp" });
      response.end();
    });
    const { send, binding } = install(redirector.url);
    await expect(
      send(binding.mcpEndpoint, { signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow();
    expect(redirector.facts).toHaveLength(1);
    expect(target.facts).toEqual([]);
  });

  it("bypasses all environment proxies and re-reads the sender file before each request", async () => {
    const proxy = await peer();
    const fixture = await peer();
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ])
      vi.stubEnv(name, proxy.url);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    const { authority, send, binding } = install(fixture.url);
    expect(
      await (
        await send(binding.mcpEndpoint, { signal: AbortSignal.timeout(5000) })
      ).text(),
    ).toBe("ok");
    const path = join(
      authority.directory,
      binding.connectionId,
      "antnest-runtime",
    );
    writeFileSync(path, randomBytes(32).toString("base64url"));
    await expect(send(binding.mcpEndpoint)).rejects.toMatchObject({
      code: "runtime_connection_unavailable",
    });
    unlinkSync(path);
    await expect(send(binding.mcpEndpoint)).rejects.toMatchObject({
      code: "runtime_connection_unavailable",
    });
    expect(fixture.facts).toHaveLength(1);
    expect(proxy.facts).toEqual([]);
  });

  it("cancels an outstanding HTTP request and shuts down its owned connection", async () => {
    const fixture = await peer(() => {
      /* Deliberately keep the response pending. */
    });
    const { send, binding } = install(fixture.url);
    const cancellation = new AbortController();
    const pending = send(binding.mcpEndpoint, { signal: cancellation.signal });
    // Attach a rejection observer before the explicit cancellation.
    const result = expect(pending).rejects.toThrow();
    await fixture.arrived;
    cancellation.abort(new Error("Fixture cancellation"));
    await result;
  });

  it("preserves multipart bytes and the separate temporary-skill ticket", async () => {
    const fixture = await peer();
    const { send } = install(fixture.url);
    const body = Buffer.concat([
      Buffer.from("--fixture\r\n"),
      randomBytes(65536),
      Buffer.from("\r\n--fixture--\r\n"),
    ]);
    const response = await send(
      fixture.url + "/internal/skill-temporary/install",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "multipart/form-data; boundary=fixture",
          Authorization: "AntnestMaintenance a.b.c",
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    await response.text();
    expect(fixture.facts[0]!.body).toEqual(body);
    expect(fixture.facts[0]!.headers["content-type"]).toBe(
      "multipart/form-data; boundary=fixture",
    );
    expect(fixture.facts[0]!.headers.authorization).toBe(
      "AntnestMaintenance a.b.c",
    );
  });
});
