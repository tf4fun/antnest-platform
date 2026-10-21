import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import { after, before, test } from "node:test";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { observeC4Responses } from "./c4-responses.mjs";
import {
  createC4BodyAudit,
  assertC4BodyDiagnostics,
} from "./c4-body-audit.mjs";

const moduleURL = new URL("./c4-process-cancellation.mjs", import.meta.url);
const { observeC4ProcessCancellation } = await import(moduleURL).catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes(moduleURL.pathname)
    )
      throw error;
    return {};
  },
);
const processPath =
  "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/run-1/process";
const cursorCanary = "C4-PRIVATE-PROCESS-CURSOR";
const headerCanary = "C4-PRIVATE-FETCH-HEADER";
const bodyCanary = "C4-PRIVATE-FETCH-BODY";
const reasonCanary = "C4-PRIVATE-ABORT-REASON";
const payload = JSON.stringify({ items: [{ text: bodyCanary }] });
const recordKeys = [
  "abortedAt",
  "documentId",
  "fetchId",
  "method",
  "path",
  "reasonKind",
  "startedAt",
];
let browser;
before(async () => {
  if (typeof observeC4ProcessCancellation !== "function") return;
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

async function fixture(t, work, options = {}) {
  assert.equal(typeof observeC4ProcessCancellation, "function");
  const servers = [],
    replies = new Set(),
    wire = [],
    events = new EventEmitter();
  const pending = new Set(),
    failures = [];
  let context, page, observer, observerClosing, contextClosing;
  const track = (promise) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const release = () => {
    for (const response of replies) {
      if (response.destroyed || response.writableEnded) continue;
      if (!response.headersSent)
        response.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
      response.end(options.holdHeaders ? payload : "\n");
    }
  };
  const closeContext = () => (contextClosing ??= context?.close());
  const closeObserver = () => (observerClosing ??= observer?.closeAndWait());
  const interrupted = () => {
    release();
    // The same close promise is awaited and reported by the cleanup below.
    void closeContext()?.catch(() => {});
  };
  const listen = async () => {
    const server = createServer((request, response) => {
      if (!request.url.startsWith("/api/")) {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end("<!doctype html><title>Original process cancellation</title>");
        return;
      }
      const row = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: "",
      };
      request.on("data", (chunk) => {
        row.body += chunk.toString();
      });
      request.on("error", (error) => {
        if (!request.aborted || error.code !== "ECONNRESET")
          failures.push(error);
      });
      wire.push(row);
      replies.add(response);
      response.once("close", () => replies.delete(response));
      events.emit("wire");
      if (options.holdHeaders) return;
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      if (options.complete) response.end(payload);
      else response.write(payload);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: t.signal });
    return `http://127.0.0.1:${server.address().port}`;
  };
  try {
    const gateway = await listen();
    const foreignGateway = options.foreign ? await listen() : undefined;
    context = await browser.newContext();
    t.signal.addEventListener("abort", interrupted, { once: true });
    await context.addCookies([
      { name: "fixture_cookie", value: headerCanary, url: gateway },
    ]);
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    if (options.install !== false) {
      const restoreInstall = await options.beforeInstall?.(page);
      try {
        observer = await observeC4ProcessCancellation(page, {
          gateway,
          agentId: "agent-1",
          signal: t.signal,
        });
      } finally {
        await restoreInstall?.();
      }
      await observer.ready;
      await page.goto(gateway + "/first");
    }
    let sequence = 0;
    const begin = async ({
      url = gateway + processPath + "?cursor=" + cursorCanary,
      method = "GET",
      count = 1,
      withSignal = true,
      headers = true,
    } = {}) => {
      const groupId = `group-${++sequence}`;
      const requests = [],
        issued = Promise.withResolvers();
      void issued.promise.catch(() => {});
      const requested = (request) => {
        if (request.url() !== url || request.method() !== method) return;
        requests.push(request);
        if (requests.length === count) issued.resolve();
      };
      const cancelled = () => issued.reject(t.signal.reason);
      page.on("request", requested);
      t.signal.addEventListener("abort", cancelled, { once: true });
      const previousWire = wire.length;
      try {
        await page.evaluate(
          ({
            groupId,
            url,
            method,
            count,
            withSignal,
            headers,
            headerCanary,
            bodyCanary,
          }) => {
            globalThis.c4FetchGroups ??= new Map();
            globalThis.c4FetchReads ??= [];
            const group = [];
            globalThis.c4FetchGroups.set(groupId, group);
            for (let index = 0; index < count; index++) {
              const controller = new AbortController();
              const init = {
                method,
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                ...(withSignal ? { signal: controller.signal } : {}),
                ...(headers ? { headers: { "x-c4-input": headerCanary } } : {}),
                ...(method === "POST" ? { body: bodyCanary } : {}),
              };
              const item = { controller, init };
              group.push(item);
              const original = fetch(url, init);
              item.promise = original;
              item.promiseIsNative = original instanceof Promise;
              item.done = original.then(
                async (response) => {
                  item.response = response;
                  try {
                    return {
                      kind: "response",
                      status: response.status,
                      body: await response.text(),
                    };
                  } catch (error) {
                    return {
                      kind: "body_rejected",
                      status: response.status,
                      errorName: error.name,
                    };
                  }
                },
                (error) => ({
                  kind: "fetch_rejected",
                  errorName: error.name,
                  sameReason: error === controller.signal.reason,
                }),
              );
              globalThis.c4FetchReads.push(item.done);
            }
          },
          {
            groupId,
            url,
            method,
            count,
            withSignal,
            headers,
            headerCanary,
            bodyCanary,
          },
        );
        await issued.promise;
        while (wire.length < previousWire + count)
          await once(events, "wire", { signal: t.signal });
        if (!options.holdHeaders) {
          const statuses = await page.evaluate(
            (groupId) =>
              Promise.all(
                globalThis.c4FetchGroups
                  .get(groupId)
                  .map((item) =>
                    item.promise.then((response) => response.status),
                  ),
              ),
            groupId,
          );
          assert.deepEqual(statuses, Array(count).fill(200));
        }
        return { groupId, requests };
      } finally {
        page.off("request", requested);
        t.signal.removeEventListener("abort", cancelled);
        issued.reject(new Error("Fixture request collection ended"));
        await Promise.allSettled([issued.promise]);
      }
    };
    const abort = async (groupId, reasonKind = "default_abort") => {
      await page.evaluate(
        async ({ groupId, reasonKind, reasonCanary }) => {
          const group = globalThis.c4FetchGroups.get(groupId);
          const cancel = () => {
            for (const item of group) {
              if (reasonKind === "default_abort") item.controller.abort();
              else if (reasonKind === "deadline")
                item.controller.abort(new Error("Workspace request timed out"));
              else if (reasonKind === "session_changed") {
                const reason = new Error(
                  "The browser session changed. Validate the current session before trying again.",
                );
                reason.name = "BrowserSessionChanged";
                item.controller.abort(reason);
              } else {
                const reason = new Error(reasonCanary);
                // A caller-controlled Error named AbortError is not the default DOMException.
                reason.name = "AbortError";
                item.controller.abort(reason);
              }
            }
          };
          if (reasonKind === "deadline")
            await new Promise((resolve) =>
              setTimeout(() => {
                cancel();
                resolve();
              }, 0),
            );
          else cancel();
        },
        { groupId, reasonKind, reasonCanary },
      );
    };
    const ended = (requests) =>
      requests.map((request) =>
        track(
          page.waitForEvent("requestfailed", {
            predicate: (value) => value === request,
            timeout: 5000,
          }),
        ),
      );
    const outcomes = (groupId) =>
      page.evaluate(
        (groupId) =>
          Promise.all(
            globalThis.c4FetchGroups.get(groupId).map((item) => item.done),
          ),
        groupId,
      );
    await work({
      gateway,
      foreignGateway,
      context,
      page,
      observer,
      begin,
      abort,
      ended,
      outcomes,
      release,
      wire,
      closeObserver,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    release();
    const cleanup = [
      async () => {
        if (page && !page.isClosed())
          await page.evaluate(() =>
            Promise.allSettled(globalThis.c4FetchReads ?? []),
          );
      },
      async () => {
        await closeObserver();
      },
      async () => {
        await closeContext();
      },
      async () => {
        await Promise.allSettled([...pending]);
      },
      ...servers.map((server) => async () => {
        server.closeAllConnections();
        if (server.listening)
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      }),
    ];
    for (const close of cleanup) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    t.signal.removeEventListener("abort", interrupted);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Process cancellation fixture or cleanup failed",
    );
}

function assertPrivateRecord(record, reasonKind) {
  assert(record);
  assert.equal(Object.isFrozen(record), true);
  assert.deepEqual(Object.keys(record).sort(), recordKeys);
  assert.equal(typeof record.documentId, "string");
  assert(record.documentId.length > 0);
  assert.equal(typeof record.fetchId, "string");
  assert(record.fetchId.length > 0);
  assert.equal(record.method, "GET");
  assert.equal(record.path, processPath);
  assert.equal(record.reasonKind, reasonKind);
  assert(Number.isFinite(record.startedAt) && record.startedAt >= 0);
  assert(
    Number.isFinite(record.abortedAt) && record.abortedAt >= record.startedAt,
  );
}

async function withLinkedProcessBodies(t, f, work) {
  const observers = [],
    records = [],
    diagnostics = [],
    frames = [],
    actions = [],
    nextActions = [],
    errors = [];
  const pending = new Set();
  const first = Promise.withResolvers();
  void first.promise.catch(() => {});
  const interrupted = () => first.reject(t.signal.reason);
  t.signal.addEventListener("abort", interrupted, { once: true });
  const scope = {
    addObserver(observer) {
      observers.push(observer);
    },
    track(work) {
      const promise = Promise.resolve(work);
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    },
  };
  const audit = createC4BodyAudit({
    gateway: f.gateway,
    agentId: "agent-1",
    diagnostics,
  });
  audit.track(f.page, scope);
  const reader = observeC4Responses(
    f.page,
    scope,
    async (response, _url, { terminal }) => {
      const record = {
        request: response.request(),
        response,
        terminal,
        rawError: null,
        joined: false,
      };
      // Read the original held Playwright HTTP body once. The text adapter
      // only decodes its Buffer; its original rejection object is unchanged.
      const text = response.body().then((bytes) => bytes.toString("utf8"));
      record.bodySettled = text.then(
        () => null,
        (error) => {
          record.rawError = error;
          return error;
        },
      );
      const original = {
        url: () => response.url(),
        status: () => response.status(),
        headers: () => response.headers(),
        request: () => response.request(),
        text: () => text,
      };
      record.read = audit.read(f.page, original, "process_complete", {
        terminal,
        cancellation: f.observer,
      });
      void record.read.catch(() => {});
      records.push(record);
      first.resolve(record);
      try {
        const value = await record.read;
        if (value !== null) frames.push(value);
      } finally {
        record.joined = true;
        actions.push("body joined");
      }
    },
  );
  const next = () => {
    const result = reader
      .before(() => actions.push("next business action"))
      .then(
        () => ({ kind: "succeeded" }),
        (error) => ({ kind: "failed", error }),
      );
    nextActions.push(result);
    return result;
  };
  try {
    await work({
      reader,
      audit,
      records,
      diagnostics,
      frames,
      actions,
      first: first.promise,
      next,
    });
  } catch (error) {
    errors.push(error);
  } finally {
    f.release();
    const closed = await Promise.allSettled(
      observers.map((observer) => observer.closeAndWait()),
    );
    await Promise.allSettled([
      ...pending,
      ...nextActions,
      ...records.flatMap((record) => [record.read, record.bodySettled]),
    ]);
    const originalBodyErrors = new Set(
      records.map((record) => record.rawError),
    );
    for (const result of closed)
      if (
        result.status === "rejected" &&
        !originalBodyErrors.has(result.reason)
      )
        errors.push(result.reason);
    t.signal.removeEventListener("abort", interrupted);
  }
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Linked process body observation or cleanup failed",
    );
}

for (const reasonKind of [
  "default_abort",
  "deadline",
  "session_changed",
  "unknown",
])
  test(
    `C4 real finite-body audit distinguishes ${reasonKind} without a prior observer flush`,
    { timeout: 20_000 },
    async (t) =>
      fixture(t, async (f) => {
        await withLinkedProcessBodies(t, f, async (linked) => {
          if (reasonKind === "default_abort") {
            await f.page.evaluate(() => {
              history.pushState(
                null,
                "",
                "/workspace/agent-1/sessions/session-1",
              );
            });
            assert.equal(
              f.page.url(),
              f.gateway + "/workspace/agent-1/sessions/session-1",
            );
          }
          const group = await f.begin();
          const original = await linked.first;
          assert.equal(original.request, group.requests[0]);
          assert.equal(original.response.status(), 200);
          assert.match(
            original.response.headers()["content-type"],
            /^application\/json/u,
          );
          const next = linked.next();
          await turn();
          assert.deepEqual(
            linked.actions,
            [],
            "the actual held body must block the next action",
          );
          await f.abort(group.groupId, reasonKind);
          // Classification runs before any explicit observer close, delivery
          // flush, or second page.evaluate that could hide the real ordering.
          const result = await next;
          assert.equal(original.joined, true);
          assert(original.rawError instanceof Error);
          assert.equal((await original.terminal).kind, "failed");
          assert.equal((await original.terminal).failure, "net::ERR_ABORTED");
          assert.deepEqual(
            linked.frames,
            [],
            "an aborted body is not an audited payload frame",
          );
          if (reasonKind === "default_abort") {
            assert.equal(result.kind, "succeeded");
            assert.deepEqual(linked.actions, [
              "body joined",
              "next business action",
            ]);
            assert.equal(linked.reader.ready(), true);
            assert.equal(linked.diagnostics.length, 1);
            const [row] = linked.diagnostics;
            assert.equal(row.classification, "cancelled_process_read");
            assert.equal(row.agentId, "agent-1");
            assert.equal(row.sessionId, "session-1");
            assert.equal(row.runId, "run-1");
            assert.equal(row.body, "not_observed");
            assertPrivateRecord(row.cancellation, "default_abort");
            assert.equal(row.cancellation, f.observer.match(group.requests[0]));
            assert.deepEqual(row.raw_error, {
              name: original.rawError.name,
              message: original.rawError.message,
              stack: original.rawError.stack,
            });
            const review = assertC4BodyDiagnostics(
              {
                agent_id: "agent-1",
                business_completed: true,
                browser_body_diagnostics: linked.diagnostics,
              },
              { gateway: f.gateway },
            );
            assert.equal(review.body_count, 1);
            assert.deepEqual(review.body_ids, [1]);
          } else {
            assert.equal(result.kind, "failed");
            assert.equal(
              result.error,
              original.rawError,
              "retain the actual HTTP body Error",
            );
            await assert.rejects(
              linked.reader.wait(),
              (error) => error === original.rawError,
            );
            assert.deepEqual(linked.actions, ["body joined"]);
            assert.deepEqual(linked.diagnostics, []);
          }
          const outcomes = await f.outcomes(group.groupId);
          assert.equal(outcomes.length, 1);
          assert.equal(outcomes[0].kind, "body_rejected");
          assert.equal(outcomes[0].status, 200);
          assert.equal(
            f.wire.length,
            1,
            "body observation must never replay the original fetch",
          );
        });
      }),
  );

test(
  "C4 real body audit joins a delayed original abort binding before accepting process cancellation",
  { timeout: 20_000 },
  async (t) => {
    const held = Promise.withResolvers(),
      release = Promise.withResolvers();
    const deliveries = new Set();
    void held.promise.catch(() => {});
    const interrupted = () => {
      release.resolve();
      held.reject(t.signal.reason);
    };
    t.signal.addEventListener("abort", interrupted, { once: true });
    try {
      await fixture(
        t,
        async (f) => {
          try {
            await withLinkedProcessBodies(t, f, async (linked) => {
              try {
                const group = await f.begin();
                const original = await linked.first;
                const next = linked.next();
                let settled = false;
                void next.then(() => {
                  settled = true;
                });
                await f.abort(group.groupId);
                await held.promise;
                const terminal = await original.terminal;
                assert.equal(terminal.kind, "failed");
                assert.equal(terminal.failure, "net::ERR_ABORTED");
                await original.bodySettled;
                assert(original.rawError instanceof Error);
                await turn();
                assert.equal(
                  settled,
                  false,
                  "HTTP terminal is not proof that the original abort binding was delivered",
                );
                assert.deepEqual(linked.diagnostics, []);
                assert.deepEqual(linked.actions, []);
                assert.equal(f.wire.length, 1);
                release.resolve();
                assert.deepEqual(await next, { kind: "succeeded" });
                assert.equal(typeof f.observer.flushAndWait, "function");
                assert.equal(original.joined, true);
                assert.deepEqual(linked.frames, []);
                assert.deepEqual(linked.actions, [
                  "body joined",
                  "next business action",
                ]);
                assert.equal(linked.diagnostics.length, 1);
                assert.equal(
                  linked.diagnostics[0].classification,
                  "cancelled_process_read",
                );
                assertPrivateRecord(
                  linked.diagnostics[0].cancellation,
                  "default_abort",
                );
                assert.equal(
                  linked.diagnostics[0].cancellation,
                  f.observer.match(group.requests[0]),
                );
                assert.equal(f.wire.length, 1);
              } finally {
                release.resolve();
              }
            });
          } finally {
            release.resolve();
            await Promise.allSettled([...deliveries]);
          }
        },
        {
          beforeInstall(page) {
            const original = page.exposeBinding;
            page.exposeBinding = function (name, callback, options) {
              return original.call(
                this,
                name,
                (source, event) => {
                  const delivery = (async () => {
                    if (event.type === "abort") {
                      held.resolve();
                      await release.promise;
                    }
                    return callback(source, event);
                  })();
                  deliveries.add(delivery);
                  void delivery.then(
                    () => deliveries.delete(delivery),
                    () => deliveries.delete(delivery),
                  );
                  return delivery;
                },
                options,
              );
            };
            return () => {
              page.exposeBinding = original;
            };
          },
        },
      );
    } finally {
      release.resolve();
      await Promise.allSettled([...deliveries]);
      t.signal.removeEventListener("abort", interrupted);
    }
  },
);

for (const reasonKind of [
  "default_abort",
  "deadline",
  "session_changed",
  "unknown",
]) {
  test(
    `C4 freezes ${reasonKind} from the real process fetch signal without equating ERR_ABORTED reasons`,
    { timeout: 20_000 },
    async (t) =>
      fixture(t, async (f) => {
        const group = await f.begin();
        const ended = f.ended(group.requests);
        await f.abort(group.groupId, reasonKind);
        await Promise.all(ended);
        assert.equal(group.requests[0].failure().errorText, "net::ERR_ABORTED");
        const outcomes = await f.outcomes(group.groupId);
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].kind, "body_rejected");
        assert.equal(outcomes[0].status, 200);
        await f.closeObserver();
        const record = f.observer.match(group.requests[0]);
        assertPrivateRecord(record, reasonKind);
        assert.deepEqual(f.observer.records, [record]);
        for (const secret of [
          cursorCanary,
          headerCanary,
          bodyCanary,
          reasonCanary,
        ])
          assert(!JSON.stringify(f.observer.records).includes(secret));
        assert.equal(f.wire.length, 1, "the observer must not replay a fetch");
      }),
  );
}

