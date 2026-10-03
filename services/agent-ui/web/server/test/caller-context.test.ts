import assert from "node:assert/strict";
import { test } from "node:test";
import { CallerContextVerifier } from "../src/adapters/caller-context.ts";
import { testContext, testJwks } from "./support/auth-fixture.ts";

test("malformed context makes no Identity request; expired trust cannot fall back during an outage", async () => {
  let now = Date.now(); let requests = 0; let offline = false;
  const verifier = new CallerContextVerifier("http://identity.invalid/", async () => {
    requests++; if (offline) throw new Error("offline"); return Response.json(testJwks);
  }, () => now);
  await assert.rejects(verifier.verify("bad", { agent: "agent" }), { code: "caller_context_invalid" });
  assert.equal(requests, 0);
  const context = testContext({ agt: "agent" });
  assert.equal((await verifier.verify(context.token, { agent: "agent" })).agt, "agent");
  await verifier.verify(context.token, { agent: "agent" }); assert.equal(requests, 1);
  now += 30001; offline = true;
  await assert.rejects(verifier.verify(context.token, { agent: "agent" }), { code: "identity_dependency_unavailable" });
  assert.equal(requests, 2);
});
test("key response limits and opaque Unicode identities use the frozen contract", async () => {
  const token = testContext({ agt: "agent" }).token;
  await assert.rejects(new CallerContextVerifier("http://identity.invalid/", async () => new Response("x".repeat(16385)))
    .verify(token, { agent: "agent" }), { code: "identity_dependency_unavailable" });
  const verifier = new CallerContextVerifier("http://identity.invalid/", async () => Response.json(testJwks));
  const subject = "😀".repeat(200);
  assert.equal((await verifier.verify(testContext({ sub: subject, agt: "agent" }).token, { agent: "agent" })).sub, subject);
  await assert.rejects(verifier.verify(testContext({ sub: subject + "a", agt: "agent" }).token,
    { agent: "agent" }), { code: "caller_context_invalid" });
});
