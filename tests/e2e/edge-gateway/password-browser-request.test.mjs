import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { passwordBrowserRequest } from "./password-browser-request.mjs";

const traceID = "a".repeat(32);
const timeout = () =>
  Object.assign(new Error("private-timeout-canary"), { name: "TimeoutError" });
const failedFetch = () => ({
  state: "rejected",
  http_status: null,
  trace_id: null,
  body_consumed: false,
  failure_kind: "type_error",
});

function fixture({
  observe = "success",
  fetchResult,
  failureText,
  browserFetch,
  unrelated = false,
  failures = 1,
} = {}) {
  const page = new EventEmitter();
  const records = [];
  let observer,
    sent = 0,
    observerOptions;
  const request = {
    url: () => "https://gateway.example.test/api/session/login",
    method: () => "POST",
    headers: () => ({ "idempotency-key": observer?.call_id }),
    failure: () => (failureText ? { errorText: failureText } : null),
  };
  const response = {
    request: () => request,
    url: request.url,
    status: () => 429,
    headerValue: async () => traceID,
  };
  page.waitForResponse = (predicate, options) => {
    observerOptions = options;
    return new Promise((resolve, reject) => {
      observer = { predicate, resolve, reject };
    });
  };
  page.evaluate = async (fn, args) => {
    sent++;
    observer.call_id = args.call_id;
    if (unrelated) {
      for (const other of [
        {
          ...request,
          url: () => "https://other.example.test/api/session/login",
        },
        { ...request, method: () => "GET" },
        { ...request, headers: () => ({ "idempotency-key": "other-request" }) },
      ]) {
        page.emit("request", other);
        page.emit("requestfailed", other);
        assert.equal(
          await observer.predicate({ ...response, request: () => other }),
          false,
        );
      }
    }
    page.emit("request", request);
    if (failureText)
      for (let index = 0; index < failures; index++)
        page.emit("requestfailed", request);
    if (observe === "timeout") observer.reject(timeout());
    else {
      assert.equal(await observer.predicate(response), true);
      observer.resolve(response);
    }
    if (fetchResult instanceof Error) throw fetchResult;
    if (browserFetch)
      return runInNewContext(`(${fn.toString()})(args)`, {
        args,
        fetch: browserFetch,
        AbortSignal: {
          timeout: (milliseconds) => {
            assert.equal(milliseconds, 25000);
            return "bounded-signal";
          },
        },
      });
    return (
      fetchResult ?? {
        state: "fulfilled",
        http_status: 429,
        trace_id: traceID,
        body_consumed: true,
      }
    );
  };
  const run = () =>
    passwordBrowserRequest({
      page,
      gateway: "https://gateway.example.test",
      path: "/api/session/login",
      body: { password: "private-password-canary" },
      csrf: "private-csrf-canary",
      record: (row) => records.push(structuredClone(row)),
    });
  return {
    run,
    response,
    records,
    receipt: () => records.at(-1),
    check: () => {
      assert.equal(sent, 1, "the helper must send only one request");
      assert.equal(observerOptions.timeout, 30000);
      assert.equal(page.eventNames().length, 0, "request listeners leaked");
      for (const secret of [
        "private-password-canary",
        "private-csrf-canary",
        "private-timeout-canary",
        "private-network-canary",
      ])
        assert(!JSON.stringify(records).includes(secret), "unsafe diagnostics");
    },
  };
}

test("observer timeout preserves the browser's immediate failure and requestfailed receipt", async () => {
  const f = fixture({
    observe: "timeout",
    fetchResult: failedFetch(),
    failureText: "net::ERR_CONNECTION_RESET",
  });
  await assert.rejects(f.run());
  f.check();
  const row = f.receipt();
  assert.equal(row.response_observer.state, "rejected");
  assert.equal(row.response_observer.failure_kind, "timeout");
  assert.equal(row.browser_fetch.failure_kind, "type_error");
  assert.equal(row.request_count, 1);
  assert.equal(row.request_failures[0].kind, "net::ERR_CONNECTION_RESET");
});

