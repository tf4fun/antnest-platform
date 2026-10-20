import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

const moduleURL = new URL("./c4-browser-scope.mjs", import.meta.url);
const { runC4BrowserScope } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});

function fixture() {
  const order = [];
  const context = {
    close: async () => {
      order.push("context closed");
    },
  };
  const browser = {
    newContext: async (options) => {
      assert.deepEqual(options, { viewport: { width: 1440, height: 1000 } });
      return context;
    },
    close: async () => {
      order.push("browser closed");
    },
  };
  const launch = async () => browser;
  return { order, context, browser, launch };
}

test("C4 browser scope joins dynamic response tasks and every observer before returning", async () => {
  assert.equal(typeof runC4BrowserScope, "function");
  const f = fixture();
  const value = await runC4BrowserScope({ launch: f.launch }, async (scope) => {
    assert.equal(scope.context, f.context);
    const pending = Promise.withResolvers();
    scope.track(
      pending.promise.then(() => {
        f.order.push("first response joined");
        scope.track(
          Promise.resolve().then(() => f.order.push("nested response joined")),
        );
      }),
    );
    f.context.close = async () => {
      f.order.push("context closed");
      pending.resolve();
    };
    scope.addObserver({
      closeAndWait: async () => f.order.push("observer joined"),
    });
    return "result";
  });
  assert.equal(value, "result");
  assert(f.order.includes("nested response joined"));
  assert(f.order.includes("observer joined"));
  assert.equal(f.order.filter((item) => item === "context closed").length, 1);
  assert.equal(f.order.filter((item) => item === "browser closed").length, 1);
});

test("C4 preserves business, response and independent cleanup errors and still joins later observers", async () => {
  assert.equal(typeof runC4BrowserScope, "function");
  const f = fixture();
  const failures = [
    "business",
    "response",
    "context",
    "browser",
    "observer",
  ].map((name) => new Error(`original ${name} error`));
  f.context.close = async () => {
    f.order.push("context closed");
    throw failures[2];
  };
  f.browser.close = async () => {
    f.order.push("browser closed");
    throw failures[3];
  };
  await assert.rejects(
    runC4BrowserScope({ launch: f.launch }, async (scope) => {
      scope.track(Promise.reject(failures[1]));
      scope.addObserver({
        closeAndWait: async () => {
          throw failures[4];
        },
      });
      scope.addObserver({
        closeAndWait: async () => {
          f.order.push("later observer joined");
        },
      });
      throw failures[0];
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(new Set(error.errors), new Set(failures));
      return true;
    },
  );
  assert(f.order.includes("later observer joined"));
  assert(
    f.order.includes("context closed") && f.order.includes("browser closed"),
  );
});

test("C4 closes a launched browser when creating its context fails", async () => {
  const f = fixture(),
    failure = new Error("original context startup error");
  f.browser.newContext = async () => {
    throw failure;
  };
  await assert.rejects(
    runC4BrowserScope({ launch: f.launch }, async () =>
      assert.fail("business must not start"),
    ),
    (error) => error === failure,
  );
  assert.deepEqual(f.order, ["browser closed"]);
});

test("C4 preserves an original launch failure", async () => {
  const failure = new Error("original launch failure");
  await assert.rejects(
    runC4BrowserScope(
      {
        launch: async () => {
          throw failure;
        },
      },
      async () => assert.fail(),
    ),
    (error) => error === failure,
  );
});

test("C4 cancellation waits for the in-flight browser close and preserves original interruption", async () => {
  const f = fixture(),
    abort = new AbortController();
  const business = Promise.withResolvers(),
    entered = Promise.withResolvers(),
    closing = Promise.withResolvers(),
    release = Promise.withResolvers();
  const interruption = new Error("original C4 parent interruption"),
    pageClosed = new Error("original page interruption");
  f.browser.close = async () => {
    f.order.push("browser closed");
    business.reject(pageClosed);
    closing.resolve();
    await release.promise;
  };
  let settled = false;
  const running = runC4BrowserScope(
    { launch: f.launch, signal: abort.signal },
    async () => {
      entered.resolve();
      await business.promise;
    },
  );
  const checked = assert.rejects(running, (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      new Set(error.errors),
      new Set([interruption, pageClosed]),
    );
    settled = true;
    return true;
  });
  await entered.promise;
  abort.abort(interruption);
  await closing.promise;
  await Promise.resolve();
  assert.equal(
    settled,
    false,
    "browser cleanup must be joined before returning",
  );
  release.resolve();
  await checked;
  assert.equal(f.order.filter((item) => item === "browser closed").length, 1);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("C4 does not launch a browser after cancellation", async () => {
  const abort = new AbortController(),
    failure = new Error("already cancelled");
  abort.abort(failure);
  await assert.rejects(
    runC4BrowserScope(
      {
        signal: abort.signal,
        launch: async () => assert.fail("unexpected launch"),
      },
      async () => assert.fail(),
    ),
    (error) => error === failure,
  );
});

test("C4 closes a browser whose launch resolves after cancellation", async () => {
  const f = fixture(),
    abort = new AbortController(),
    launched = Promise.withResolvers();
  const failure = new Error("cancelled during launch");
  const pending = runC4BrowserScope(
    { signal: abort.signal, launch: () => launched.promise },
    async () => assert.fail("business cannot start"),
  );
  abort.abort(failure);
  launched.resolve(f.browser);
  await assert.rejects(pending, (error) => error === failure);
  assert.deepEqual(f.order, ["browser closed"]);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("explicit context closure is idempotent and joins finite response readers", async () => {
  const f = fixture();
  await runC4BrowserScope({ launch: f.launch }, async (scope) => {
    let read = false;
    scope.track(
      Promise.resolve().then(() => {
        read = true;
      }),
    );
    await scope.closeContext();
    await scope.joinTasks();
    assert.equal(read, true);
    await scope.closeContext();
  });
  assert.equal(f.order.filter((item) => item === "context closed").length, 1);
});

test("C4 retains a non-Error rejection and joins independent diagnostic work", async () => {
  const f = fixture(),
    second = new Error("original diagnostic error");
  await assert.rejects(
    runC4BrowserScope({ launch: f.launch }, async (scope) => {
      scope.recordFailure(null);
      assert.equal(
        await scope.capture(async () => {
          throw second;
        }),
        undefined,
      );
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [null, second]);
      return true;
    },
  );
});

test("awaiting a tracked response still rejects with its original error", async () => {
  const f = fixture(),
    failure = new Error("original awaited response error");
  await assert.rejects(
    runC4BrowserScope({ launch: f.launch }, async (scope) => {
      await assert.rejects(
        scope.track(Promise.reject(failure)),
        (error) => error === failure,
      );
    }),
    (error) => error === failure,
  );
  assert.deepEqual(f.order, ["context closed", "browser closed"]);
});