test(
  "C4 observation preserves a successful native fetch Response, input options and body",
  { timeout: 20_000 },
  async (t) =>
    fixture(
      t,
      async (f) => {
        const group = await f.begin();
        assert.deepEqual(await f.outcomes(group.groupId), [
          { kind: "response", status: 200, body: payload },
        ]);
        const native = await f.page.evaluate(async (groupId) => {
          const item = globalThis.c4FetchGroups.get(groupId)[0];
          return {
            promise: item.promiseIsNative,
            sameResponse: (await item.promise) === item.response,
            signal: item.init.signal === item.controller.signal,
            aborted: item.controller.signal.aborted,
          };
        }, group.groupId);
        assert.deepEqual(native, {
          promise: true,
          sameResponse: true,
          signal: true,
          aborted: false,
        });
        assert.equal(f.wire.length, 1);
        assert.equal(f.wire[0].method, "GET");
        assert.equal(f.wire[0].path, processPath + "?cursor=" + cursorCanary);
        assert.equal(f.wire[0].headers["x-c4-input"], headerCanary);
        assert.equal(
          f.wire[0].headers.cookie,
          undefined,
          "credentials: omit must remain effective",
        );
        await f.closeObserver();
        assert.equal(f.observer.match(group.requests[0]), null);
      },
      { complete: true },
    ),
);

