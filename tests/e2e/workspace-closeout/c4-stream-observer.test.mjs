import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { before, after, test } from "node:test";
import { inspect } from "node:util";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";

const moduleURL = new URL("./c4-stream-observer.mjs", import.meta.url);
const { observeC4PageStreams } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
const cookies = [
  { name: "antnest_session", value: "C4-ORIGINAL-BROWSER-SESSION" },
  { name: "antnest_csrf", value: "C4-ORIGINAL-CSRF" },
];
let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
});
after(async () => {
  await browser?.close();
});

async function fixture(t, options = {}) {
  assert.equal(typeof observeC4PageStreams, "function");
  const wire = [],
    streams = [];
  const server = createServer((request, response) => {
    if (request.url.startsWith("/api/")) {
      wire.push({ path: request.url, cookie: request.headers.cookie });
      response.writeHead(options.status ?? 200, {
        "content-type":
          options.contentType ?? "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-antnest-trace-id": options.traceID ?? "a".repeat(32),
        ...(options.setCookie
          ? { "set-cookie": "antnest_session=rotated; Path=/" }
          : {}),
      });
      streams.push(response);
      if ((options.status ?? 200) !== 200) response.end("unavailable");
      else response.write(": connected\n\n");
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>C4 stream fixture</title>");
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  let observer;
  t.after(async () => {
    await context.close();
    await observer?.closeAndWait();
  });
  await context.addCookies(
    cookies.map((cookie) => ({ ...cookie, url: gateway })),
  );
  const page = await context.newPage();
  observer = observeC4PageStreams(page, {
    gateway,
    agentId: "agent-1",
    signal: options.signal,
  });
  await page.goto(gateway);
  const start = async (
    path = "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=original-cursor",
  ) => {
    await page.evaluate((url) => {
      globalThis.source = new EventSource(url);
      globalThis.sourceError = false;
      source.onerror = () => {
        globalThis.sourceError = true;
        source.close();
      };
    }, path);
    if (
      (options.status ?? 200) === 200 &&
      !(
        options.contentType &&
        !options.contentType.startsWith("text/event-stream")
      )
    )
      await page.waitForFunction(() => source.readyState === EventSource.OPEN);
    else await page.waitForFunction(() => sourceError);
  };
  return { gateway, context, page, observer, wire, streams, start };
}
const checkpoint = (observer, overrides = {}) =>
  observer.checkpoint({
    sessionId: "session-1",
    cookies,
    timeoutMs: 500,
    ...overrides,
  });

test("C4 observes the page's original EventSource normal EOF before local browser cleanup", async (t) => {
  const f = await fixture(t);
  await f.start();
  const point = await checkpoint(f.observer);
  assert.equal(f.wire.length, 1);
  assert.equal(point.stream.path, f.wire[0].path);
  assert.equal(point.stream.trace_id, "a".repeat(32));
  assert.equal(point.stream.status, 200);
  assert.equal(point.stream.set_cookie_count, 0);
  assert.equal(f.observer.originalCookie(point), f.wire[0].cookie);
  assert(!JSON.stringify(point).includes(cookies[0].value));
  assert(Object.isFrozen(point) && Object.isFrozen(point.stream));
  f.streams[0].end();
  const result = await f.observer.waitForRemoteEnd(point, { timeoutMs: 1000 });
  assert.equal(result.pageOwned, true);
  assert.equal(result.closure.kind, "remote-end");
  assert.equal(result.traceID, point.stream.trace_id);
  assert.equal(result.localClose, false);
  assert(result.closure.at >= point.at);
  assert.equal(f.page.isClosed(), false);
  await f.page.close();
  assert.equal(
    await f.observer.waitForRemoteEnd(point),
    result,
    "later cleanup must retain the original EOF receipt",
  );
  assert.equal(
    f.wire.length,
    1,
    "observation must not open a substitute host stream",
  );
});

test("an EventSource that ended before the revocation trigger cannot satisfy C4", async (t) => {
  const f = await fixture(t);
  await f.start();
  f.streams[0].end();
  await f.page.waitForFunction(() => sourceError);
  await assert.rejects(checkpoint(f.observer), /before.*trigger|not live/);
});

test("C4 retains original truncated remote transport without claiming its authorization cause", async (t) => {
  const f = await fixture(t);
  await f.start();
  const point = await checkpoint(f.observer);
  f.streams[0].destroy();
  const result = await f.observer.waitForRemoteEnd(point, { timeoutMs: 1000 });
  assert.equal(result.closure.kind, "transport-end");
  assert.deepEqual(result.closure.failure, {
    errorText: "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
  });
  assert.equal(result.authorizationCauseVerified, false);
  assert.equal(result.localClose, false);
  assert.equal(f.wire.length, 1);
  await f.page.close();
  assert.equal(await f.observer.waitForRemoteEnd(point), result);
});

for (const kind of [
  "page-close",
  "local-source-close",
  "navigation",
  "observer-disposal",
])
  test(`C4 refuses ${kind} as remote normal EOF`, async (t) => {
    const f = await fixture(t);
    await f.start();
    const point = await checkpoint(f.observer);
    if (kind === "page-close") await f.page.close();
    else if (kind === "local-source-close")
      await f.page.evaluate(() => source.close());
    else if (kind === "navigation") await f.page.goto(f.gateway + "/next");
    else await f.observer.closeAndWait();
    await assert.rejects(
      f.observer.waitForRemoteEnd(point, { timeoutMs: 1000 }),
      /remote|disposed|local|transport/,
    );
  });

for (const [name, options] of [
  ["HTTP 503", { status: 503 }],
  ["non-SSE response", { contentType: "application/json" }],
  ["missing Trace identity", { traceID: "" }],
  ["zero Trace identity", { traceID: "0".repeat(32) }],
  ["rotated browser Cookie", { setCookie: true }],
])
  test(`C4 refuses an event request with ${name}`, async (t) => {
    const f = await fixture(t, options);
    await f.start();
    await assert.rejects(checkpoint(f.observer));
  });

for (const field of ["antnest_session", "antnest_csrf"])
  test(`C4 rejects a different original ${field} authority`, async (t) => {
    const f = await fixture(t);
    await f.start();
    const different = cookies.map((cookie) => ({
      ...cookie,
      value: cookie.name === field ? "different" : cookie.value,
    }));
    await assert.rejects(
      checkpoint(f.observer, { cookies: different }),
      (error) => {
        assert.match(error.message, /authority/);
        for (const value of [...cookies, ...different].map(
          (cookie) => cookie.value,
        ))
          assert(
            !inspect(error).includes(value),
            "browser authority leaked into the failure diagnostic",
          );
        return true;
      },
    );
  });

for (const path of [
  "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-other",
  "/api/app/workspace/v1/agents/agent-other/events?sessionId=session-1",
  "/api/app/agents/agent-1/state/watch",
])
  test(`a foreign or retired page stream cannot replace the scoped C4 stream: ${path}`, async (t) => {
    const f = await fixture(t);
    await f.start(path);
    await assert.rejects(checkpoint(f.observer, { timeoutMs: 50 }));
  });

test("C4 binds the exact stream instance and rejects a copied checkpoint", async (t) => {
  const f = await fixture(t);
  await f.start();
  const point = await checkpoint(f.observer);
  await assert.rejects(
    f.observer.waitForRemoteEnd(structuredClone(point)),
    /checkpoint/,
  );
  assert.throws(
    () => f.observer.originalCookie(structuredClone(point)),
    /checkpoint/,
  );
});

test("C4 rejects ambiguous simultaneously live page streams", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.start();
  await assert.rejects(checkpoint(f.observer), /ambiguous/);
});

test("C4 cancellation preserves the original reason and cannot become a passed EOF", async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, { signal: abort.signal });
  await f.start();
  const point = await checkpoint(f.observer);
  const failure = new Error("original C4 interruption");
  abort.abort(failure);
  await assert.rejects(
    f.observer.waitForRemoteEnd(point),
    (error) => error === failure,
  );
});

