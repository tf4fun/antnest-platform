import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import {
  beforeC4Responses,
  c4BootstrapDenial,
  observeC4Responses,
} from "./c4-responses.mjs";
import { runC4BrowserScope } from "./c4-browser-scope.mjs";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";

const response = (
  path = "/api/app/workspace/v1/bootstrap",
  type = "application/json",
) => ({
  url: () => `http://gateway${path}`,
  headers: () => ({ "content-type": type }),
});

function denialFixture() {
  const frame = {},
    gateway = "http://gateway",
    traceID = "a".repeat(32);
  const url = gateway + "/api/app/workspace/v1/bootstrap";
  const page = { mainFrame: () => frame };
  const request = {
    method: () => "GET",
    frame: () => frame,
    url: () => url,
    redirectedFrom: () => null,
  };
  const denied = {
    url: () => url,
    status: () => 401,
    request: () => request,
    headers: () => ({ "x-antnest-trace-id": traceID }),
  };
  return { page, request, denied, gateway, traceID, url };
}

test("C4 records the original bootstrap 401 without requiring a body across automatic navigation", () => {
  const f = denialFixture();
  assert.deepEqual(
    c4BootstrapDenial(
      f.page,
      f.denied,
      f.gateway,
      "mobile_layout_input_completion",
    ),
    {
      url: f.url,
      method: "GET",
      status: 401,
      traceID: f.traceID,
      lastCompletedCheck: "mobile_layout_input_completion",
      body: "not_observed_during_auth_navigation",
    },
  );
});

for (const [name, change] of [
  [
    "success",
    (f) => {
      f.denied.status = () => 200;
    },
  ],
  [
    "server failure",
    (f) => {
      f.denied.status = () => 500;
    },
  ],
  [
    "forbidden",
    (f) => {
      f.denied.status = () => 403;
    },
  ],
  [
    "another API",
    (f) => {
      f.denied.url = () => f.gateway + "/api/app/workspace/v1/agents";
    },
  ],
  [
    "another origin",
    (f) => {
      f.denied.url = () => "http://other/api/app/workspace/v1/bootstrap";
    },
  ],
  [
    "query",
    (f) => {
      f.denied.url = () => f.url + "?other=1";
    },
  ],
  [
    "another method",
    (f) => {
      f.request.method = () => "POST";
    },
  ],
  [
    "another frame",
    (f) => {
      f.request.frame = () => ({});
    },
  ],
  [
    "redirect",
    (f) => {
      f.request.redirectedFrom = () => ({});
    },
  ],
  [
    "another request",
    (f) => {
      f.request.url = () => f.url + "/other";
    },
  ],
]) {
  test(`C4 does not exclude ${name} from the finite body audit`, () => {
    const f = denialFixture();
    change(f);
    assert.equal(c4BootstrapDenial(f.page, f.denied, f.gateway, null), null);
  });
}

test("C4 bootstrap denial requires its original Gateway Trace ID", () => {
  const f = denialFixture();
  f.denied.headers = () => ({});
  assert.throws(
    () => c4BootstrapDenial(f.page, f.denied, f.gateway, null),
    /Trace ID/,
  );
});

async function fixture(work, options = {}) {
  const page = new EventEmitter(),
    cleanup = [];
  const context = {
    close: async () => {
      cleanup.push("context");
      await options.close?.();
    },
  };
  return runC4BrowserScope(
    {
      signal: options.signal,
      launch: async () => ({
        newContext: async () => context,
        close: async () => {
          cleanup.push("browser");
          await options.close?.();
        },
      }),
    },
    (scope) => work({ page, scope, cleanup }),
  );
}

for (const action of ["navigate", "reload", "close", "offline"]) {
  test(`C4 ${action} waits for the current finite body without waiting for a future bootstrap`, async () => {
    const body = Promise.withResolvers(),
      future = Promise.withResolvers();
    const order = [];
    await fixture(async ({ page, scope }) => {
      scope.track(future.promise);
      const reader = observeC4Responses(page, scope, async () => {
        await body.promise;
        order.push("body captured");
      });
      page.emit("response", response());
      const pending = reader.before(async () => {
        order.push(action);
        future.resolve();
      });
      try {
        await turn();
        assert.deepEqual(
          order,
          [],
          "page changed before its body was captured",
        );
        body.resolve();
        await pending;
        assert.deepEqual(order, ["body captured", action]);
      } finally {
        body.resolve();
        future.resolve();
        await pending;
      }
    });
  });
}

