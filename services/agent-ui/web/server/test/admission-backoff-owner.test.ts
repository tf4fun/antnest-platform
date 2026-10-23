import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpPromptError, AgentAccessRevokedError } from "../src/adapters/acp-http.ts";
import { AgentBridgeOwner, type AcpBridgePort } from "../src/bridge/agent-owner.ts";

const catalog = JSON.parse(readFileSync(new URL(
  "../../../../../contracts/agent-acp/errors.json", import.meta.url,
), "utf8")) as { errors: Record<string, { json_rpc_code: number; message: string; retryable: boolean; retry_after_ms: number }> };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const stage of ["wait", "query"] as const) {
  test(`owner access revocation stops an automatic ${stage} and joins the actual dependency`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const watched = Promise.withResolvers<void>();
    const queried = Promise.withResolvers<{ kind: "unknown" }>();
    void watched.promise.catch(() => {});
    let calls = 0, queries = 0, active = 0, querySignal: AbortSignal | undefined;
    let queryJoined = false;
    const busy = catalog.errors.agent_busy!;
    const input = { sessionId: "session-owner-backoff", intentId: "intent-owner-backoff",
      expectedAppendVersion: 0, prompt: [{ type: "text" as const, text: "original" }] };
    const port: AcpBridgePort = {
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 0, outputWatermark: 0,
        activeRunId: null, recentReceipts: [], configurationRevision: null }; },
      watchAgentExecutionState: async () => watched.promise,
      async prompt() {
        calls++;
        throw new AcpPromptError(new RequestError(busy.json_rpc_code, busy.message,
          { code: "agent_busy", retryable: busy.retryable, retry_after_ms: busy.retry_after_ms }), 1);
      },
      async readIntent(_session, _intent, signal) {
        queries++;
        querySignal = signal;
        try { return await queried.promise; } finally { queryJoined = true; }
      },
      async cancel() {},
      close() {},
    };
    const owner = await AgentBridgeOwner.open({
      scope: { organizationId: "org", principalId: "principal", agentId: "agent" },
      retainWork() { active++; return () => { active--; }; },
      connect: async () => port,
    });
    let joining: Promise<void> | undefined;
    try {
      owner.operations.submit(input);
      await turn();
      assert.equal(calls, 1);
      if (stage === "query") {
        t.mock.timers.tick(1000);
        await turn();
        assert.equal(queries, 1);
        assert.equal(queryJoined, false);
      }
      watched.reject(new AgentAccessRevokedError());
      await turn();
      if (stage === "query") assert.equal(querySignal?.aborted, true);
      else {
        t.mock.timers.tick(1000);
        await turn();
        assert.equal(queries, 0, "known revocation must cancel the pending automatic timer");
      }
      let joined = false;
      joining = owner.operations.joinRetryDecisions().then(() => { joined = true; });
      await turn();
      if (stage === "query") {
        assert.equal(joined, false, "revocation cannot substitute for actual query settlement");
        assert.equal(active, 1);
      }
      queried.resolve({ kind: "unknown" });
      t.mock.timers.tick(30000);
      await joining;
      assert.equal(calls, 1, "a revoked owner must not automatically send again");
      assert.equal(queries, stage === "query" ? 1 : 0);
      assert.equal(active, 0);
    } finally {
      void owner.beginDrain();
      watched.resolve();
      queried.resolve({ kind: "unknown" });
      t.mock.timers.tick(120000);
      await Promise.allSettled([...(joining ? [joining] : []), owner.close(),
        owner.operations.settled(input.sessionId, input.intentId)]);
      t.mock.timers.reset();
      assert.equal(active, 0);
    }
  });
}
