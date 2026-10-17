import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { createWorkspaceHttpServer } from "../src/http/node-server.ts";
import { readBody } from "../src/http/command-routes.ts";
import { testAuthentication, workloadHeaders, testContext } from "./support/auth-fixture.ts";

const mib = 1024 * 1024;
type Result = { status: number; body: { code?: string }; headers: Record<string, unknown> };

async function fixture(work: (input: {
  start(user: string, agent: string, bytes?: number, body?: string, action?: string): Promise<{
    response: Promise<Result>; close(): Promise<void>;
  }>;
  calls(): number;
  releaseDispatch(): void;
}) => Promise<void>, requestDeadlineMs = 2000, beforeAuthenticate?: (request: IncomingMessage) => Promise<void>) {
  let calls = 0;
  const dispatch = Promise.withResolvers<void>();
  const authentication = testAuthentication();
  if (beforeAuthenticate) {
    const admit = authentication.admit.bind(authentication);
    authentication.admit = async (request: IncomingMessage) => {
      await beforeAuthenticate(request);
      return admit(request);
    };
  }
  const server = createWorkspaceHttpServer({
    async handle(request) {
      const body = request.method === "POST" ? await readBody(request) as { hold?: boolean; fail?: boolean } : {};
      calls++;
      if (body.hold) await dispatch.promise;
      if (body.fail) throw new Error("Deliberate dispatch failure");
      return Response.json({ ok: true });
    },
  }, { authentication, requestDeadlineMs });
  const clients: ClientRequest[] = [];
  const closures: Promise<void>[] = [];
  const tasks: Promise<Result>[] = [];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    // Warm the real signed-context verification before observing admissions.
    const headers = (user: string, agent: string) => ({ ...workloadHeaders(),
      "Antnest-Caller-Context": testContext({ sub: user, agt: agent }).token });
    await (await fetch(`${origin}/api/app/workspace/v1/agents/a/view`, { headers: headers("warm", "a") })).body?.cancel();
    calls = 0;
    await work({
      calls: () => calls,
      releaseDispatch: () => dispatch.resolve(),
      async start(user, agent, bytes = 2, body, action = "sessions/s/prompts") {
        const pending = Promise.withResolvers<Result>();
        const consuming = Promise.withResolvers<void>();
        let unobserve = () => {};
        const observe = (incoming: IncomingMessage, outgoing: ServerResponse) => {
          if (incoming.socket.remotePort !== client.socket?.localPort) return;
          server.off("request", observe);
          const resumed = () => {
            // The server acquires the upload budget before consuming the body.
            // Automatic draining after a rejection is not an admission.
            if (!outgoing.headersSent && !outgoing.writableEnded) consuming.resolve();
          };
          incoming.once("resume", resumed);
          unobserve = () => { incoming.off("resume", resumed); };
        };
        server.on("request", observe);
        const client = httpRequest(`${origin}/api/app/workspace/v1/agents/${agent}/${action}`, {
          method: "POST", agent: false,
          headers: { ...headers(user, agent), "content-type": "application/json",
            ...(bytes < 0 ? {} : { "content-length": bytes }) },
        }, async (response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of response) chunks.push(chunk);
            pending.resolve({ status: response.statusCode!, headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()) as Result["body"] });
          } catch { pending.reject(new Error("Upload admission response failed")); }
        });
        const closed = new Promise<void>((resolve) => client.once("close", resolve));
        clients.push(client); closures.push(closed); tasks.push(pending.promise);
        void pending.promise.catch(() => {});
        client.on("error", () => pending.reject(new Error("Upload admission client closed")));
        try {
          if (body === undefined) client.write("{");
          else client.end(body);
          await Promise.race([consuming.promise, pending.promise]);
          return { response: pending.promise, close: async () => { client.destroy(); await closed; } };
        } finally {
          server.off("request", observe);
          unobserve();
        }
      },
    });
  } finally {
    dispatch.resolve();
    for (const client of clients) client.destroy();
    await Promise.all(closures);
    await Promise.allSettled(tasks);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function busy(result: Result) {
  assert.equal(result.status, 429);
  assert.equal(result.body.code, "upload_capacity_exceeded");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["retry-after"], "1");
}

