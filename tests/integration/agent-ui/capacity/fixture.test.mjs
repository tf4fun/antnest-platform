import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../../../services/agent-ui/web/server/test/support/auth-fixture.mjs";
import { AcpHttpBridge } from "../../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { ServiceAuthentication } from "../../../../services/agent-ui/web/server/dist/adapters/service-authentication.js";
import { bindScopeContext } from "../../../../services/agent-ui/web/server/dist/http/trusted-identity.js";
import { startFixture } from "./process.mjs";

const authentication = await createAuthFixture({ built: true });
async function heldFixture(t) {
  const cleanup = [];
  let expectedFailure = false;
  t.after(async () => {
    const unexpected = [];
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        if (
          expectedFailure &&
          /Capacity fixture reported an internal failure/u.test(error.message)
        )
          expectedFailure = false;
        else unexpected.push(error);
      }
    }
    assert.equal(
      expectedFailure,
      false,
      "fixture validation failure must survive cleanup",
    );
    if (unexpected.length)
      throw new AggregateError(unexpected, "Fixture-negative cleanup failed");
  });
  const scope = {
    organizationId: "fixture-org",
    principalId: "user-b",
    agentId: "agent-b",
  };
  const context = authentication.context({
    org: scope.organizationId,
    sub: scope.principalId,
    agt: scope.agentId,
  });
  bindScopeContext(scope, context);
  const identity = {
    ...scope,
    token: context.token,
    sessionId: "session-b",
    publicScope: scope,
  };
  const upstream = await startFixture(
    {
      role: "upstream",
      identities: [identity],
      environment: authentication.securityEnvironment(),
    },
    cleanup,
  );
  const workload = new ServiceAuthentication(
    authentication.securityEnvironment(),
  );
  cleanup.push(() => workload.close());
  const connection = await AcpHttpBridge.open({
    scope,
    baseUrl: new URL(upstream.origin),
    fetchImpl: workload.fetchFor("agent-acp-service", upstream.origin),
    callbacks: {
      update: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    },
  });
  const pending = [];
  cleanup.push(async () => {
    connection.close();
    await Promise.all(pending);
  });
  const input = {
    sessionId: "session-b",
    intentId: "fixture-intent",
    expectedAppendVersion: 0,
    prompt: [{ type: "text", text: "Held fixture work" }],
  };
  const prompt = () => {
    const result = connection.prompt(input).then(
      () => "resolved",
      () => "rejected",
    );
    pending.push(result);
    return result;
  };
  void prompt();
  await upstream.wait("prompt-held");
  return {
    upstream,
    prompt,
    expectFailure: () => {
      expectedFailure = true;
    },
  };
}

test(
  "capacity fixture rejects a second real ACP dispatch instead of hiding its SDK handler error",
  { timeout: 15_000 },
  async (t) => {
    const fixture = await heldFixture(t);
    assert.equal(await fixture.prompt(), "rejected");
    await fixture.upstream.wait("fixture-error", () => true, 1000);
    fixture.expectFailure();
    await assert.rejects(
      fixture.upstream.stop(),
      /Capacity fixture reported an internal failure/u,
    );
    const summary = await fixture.upstream.wait("fixture-summary");
    assert.equal(summary.states[0].promptAttempts, 2);
  },
);

test(
  "capacity fixture SIGTERM releases held work and joins the child with closed stdio",
  { timeout: 15_000 },
  async (t) => {
    const { upstream } = await heldFixture(t);
    assert.ok(upstream.child.kill("SIGTERM"));
    await upstream.wait("stopped");
    await upstream.stop();
    const release = await upstream.wait("held-work-released");
    assert.equal(release.intentId, "fixture-intent");
    assert.equal(
      release.cancellations,
      0,
      "shutdown release must never count as targeted cancellation",
    );
    assert.equal(upstream.child.exitCode, 0);
    assert.equal(upstream.child.connected, false);
  },
);