test("C4 joins original asynchronous header failures without losing their Error identities", async () => {
  assert.equal(typeof observeC4PageStreams, "function");
  const page = new EventEmitter(),
    frame = {};
  page.mainFrame = () => frame;
  page.isClosed = () => false;
  const requestFailure = new Error("original request headers failed");
  const responseFailure = new Error("original response headers failed");
  const request = {
    url: () =>
      "http://127.0.0.1/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
    method: () => "GET",
    resourceType: () => "eventsource",
    frame: () => frame,
    allHeaders: async () => {
      throw requestFailure;
    },
  };
  const response = {
    request: () => request,
    status: () => 200,
    headersArray: async () => {
      throw responseFailure;
    },
  };
  const observer = observeC4PageStreams(page, {
    gateway: "http://127.0.0.1",
    agentId: "agent-1",
  });
  page.emit("request", request);
  page.emit("response", response);
  await assert.rejects(observer.closeAndWait(), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      new Set(error.errors),
      new Set([requestFailure, responseFailure]),
    );
    return true;
  });
  for (const name of [
    "request",
    "response",
    "requestfinished",
    "requestfailed",
    "close",
    "framenavigated",
  ])
    assert.equal(page.listenerCount(name), 0);
});

test("C4 retains parent cancellation together with a deferred original header error", async () => {
  const page = new EventEmitter(),
    frame = {};
  page.mainFrame = () => frame;
  page.isClosed = () => false;
  const started = Promise.withResolvers(),
    headers = Promise.withResolvers();
  const headerFailure = new Error("original delayed header failure");
  const interruption = new Error("original parent interruption");
  const abort = new AbortController();
  const request = {
    url: () =>
      "http://127.0.0.1/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
    method: () => "GET",
    resourceType: () => "eventsource",
    frame: () => frame,
    allHeaders: () => {
      started.resolve();
      return headers.promise;
    },
  };
  const response = {
    request: () => request,
    status: () => 200,
    headersArray: async () => [],
  };
  const observer = observeC4PageStreams(page, {
    gateway: "http://127.0.0.1",
    agentId: "agent-1",
    signal: abort.signal,
  });
  page.emit("request", request);
  page.emit("response", response);
  const pending = checkpoint(observer);
  await started.promise;
  abort.abort(interruption);
  headers.reject(headerFailure);
  const originals = (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      new Set(error.errors),
      new Set([headerFailure, interruption]),
    );
    return true;
  };
  await assert.rejects(pending, originals);
  await assert.rejects(observer.closeAndWait(), originals);
});