test("four retained prompt bodies share a signed user budget across Agents while both cancel paths stay available", { timeout: 10_000 }, async () => {
  await fixture(async ({ start, calls }) => {
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await start("same-user", `agent-${i}`, 16 * mib));
    busy(await (await start("same-user", "other-agent", 2, "{}")).response);
    assert.equal(calls(), 0, "rejected uploads must have no business dispatch");
    for (const action of ["sessions/s/operations/i/cancel", "commands"]) {
      const body = action === "commands" ? '{"text":"/stop"}' : '{"expectedRunId":"run"}';
      assert.equal((await (await start("same-user", "agent-0", Buffer.byteLength(body), body, action)).response).status, 200);
    }
    assert.equal((await (await start("other-user", "agent-0", 2, "{}")).response).status, 200);
    await held[0]!.close();
    assert.equal((await (await start("same-user", "agent-0", 2, "{}")).response).status, 200);
  });
});

test("aggregate declared and unknown body reservations are bounded and released on disconnect", { timeout: 10_000 }, async () => {
  await fixture(async ({ start, calls }) => {
    const first = await start("one", "a", -1);
    await start("two", "b", 64 * mib);
    busy(await (await start("three", "c", 2, "{}")).response);
    assert.equal(calls(), 0);
    await first.close();
    assert.equal((await (await start("three", "c", 2, "{}")).response).status, 200);
  });
});

test("a user's byte budget rejects before the request count limit", { timeout: 10_000 }, async () => {
  await fixture(async ({ start, calls }) => {
    await start("one", "a", 40 * mib);
    busy(await (await start("one", "another-agent", 40 * mib)).response);
    assert.equal(calls(), 0);
    assert.equal((await (await start("other-user", "a", 2, "{}")).response).status, 200);
  });
});

test("upload fixture waits for actual admission while signed authentication is pending", { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await fixture(async ({ start, calls }) => {
    let settled = false;
    const first = start("one", "auth-held", 40 * mib).finally(() => { settled = true; });
    void first.catch(() => {});
    try {
      await Promise.race([entered.promise, first]);
      await turn();
      await turn();
      assert.equal(settled, false, "a received request is not an admitted upload");
      release.resolve();
      await first;
      busy(await (await start("one", "another-agent", 40 * mib)).response);
      assert.equal(calls(), 0);
      assert.equal((await (await start("other-user", "a", 2, "{}")).response).status, 200);
      assert.equal(calls(), 1);
    } finally {
      release.resolve();
      await first.catch(() => {});
    }
  }, 2000, async (request) => {
    if (request.method === "POST" && request.url === "/api/app/workspace/v1/agents/auth-held/sessions/s/prompts") {
      entered.resolve();
      await release.promise;
    }
  });
});

test("small requests cannot bypass the global concurrent upload count", { timeout: 10_000 }, async () => {
  await fixture(async ({ start, calls }) => {
    for (let i = 0; i < 16; i++) await start(`user-${i}`, "a", 2);
    busy(await (await start("next-user", "a", 2, "{}")).response);
    assert.equal(calls(), 0);
  });
});

test("body syntax failures and HTTP deadlines release upload admission", { timeout: 10_000 }, async () => {
  await fixture(async ({ start }) => {
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await start("one", "a", 2));
    const expired = await Promise.all(held.map((item) => item.response));
    assert.ok(expired.every((item) => item.status === 504));
    for (let i = 0; i < 6; i++)
      assert.equal((await (await start("one", "a", 2, "{]")).response).status, 400);
    for (let i = 0; i < 6; i++)
      assert.equal((await (await start("one", "a", 13, '{"fail":true}')).response).status, 503);
    assert.equal((await (await start("one", "a", 2, "{}")).response).status, 200);
  }, 100);
});

test("an HTTP deadline does not release bodies retained by unfinished dispatch", { timeout: 10_000 }, async () => {
  await fixture(async ({ start, releaseDispatch }) => {
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await start("one", "a", 13, '{"hold":true}'));
    assert.ok((await Promise.all(held.map((item) => item.response))).every((item) => item.status === 504));
    busy(await (await start("one", "a", 2, "{}")).response);
    releaseDispatch();
    await turn();
    assert.equal((await (await start("one", "a", 2, "{}")).response).status, 200);
  }, 100);
});

test("control bodies are rejected at the small-body boundary before parsing or dispatch", { timeout: 10_000 }, async () => {
  await fixture(async ({ start, calls }) => {
    for (const action of ["commands", "sessions/s/operations/i/cancel"])
      assert.equal((await (await start("one", "a", 16 * 1024 + 1, " ".repeat(16 * 1024 - 1) + "{}", action)).response).status, 413);
    assert.equal((await (await start("one", "a", -1, " ".repeat(16 * 1024 - 1) + "{}", "commands")).response).status, 413);
    assert.equal(calls(), 0);
  });
});