test(
  "C4 observation preserves the original fetch rejection object before response headers",
  { timeout: 20_000 },
  async (t) =>
    fixture(
      t,
      async (f) => {
        const group = await f.begin();
        const ended = f.ended(group.requests);
        await f.abort(group.groupId, "unknown");
        await Promise.all(ended);
        assert.deepEqual(await f.outcomes(group.groupId), [
          { kind: "fetch_rejected", errorName: "AbortError", sameReason: true },
        ]);
        await f.closeObserver();
        assertPrivateRecord(f.observer.match(group.requests[0]), "unknown");
        assert.equal(f.wire.length, 1);
      },
      { holdHeaders: true },
    ),
);

test(
  "C4 never attributes an unused controller's abort to a fetch without its signal",
  { timeout: 20_000 },
  async (t) =>
    fixture(t, async (f) => {
      const group = await f.begin({ withSignal: false });
      await f.abort(group.groupId);
      f.release();
      const result = await f.outcomes(group.groupId);
      assert.equal(result[0].kind, "response");
      assert.equal(result[0].status, 200);
      await f.closeObserver();
      assert.equal(f.observer.match(group.requests[0]), null);
    }),
);

for (const boundary of [
  "POST",
  "another Agent",
  "process content",
  "another origin",
]) {
  test(
    `C4 cancellation observation excludes ${boundary}`,
    { timeout: 20_000 },
    async (t) =>
      fixture(
        t,
        async (f) => {
          const path =
            boundary === "another Agent"
              ? processPath.replace("agent-1", "agent-other")
              : boundary === "process content"
                ? processPath + "/item/content"
                : processPath;
          const group = await f.begin({
            url:
              (boundary === "another origin" ? f.foreignGateway : f.gateway) +
              path,
            method: boundary === "POST" ? "POST" : "GET",
            headers: boundary !== "another origin",
          });
          const ended = f.ended(group.requests);
          await f.abort(group.groupId);
          await Promise.all(ended);
          await f.outcomes(group.groupId);
          await f.closeObserver();
          assert.equal(f.observer.match(group.requests[0]), null);
          assert.equal(f.wire.length, 1);
        },
        { foreign: boundary === "another origin" },
      ),
  );
}

