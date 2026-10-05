import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { ServiceAuthentication } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import { testSecurityEnvironment } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";

it("rereads outgoing tokens, refuses stale fallback, pins the receiver and does not forward a redirect", async () => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(String(request.headers["antnest-service-authorization"]));
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "http://untrusted.invalid/" });
      response.end();
    } else {
      response.end("ok");
    }
  });
  const environment = testSecurityEnvironment();
  const authentication = new ServiceAuthentication(environment);
  const path = join(
    environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR,
    "skill-registry",
  );
  const original = readFileSync(path, "utf8");
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const base = `http://127.0.0.1:${address.port}`;
    const fetcher = authentication.fetchFor("skill-registry", base);
    let response: Response;
    try {
      response = await fetcher(base);
    } catch (error) {
      throw new Error(
        `Authenticated fetch failed: ${error instanceof Error ? error.message : "unknown"}; cause: ${error instanceof Error && error.cause instanceof Error ? error.cause.message : "none"}`,
        { cause: error },
      );
    }
    expect(await response.text()).toBe("ok");
    const next = randomBytes(32).toString("base64url");
    writeFileSync(path + ".next", next, { mode: 0o600 });
    renameSync(path + ".next", path);
    expect(await (await fetcher(base)).text()).toBe("ok");
    expect(received).toEqual([`Bearer ${original}`, `Bearer ${next}`]);
    writeFileSync(path, next + "\n");
    await expect(fetcher(base)).rejects.toThrow("service_credential_invalid");
    expect(received).toHaveLength(2);
    writeFileSync(path, next);
    await expect(fetcher("http://untrusted.invalid/")).rejects.toThrow(
      "dependency_origin_invalid",
    );
    await expect(fetcher(base + "/redirect")).rejects.toThrow();
    expect(received).toHaveLength(3);
  } finally {
    writeFileSync(path, original);
    await authentication.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