test("C4 joins another finite response registered during the first body read", async () => {
  const first = Promise.withResolvers(),
    second = Promise.withResolvers();
  const order = [];
  await fixture(async ({ page, scope }) => {
    const reader = observeC4Responses(page, scope, async (_response, url) => {
      if (url.pathname.endsWith("bootstrap")) {
        await first.promise;
        page.emit("response", response("/api/app/workspace/v1/agents"));
      } else await second.promise;
      order.push(url.pathname);
    });
    page.emit("response", response());
    const pending = reader.before(() => order.push("closed"));
    try {
      first.resolve();
      await turn();
      assert.equal(order.includes("closed"), false);
      second.resolve();
      await pending;
      assert.equal(order.at(-1), "closed");
      assert.equal(order.length, 3);
    } finally {
      first.resolve();
      second.resolve();
      await pending;
    }
  });
});

test("C4 rechecks a response registered between an empty drain and navigation", async () => {
  const body = Promise.withResolvers();
  let changed = false;
  await fixture(async ({ page, scope }) => {
    const reader = observeC4Responses(page, scope, () => body.promise);
    queueMicrotask(() => page.emit("response", response()));
    const pending = reader.before(() => {
      changed = true;
    });
    try {
      await turn();
      assert.equal(changed, false);
      body.resolve();
      await pending;
      assert.equal(changed, true);
    } finally {
      body.resolve();
      await pending;
    }
  });
});

test("C4 rechecks earlier pages before a context-wide change", async () => {
  const firstBody = Promise.withResolvers(),
    secondBody = Promise.withResolvers();
  let changed = false;
  await fixture(async ({ page, scope }) => {
    const other = new EventEmitter();
    const first = observeC4Responses(page, scope, () => firstBody.promise);
    const second = observeC4Responses(other, scope, () => secondBody.promise);
    other.emit("response", response());
    const pending = beforeC4Responses([first, second], () => {
      changed = true;
    });
    try {
      await turn();
      page.emit("response", response());
      secondBody.resolve();
      await turn();
      assert.equal(changed, false);
      firstBody.resolve();
      await pending;
      assert.equal(changed, true);
    } finally {
      firstBody.resolve();
      secondBody.resolve();
      await pending;
    }
  });
});

test("C4 drains only the selected page and excludes long-lived streams", async () => {
  const otherBody = Promise.withResolvers();
  const observed = [];
  await fixture(async ({ page, scope }) => {
    const other = new EventEmitter();
    const reader = observeC4Responses(page, scope, async (value) => {
      observed.push(value.url());
    });
    observeC4Responses(other, scope, () => otherBody.promise);
    other.emit("response", response());
    for (const path of [
      "/api/app/a/watch",
      "/api/app/a/events",
      "/api/session/login",
    ])
      page.emit("response", response(path));
    page.emit(
      "response",
      response("/api/app/stream", "text/event-stream; charset=utf-8"),
    );
    page.emit("response", response());
    try {
      await reader.before(() => observed.push("navigation"));
      assert.deepEqual(observed, [
        "http://gateway/api/app/workspace/v1/bootstrap",
        "navigation",
      ]);
    } finally {
      otherBody.resolve();
    }
  });
});

test("C4 keeps a body failure after it settles and prevents later navigation", async () => {
  const original = new Error("original body unavailable");
  let changed = false;
  const cleanup = [];
  await assert.rejects(
    fixture(
      async ({ page, scope }) => {
        const reader = observeC4Responses(page, scope, async () => {
          throw original;
        });
        page.emit("response", response());
        await turn();
        await assert.rejects(
          reader.before(() => {
            changed = true;
          }),
          (error) => error === original,
        );
        assert.equal(changed, false);
      },
      { close: () => cleanup.push("closed") },
    ),
    (error) => error === original,
  );
  assert.deepEqual(cleanup, ["closed", "closed"]);
});