for (const navigationKind of ["pushState", "replaceState", "popstate"]) {
  test(
    `C4 still matches the original process Request after same-document ${navigationKind}`,
    { timeout: 20_000 },
    async (t) =>
      fixture(t, async (f) => {
        const marker = await f.page.evaluate(() => {
          globalThis.c4OriginalDocument = crypto.randomUUID();
          return globalThis.c4OriginalDocument;
        });
        const destination =
          f.gateway +
          (navigationKind === "popstate" ? "/first" : `/spa-${navigationKind}`);
        const navigated = f.page.waitForEvent("framenavigated", {
          predicate: (frame) =>
            frame === f.page.mainFrame() && frame.url() === destination,
          timeout: 5000,
        });
        void navigated.catch(() => {});
        try {
          await f.page.evaluate(async (kind) => {
            if (kind === "popstate") {
              history.pushState(null, "", "/spa-history");
              const popped = new Promise((resolve) =>
                addEventListener("popstate", resolve, { once: true }),
              );
              history.back();
              await popped;
            } else history[kind](null, "", `/spa-${kind}`);
          }, navigationKind);
          await navigated;
        } finally {
          await Promise.allSettled([navigated]);
        }
        assert.equal(f.page.url(), destination);
        assert.equal(
          await f.page.evaluate(() => globalThis.c4OriginalDocument),
          marker,
          "history navigation must retain the original Document",
        );
        const group = await f.begin();
        const ended = f.ended(group.requests);
        await f.abort(group.groupId);
        await Promise.all(ended);
        assert.equal(group.requests[0].failure().errorText, "net::ERR_ABORTED");
        const outcomes = await f.outcomes(group.groupId);
        assert.equal(outcomes[0].kind, "body_rejected");
        assert.equal(outcomes[0].status, 200);
        await f.closeObserver();
        const record = f.observer.match(group.requests[0]);
        assertPrivateRecord(record, "default_abort");
        assert.deepEqual(f.observer.records, [record]);
        assert.equal(
          f.wire.length,
          1,
          "history navigation must not replay fetch",
        );
      }),
  );
}

