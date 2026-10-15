import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { inspect } from "node:util";
import { GatewayClient } from "./support.mjs";
import {
  reset,
  delta,
} from "../edge-gateway/resolve-cache-stream-fixtures.mjs";

const url = new URL("./bridge-session-observer.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function fixture(t, override = {}) {
  const requests = [];
  const denialPending = Promise.withResolvers();
  let stream, observer, releaseDenial;
  const release = () => {
    const send = releaseDenial;
    releaseDenial = undefined;
    send?.();
  };
  const cookie = "antnest_session=original-session; antnest_csrf=original-csrf";
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const row = {
        path: request.url,
        method: request.method,
        cookie: request.headers.cookie,
        csrf: request.headers["x-antnest-csrf-token"],
        ifMatch: request.headers["if-match"],
        body: chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : null,
      };
      requests.push(row);
      response.setHeader(
        "x-antnest-trace-id",
        (request.method === "GET" ? "a" : "b").repeat(32),
      );
      response.setHeader("cache-control", "no-store");
      if (
        request.method === "GET" &&
        request.url.endsWith("/events?sessionId=session-1")
      ) {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const initial = reset("session-1", 2);
        response.write(`event: reset\ndata: ${JSON.stringify(initial)}\n\n`);
      } else if (
        request.method === "DELETE" &&
        request.url === "/api/session"
      ) {
        response.setHeader("set-cookie", [
          "antnest_session=; Max-Age=0; Path=/",
          "antnest_csrf=; Max-Age=0; Path=/",
        ]);
        response.writeHead(204);
        response.end();
        if (override.accessRevoked) {
          const event = { ...delta(), type: "access_revoked" };
          stream.write(
            `event: access_revoked\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
        stream.end();
      } else if (
        request.method === "POST" &&
        request.url.endsWith("/sessions/session-1/prompts")
      ) {
        const send = () => {
          response.setHeader("content-type", "application/json");
          if (override.cookie)
            response.setHeader(
              "set-cookie",
              "antnest_session=replaced; Path=/",
            );
          if (override.cache)
            response.setHeader("cache-control", override.cache);
          response.writeHead(override.status ?? 401);
          response.end(
            JSON.stringify({ code: override.code ?? "unauthenticated" }),
          );
        };
        if (override.holdDenial) {
          releaseDenial = send;
          denialPending.resolve();
        } else send();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    release();
    await observer?.closeAndWait().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const browser = new GatewayClient(
    `http://127.0.0.1:${server.address().port}`,
  );
  browser.cookies = new Map([
    ["antnest_session", "original-session"],
    ["antnest_csrf", "original-csrf"],
  ]);
  const client = {
    requests: [
      { requestId: "1", method: "session/new", sessionId: "session-1" },
    ],
  };
  const issued = {
    principal: { organization_id: "org", user_id: "user" },
    observation: {
      startedMono: performance.now() - 10,
      completedMono: performance.now(),
      traceID: "c".repeat(32),
    },
    expires_at: new Date(Date.now() + 120000).toISOString(),
    idle_expires_at: new Date(Date.now() + 120000).toISOString(),
  };
  return {
    browser,
    client,
    issued,
    requests,
    cookie,
    denialPending: denialPending.promise,
    releaseDenial: release,
    async open({ signal } = {}) {
      assert.equal(typeof implementation.observeBrowserSession, "function");
      observer = await implementation.observeBrowserSession(browser, client, {
        agentId: "agent-1",
        sessionId: "session-1",
        issued,
        signal,
      });
      return observer;
    },
  };
}

test("actual logout is separate from silent observation and the rejection keeps the original Cookie", async (t) => {
  const f = await fixture(t),
    observer = await f.open();
  const checkpoint = observer.checkpoint("revoked");
  const logout = await f.browser.request("/api/session", {
    method: "DELETE",
    status: 204,
  });
  assert.equal(logout.status, 204);
  assert.equal(f.browser.requests, 1);
  assert.equal(f.browser.cookie, "");
  const closure = await observer.waitForClose(checkpoint);
  assert.equal(closure.authorizationCauseVerified, false);
  assert.equal(observer.browser.requests, 0);
  assert.equal(observer.browser.cookie, f.cookie);
  const denial = await observer.rejectPrompt();
  assert.equal(denial.status, 401);
  assert.equal(denial.code, "unauthenticated");
  assert.equal(denial.credentialScope, closure.credentialScope);
  assert(denial.startedMono >= closure.closure.at);
  assert(denial.completedMono >= denial.startedMono);
  assert.equal(new Date(denial.serverDate).toUTCString(), denial.serverDate);
  assert.deepEqual(observer.principal, f.issued.principal);
  assert.deepEqual(checkpoint.issuance, f.issued.observation);
  assert.equal(observer.browser.requests, 1);
  assert.deepEqual(
    f.requests.map((r) => r.method),
    ["GET", "DELETE", "POST"],
  );
  assert(f.requests.every((r) => r.cookie === f.cookie));
  const request = f.requests.at(-1);
  assert.equal(request.csrf, "original-csrf");
  assert.equal(request.ifMatch, "history");
  assert.equal(request.body.expectedAppendVersion, 1);
  assert.deepEqual(request.body.prompt, [
    { type: "text", text: "denied-must-not-run" },
  ]);
  assert.match(request.body.intentId, /^[a-f0-9-]{36}$/u);
  assert.equal(f.client.requests.length, 1);
  assert(
    !JSON.stringify({ checkpoint, closure, denial }).includes(
      "original-session",
    ),
  );
});

test("original Identity deadlines do not assume the observer's wall clock", async (t) => {
  const f = await fixture(t);
  f.issued.expires_at = new Date(Date.now() - 300000).toISOString();
  f.issued.idle_expires_at = f.issued.expires_at;
  const observer = await f.open();
  const point = observer.checkpoint("revoked");
  await f.browser.request("/api/session", { method: "DELETE", status: 204 });
  assert.equal(
    (await observer.waitForClose(point)).authorizationCauseVerified,
    false,
  );
});

test("an actual denial cannot be probed before the remote close is observed", async (t) => {
  const f = await fixture(t),
    observer = await f.open();
  await assert.rejects(() => observer.rejectPrompt());
  assert.equal(f.requests.length, 1);
  assert.equal(observer.browser.requests, 0);
});

test("a revocation event may clear the displayed view without losing the original denial payload", async (t) => {
  const f = await fixture(t, { accessRevoked: true }),
    observer = await f.open();
  const checkpoint = observer.checkpoint("revoked");
  await f.browser.request("/api/session", { method: "DELETE", status: 204 });
  await observer.waitForClose(checkpoint);
  assert.equal(observer.stream.view, null);
  assert.equal((await observer.rejectPrompt()).status, 401);
  assert.equal(f.requests.at(-1).ifMatch, "history");
});

test("changed private Cookie authority is rejected without exposing it or sending a probe", async (t) => {
  const f = await fixture(t),
    observer = await f.open();
  const checkpoint = observer.checkpoint("revoked");
  await f.browser.request("/api/session", { method: "DELETE", status: 204 });
  await observer.waitForClose(checkpoint);
  observer.browser.cookies.set("antnest_session", "MUTATED-PRIVATE-CANARY");
  await assert.rejects(
    () => observer.rejectPrompt(),
    (error) => {
      assert(!String(error).includes("MUTATED-PRIVATE-CANARY"));
      assert(!String(error).includes("original-session"));
      return true;
    },
  );
  assert.equal(f.requests.length, 2);
});

for (const [label, override] of [
  ["unexpected status", { status: 200 }],
  ["wrong cause", { code: "workspace_unavailable" }],
  ["Cookie write", { cookie: true }],
  ["cacheable rejection", { cache: "private, max-age=60" }],
])
  test(`post-close rejection retains strict ${label} validation`, async (t) => {
    const f = await fixture(t, override),
      observer = await f.open();
    const checkpoint = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(checkpoint);
    await assert.rejects(() => observer.rejectPrompt());
    assert.equal(f.client.requests.length, 1);
  });

for (const [label, override] of [
  ["body code", { code: "PRIVATE-RESPONSE-CANARY" }],
  ["cache header", { cache: "PRIVATE-RESPONSE-CANARY" }],
])
  test(`invalid ${label} is rejected without exposing upstream content`, async (t) => {
    const f = await fixture(t, override),
      observer = await f.open();
    const checkpoint = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(checkpoint);
    await assert.rejects(
      () => observer.rejectPrompt(),
      (error) => {
        assert(
          !inspect(error, { depth: null })
            .toLowerCase()
            .includes("private-response-canary"),
        );
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(f.requests.at(-1).method, "POST");
  });

test(
  "cancellation while a denial is pending joins the actual request and preserves the abort reason",
  { timeout: 20000 },
  async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, { holdDenial: true }),
      observer = await f.open({ signal: controller.signal });
    const checkpoint = observer.checkpoint("revoked");
    await f.browser.request("/api/session", { method: "DELETE", status: 204 });
    await observer.waitForClose(checkpoint);
    const pending = observer.rejectPrompt();
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await f.denialPending;
    const reason = new Error("caller cancelled the pending denial");
    controller.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the actual HTTP response must be joined");
    f.releaseDenial();
    await assert.rejects(pending, (error) => {
      assert.equal(error, reason);
      return true;
    });
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  },
);
