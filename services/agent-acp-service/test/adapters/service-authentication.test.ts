import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  ServiceAuthentication,
  parseReceiver,
  validateToken,
  validateMode,
  authenticateFields,
} from "../../src/adapters/service-authentication.js";
import { parseKeys, verifyCallerContext } from "../../src/adapters/caller-context.js";
import { testSecurityEnvironment } from "../support/auth-fixture.js";

const tokens = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/platform/service-token-fixtures.json", import.meta.url),
    "utf8",
  ),
) as {
  receiver_configurations: Record<string, Record<string, string[]>>;
  configuration_vectors: {
    name: string;
    receiver: string;
    self_allowed: boolean;
    callers_json: string;
    valid: boolean;
  }[];
  token_vectors: { name: string; token: string; valid: boolean }[];
  header_vectors: {
    name: string;
    configuration: string;
    allowed_callers: string[];
    fields: { name: string; value: string }[];
    expected: {
      code: string | null;
      http_status: number;
      caller: string | null;
      www_authenticate: string | null;
    };
  }[];
  mode_vectors: {
    name: string;
    mode: string | null;
    allow_insecure_transport: string | null;
    transport: "http" | "https";
    valid: boolean;
  }[];
};
describe("shared token conformance", () => {
  it.each(tokens.configuration_vectors)("receiver: $name", (v) => {
    const operation = () => parseReceiver(v.receiver, Buffer.from(v.callers_json), v.self_allowed);
    if (v.valid) expect(operation).not.toThrow();
    else expect(operation).toThrow();
  });
  it.each(tokens.token_vectors)("token: $name", (v) => {
    expect(validateToken(v.token)).toBe(v.valid);
  });
  it.each(tokens.header_vectors)("header: $name", (v) => {
    const receiver = parseReceiver(
      "runtime-controller",
      Buffer.from(JSON.stringify(tokens.receiver_configurations[v.configuration])),
    );
    expect(authenticateFields(receiver, v.fields, v.allowed_callers)).toEqual(v.expected);
  });
  it.each(tokens.mode_vectors)("mode: $name", (v) => {
    const operation = () =>
      validateMode(v.mode ?? undefined, v.allow_insecure_transport ?? undefined, v.transport);
    if (v.valid) expect(operation).not.toThrow();
    else expect(operation).toThrow();
  });
});
const contexts = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/platform/caller-context-fixtures.json", import.meta.url),
    "utf8",
  ),
) as {
  jwks: unknown;
  verification_vectors: {
    name: string;
    token: string;
    now: number;
    tolerance: number;
    consumer: string;
    organization: string;
    agent: string | null;
    valid: boolean;
  }[];
};
describe("shared signed CCT conformance", () => {
  it.each(contexts.verification_vectors)("$name", async (v) => {
    const keys = await parseKeys(Buffer.from(JSON.stringify(contexts.jwks)));
    const promise = verifyCallerContext(v.token, keys, {
      consumer: v.consumer,
      organization: v.organization,
      agent: v.agent ?? undefined,
      now: v.now,
      tolerance: v.tolerance,
    });
    if (v.valid) await expect(promise).resolves.toHaveProperty("sub");
    else await expect(promise).rejects.toThrow();
  });
});
describe("authenticated dependency fetch", () => {
  it("closes a streaming dependency response when the caller aborts after garbage collection", async () => {
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => (closed = resolve));
    const server = createServer((_request, response) => {
      response.on("close", closed);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: open\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const workload = new ServiceAuthentication(testSecurityEnvironment());
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const caller = new AbortController();
      const response = await workload.fetchFor("identity-service", origin)(origin, {
        signal: caller.signal,
      });
      expect(response.status).toBe(200);
      for (let round = 0; round < 3; round++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        collect();
      }
      caller.abort(new Error("cancelled"));
      await expect(
        Promise.race([
          disconnected.then(() => "closed"),
          new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000)),
        ]),
      ).resolves.toBe("closed");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await workload.close();
    }
  });
});