test(
  "C4 does not match an old document's cancellation after a new document loads",
  { timeout: 20_000 },
  async (t) =>
    fixture(t, async (f) => {
      const old = await f.begin();
      const oldEnded = f.ended(old.requests);
      await f.abort(old.groupId);
      await Promise.all(oldEnded);
      await f.outcomes(old.groupId);
      await f.page.goto(f.gateway + "/second");
      const current = await f.begin();
      const currentEnded = f.ended(current.requests);
      await f.abort(current.groupId);
      await Promise.all(currentEnded);
      await f.outcomes(current.groupId);
      await f.closeObserver();
      assert.equal(f.observer.match(old.requests[0]), null);
      const record = f.observer.match(current.requests[0]);
      assertPrivateRecord(record, "default_abort");
      assert.equal(
        new Set(f.observer.records.map((value) => value.documentId)).size,
        2,
      );
      assert.equal(f.wire.length, 2);
    }),
);

test(
  "C4 refuses ambiguous concurrent original fetches to the exact same URL",
  { timeout: 20_000 },
  async (t) =>
    fixture(t, async (f) => {
      const group = await f.begin({ count: 2 });
      const ended = f.ended(group.requests);
      await f.abort(group.groupId);
      await Promise.all(ended);
      await f.outcomes(group.groupId);
      await f.closeObserver();
      assert.equal(f.observer.records.length, 2);
      assert.equal(
        new Set(f.observer.records.map((value) => value.fetchId)).size,
        2,
      );
      for (const request of group.requests)
        assert.equal(f.observer.match(request), null);
      assert.equal(f.wire.length, 2);
    }),
);

test(
  "C4 cancellation observation preserves an already aborted parent's original failure",
  { timeout: 20_000 },
  async (t) =>
    fixture(
      t,
      async (f) => {
        const parent = new AbortController();
        const cancellation = new Error("Original C4 parent cancellation");
        parent.abort(cancellation);
        let observer;
        try {
          await assert.rejects(
            async () => {
              observer = await observeC4ProcessCancellation(f.page, {
                gateway: f.gateway,
                agentId: "agent-1",
                signal: parent.signal,
              });
              await observer.ready;
            },
            (error) => error === cancellation,
          );
          assert.equal(f.wire.length, 0);
          if (observer) assert.deepEqual(observer.records, []);
        } finally {
          if (observer)
            await observer.closeAndWait().catch((error) => {
              assert.equal(error, cancellation);
            });
        }
      },
      { install: false },
    ),
);
