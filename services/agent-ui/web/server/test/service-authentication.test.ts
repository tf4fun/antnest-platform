import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { ServiceAuthentication, parseReceiver, validateToken, authenticateFields, validateMode } from "../src/adapters/service-authentication.ts";
import { parseKeys, verifyCallerContext } from "../src/adapters/caller-context.ts";
import { testSecurityEnvironment } from "./support/auth-fixture.ts";

const tokens = JSON.parse(readFileSync(new URL("../../../../../contracts/platform/service-token-fixtures.json", import.meta.url), "utf8"));
for (const v of tokens.configuration_vectors) test(`receiver: ${v.name}`, () => {
  const operation = () => parseReceiver(v.receiver, Buffer.from(v.callers_json), v.self_allowed);
  if (v.valid) assert.doesNotThrow(operation); else assert.throws(operation);
});
for (const v of tokens.token_vectors) test(`token: ${v.name}`, () => assert.equal(validateToken(v.token), v.valid));
for (const v of tokens.header_vectors) test(`header: ${v.name}`, () => {
  const receiver = parseReceiver("runtime-controller", Buffer.from(JSON.stringify(tokens.receiver_configurations[v.configuration])));
  assert.deepEqual(authenticateFields(receiver, v.fields, v.allowed_callers), v.expected);
});
for (const v of tokens.mode_vectors) test(`mode: ${v.name}`, () => {
  const operation = () => validateMode(v.mode ?? undefined, v.allow_insecure_transport ?? undefined, v.transport);
  if (v.valid) assert.doesNotThrow(operation); else assert.throws(operation);
});
const contexts = JSON.parse(readFileSync(new URL("../../../../../contracts/platform/caller-context-fixtures.json", import.meta.url), "utf8"));
for (const v of contexts.verification_vectors) test(`signed CCT: ${v.name}`, async () => {
  const keys = await parseKeys(Buffer.from(JSON.stringify(contexts.jwks)));
  const promise = verifyCallerContext(v.token, keys, { consumer: v.consumer, organization: v.organization,
    agent: v.agent ?? undefined, now: v.now, tolerance: v.tolerance });
  if (v.valid) assert.ok((await promise).sub); else await assert.rejects(promise);
});
test("a caller abort closes a streaming dependency response after garbage collection", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
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
    const response = await workload.fetchFor("agent-acp-service", origin)(origin, { signal: caller.signal });
    assert.equal(response.status, 200);
    for (let round = 0; round < 3; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      collect();
    }
    caller.abort(new Error("cancelled"));
    assert.equal(await Promise.race([
      disconnected.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000)),
    ]), "closed");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await workload.close();
  }
});
