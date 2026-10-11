import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createTestWorkspaceHttpServer, testContext, workloadHeaders } from "./support/auth-fixture.ts";
import { createEventHandler } from "../src/http/event-routes.ts";
import { StreamJournal } from "../src/bridge/stream-journal.ts";

const path = "/api/app/workspace/v1/agents/agent-1/events";
const credentials = () => {
  const context = testContext({ agt: "agent-1", exp: Math.ceil(Date.now() / 1000) + 1 });
  return { context, headers: { ...workloadHeaders(), "Antnest-Caller-Context": context.token } };
};
async function serve(handle: (request: Request) => Promise<Response | null>, work: (origin: string) => Promise<void>) {
  const server = createTestWorkspaceHttpServer({ handle });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await work(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("quiet Workspace SSE retires the original CCT lease before its downstream acceptance expires", async () => {
  const journal = new StreamJournal({ scope: { organizationId: "org-1", principalId: "user-1", agentId: "agent-1" },
    sessionId: null, epoch: "epoch-1", projectionId: "projection-1", key: Buffer.alloc(32, 7) });
  let released = 0;
  const handler = createEventHandler({ async subscribe() {
    return { events: journal.subscribe(null, cursor => ({ streamCursor: cursor })), release() { released++; } };
  } });
  try {
    await serve(handler, async origin => {
      const { context, headers } = credentials();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(origin + path, { headers, signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        assert.equal((await reader.read()).done, false);
        // A quiet transport must close without relying on the next 15-second
        // heartbeat, browser input, a journal update, or the Gateway's 5m lease.
        const ended = await reader.read().then(part => part.done, () => !controller.signal.aborted);
        assert(ended, "the original delegation remained open beyond expiry");
        assert(Date.now() >= context.claims.exp * 1000, "the valid stream must not be retired early");
        assert(Date.now() <= context.claims.exp * 1000 + 1000);
        assert.equal(released, 1);
      } finally { clearTimeout(timer); controller.abort(); }
    });
  } finally { journal.close(); }
});

test("CCT retirement aborts a Workspace SSE writer blocked by native TCP backpressure", async () => {
  let aborted = false, cancelled = false, writes = 0;
  await serve(async request => {
    request.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { writes++; controller.enqueue(new Uint8Array(4 * 1024 * 1024)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  }, async origin => {
    const { context, headers } = credentials();
    const request = get(origin + path, { headers });
    request.on("error", () => {});
    let response: import("node:http").IncomingMessage | undefined;
    try {
      [response] = await once(request, "response");
      assert.equal(response!.statusCode, 200);
      response!.pause();
      await delay(Math.max(0, context.claims.exp * 1000 - Date.now()) + 150);
      assert(aborted, "native blocked writer must release its authenticated request at expiry");
      assert(cancelled, "blocked stream body must be cancelled");
      assert(writes < 8, "the native adapter must exert backpressure before retirement");
    } finally { response?.destroy(); request.destroy(); }
  });
});

test("a subscription that resolves after CCT expiry is disposed without a logout response", async () => {
  let complete!: (response: Response) => void;
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const subscription = new Promise<Response>(resolve => { complete = resolve; });
  let cancelled = false, observed = 0;
  await serve(async () => { observed++; admitted(); return subscription; }, async origin => {
    const { context, headers } = credentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const pending = fetch(origin + path, { headers, signal: controller.signal }).then(response => response.status, () => "transport_closed");
    try {
      await Promise.race([admission, pending.then(status => { throw new Error(`Subscription ended before admission: ${status}`); })]);
      await delay(Math.max(0, context.claims.exp * 1000 - Date.now()) + 150);
      complete(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
      const status = await pending;
      assert(!controller.signal.aborted, "expiry must settle a delayed subscription independently of the client deadline");
      assert(status === "transport_closed" || status === 503, "delegation renewal must not masquerade as account expiration or publish stale 200");
      await delay(0);
      assert(cancelled, "a late subscription must release its body");
      assert.equal(observed, 1);
    } finally { clearTimeout(timer); controller.abort(); complete(new Response()); }
  });
});