test("C4 normal context closure follows all finite body reads", async () => {
  const body = Promise.withResolvers(),
    order = [];
  await fixture(
    async ({ page, scope }) => {
      const reader = observeC4Responses(page, scope, async () => {
        await body.promise;
        order.push("body");
      });
      page.emit("response", response());
      const pending = reader.before(() => scope.closeContext());
      try {
        await turn();
        assert.deepEqual(order, []);
        body.resolve();
        await pending;
      } finally {
        body.resolve();
        await pending;
      }
    },
    { close: () => order.push("closed") },
  );
  assert.deepEqual(order, ["body", "closed", "closed"]);
});

test("C4 abort closes resources to unblock body reads and retains both failures", async () => {
  const body = Promise.withResolvers(),
    abort = new AbortController();
  const cancellation = new Error("original cancellation"),
    readError = new Error("body cancelled");
  let joined = false;
  await assert.rejects(
    fixture(
      async ({ page, scope }) => {
        const reader = observeC4Responses(page, scope, async () => {
          try {
            await body.promise;
          } finally {
            joined = true;
          }
        });
        page.emit("response", response());
        abort.abort(cancellation);
        await reader.wait();
      },
      {
        signal: abort.signal,
        close: () => body.reject(readError),
      },
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(
        new Set(error.errors),
        new Set([cancellation, readError]),
      );
      return true;
    },
  );
  assert.equal(joined, true);
});

test("C4 captures an actual browser response before cross-document navigation", async (t) => {
  const server = createServer((request, reply) => {
    if (request.url.startsWith("/api/app/"))
      reply
        .writeHead(200, { "content-type": "application/json" })
        .end('{"captured":true}');
    else
      reply
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>C4 finite response</title>");
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
  const received = Promise.withResolvers(),
    release = Promise.withResolvers();
  await runC4BrowserScope(
    {
      launch: () =>
        chromium.launch({
          headless: true,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
        }),
    },
    async (scope) => {
      const page = await scope.context.newPage();
      await page.goto(`${gateway}/first`);
      const bodies = [];
      const reader = observeC4Responses(page, scope, async (value) => {
        received.resolve();
        await release.promise;
        bodies.push(await value.text());
      });
      await page.evaluate(() => {
        void fetch("/api/app/workspace/v1/bootstrap");
      });
      await received.promise;
      const navigation = reader.before(() => page.goto(`${gateway}/second`));
      try {
        await turn();
        assert.equal(page.url(), `${gateway}/first`);
        assert.deepEqual(bodies, []);
        release.resolve();
        await navigation;
        assert.deepEqual(bodies, ['{"captured":true}']);
        assert.equal(page.url(), `${gateway}/second`);
      } finally {
        release.resolve();
        await navigation;
      }
    },
  );
});

test("C4 records the bootstrap denial while the page itself redirects after consuming its body", async (t) => {
  const server = createServer((request, reply) => {
    if (request.url.startsWith("/api/app/"))
      reply
        .writeHead(401, {
          "content-type": "application/json",
          "x-antnest-trace-id": "a".repeat(32),
        })
        .end('{"error":"unauthorized"}');
    else
      reply
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>C4 authorization</title>");
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
  await runC4BrowserScope(
    {
      launch: () =>
        chromium.launch({
          headless: true,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
        }),
    },
    async (scope) => {
      const page = await scope.context.newPage();
      await page.goto(`${gateway}/workspace`);
      const bodies = [],
        denials = [];
      const reader = observeC4Responses(page, scope, async (value) => {
        const denial = c4BootstrapDenial(
          page,
          value,
          gateway,
          "mobile_layout_input_completion",
        );
        if (denial) denials.push(denial);
        else bodies.push({ status: value.status(), text: await value.text() });
      });
      await page.evaluate(() => {
        void (async () => {
          const reply = await fetch("/api/app/workspace/v1/bootstrap");
          await reply.json();
          if (reply.status === 401) window.location.assign("/login");
        })();
      });
      await page.waitForURL(`${gateway}/login`);
      await reader.wait();
      assert.deepEqual(bodies, []);
      assert.deepEqual(denials, [
        {
          url: `${gateway}/api/app/workspace/v1/bootstrap`,
          method: "GET",
          status: 401,
          traceID: "a".repeat(32),
          lastCompletedCheck: "mobile_layout_input_completion",
          body: "not_observed_during_auth_navigation",
        },
      ]);
    },
  );
});