test("the actual browser callback retains a response when body consumption aborts", async () => {
  let calls = 0;
  const f = fixture({
    browserFetch: async (path, init) => {
      calls++;
      assert.equal(path, "/api/session/login");
      assert.equal(init.method, "POST");
      assert.equal(init.signal, "bounded-signal");
      assert.equal(JSON.parse(init.body).password, "private-password-canary");
      assert.equal(init.headers["X-Antnest-CSRF-Token"], "private-csrf-canary");
      assert.match(init.headers["Idempotency-Key"], /^[a-f0-9-]{36}$/);
      return {
        status: 429,
        headers: { get: () => traceID },
        arrayBuffer: async () => {
          throw Object.assign(new Error("private-network-canary"), {
            name: "AbortError",
          });
        },
      };
    },
  });
  await assert.rejects(f.run());
  f.check();
  assert.equal(calls, 1);
  assert.equal(f.receipt().browser_fetch.http_status, 429);
  assert.equal(f.receipt().browser_fetch.trace_id, traceID);
  assert.equal(f.receipt().browser_fetch.failure_kind, "aborted");
});

test("the actual browser callback preserves fetch failure without exception text", async () => {
  const f = fixture({
    observe: "timeout",
    browserFetch: async () => {
      throw new TypeError("private-network-canary");
    },
  });
  await assert.rejects(f.run());
  f.check();
  assert.equal(f.receipt().browser_fetch.state, "rejected");
  assert.equal(f.receipt().browser_fetch.http_status, null);
  assert.equal(f.receipt().browser_fetch.failure_kind, "type_error");
});

test("response correlation ignores other origins, methods and request identifiers", async () => {
  const f = fixture({ unrelated: true });
  assert.equal(await f.run(), f.response);
  f.check();
  assert.equal(f.receipt().request_count, 1);
  assert.equal(f.receipt().request_failure_count, 0);
});

test("bounded network receipts retain the full failure count", async () => {
  const f = fixture({
    observe: "timeout",
    fetchResult: failedFetch(),
    failureText: "net::ERR_CONNECTION_RESET",
    failures: 10,
  });
  await assert.rejects(f.run());
  f.check();
  assert.equal(f.receipt().request_failure_count, 10);
  assert.equal(f.receipt().request_failures.length, 4);
});

test("different response identities cannot satisfy both sides", async () => {
  const f = fixture({
    fetchResult: {
      state: "fulfilled",
      http_status: 429,
      trace_id: "b".repeat(32),
      body_consumed: true,
    },
  });
  await assert.rejects(f.run());
  f.check();
});

test("observer timeout retains the actual browser 429 but still fails without fallback", async () => {
  const f = fixture({ observe: "timeout" });
  await assert.rejects(f.run());
  f.check();
  assert.equal(f.receipt().browser_fetch.http_status, 429);
  assert.equal(f.receipt().browser_fetch.trace_id, traceID);
  assert.equal(f.receipt().browser_fetch.body_consumed, true);
});

test("an observed response cannot hide a browser body-read failure", async () => {
  const f = fixture({
    fetchResult: {
      ...failedFetch(),
      http_status: 429,
      trace_id: traceID,
      failure_kind: "aborted",
    },
  });
  await assert.rejects(f.run());
  f.check();
  assert.equal(f.receipt().response_observer.http_status, 429);
  assert.equal(f.receipt().browser_fetch.body_consumed, false);
  assert.equal(f.receipt().browser_fetch.failure_kind, "aborted");
});

test("evaluation rejection and unrecognized network text are preserved safely", async () => {
  const f = fixture({
    observe: "timeout",
    fetchResult: new TypeError("private-network-canary"),
    failureText: "private-network-canary",
  });
  await assert.rejects(f.run());
  f.check();
  assert.equal(f.receipt().browser_fetch.state, "evaluation_rejected");
  assert.equal(f.receipt().browser_fetch.failure_kind, "type_error");
  assert.equal(f.receipt().request_failures[0].kind, "unrecognized");
});

test("successful observation and body consumption return the original response once", async () => {
  const f = fixture();
  assert.equal(await f.run(), f.response);
  f.check();
  assert.equal(f.receipt().response_observer.http_status, 429);
  assert.equal(f.receipt().browser_fetch.body_consumed, true);
  assert(f.receipt().duration_ms >= 0);
});
