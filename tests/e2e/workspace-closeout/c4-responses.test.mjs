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

const request = (path = "/api/app/workspace/v1/bootstrap") => ({
  url: () => `http://gateway${path}`,
  method: () => "GET",
  resourceType: () => "fetch",
  redirectedFrom: () => null,
  redirectedTo: () => null,
  response: () => Promise.resolve(null),
  failure: () => null,
});
const response = (
  path = "/api/app/workspace/v1/bootstrap",
  type = "application/json",
  original = request(path),
) => {
  const value = {
    url: () => `http://gateway${path}`,
    status: () => 200,
    headers: () => ({ "content-type": type }),
    request: () => original,
  };
  original.response = () => Promise.resolve(value);
  return value;
};
function emitResponse(page, value = response()) {
  const original = value.request();
  page.emit("request", original);
  page.emit("response", value);
  page.emit("requestfinished", original);
  return value;
}

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
  let pageClosed = false;
  const closePage = () => {
    if (!pageClosed) {
      pageClosed = true;
      page.emit("close");
    }
  };
  const context = {
    close: async () => {
      cleanup.push("context");
      closePage();
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
          closePage();
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
      emitResponse(page);
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
        emitResponse(page, response("/api/app/workspace/v1/agents"));
      } else await second.promise;
      order.push(url.pathname);
    });
    emitResponse(page);
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
    queueMicrotask(() => emitResponse(page));
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
    emitResponse(other);
    const pending = beforeC4Responses([first, second], () => {
      changed = true;
    });
    try {
      await turn();
      emitResponse(page);
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
    emitResponse(other);
    for (const path of [
      "/api/app/a/watch",
      "/api/app/a/events",
      "/api/session/login",
    ])
      emitResponse(page, response(path));
    emitResponse(
      page,
      response("/api/app/stream", "text/event-stream; charset=utf-8"),
    );
    emitResponse(page);
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
        emitResponse(page);
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
      emitResponse(page);
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
        emitResponse(page);
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

test("C4 requestfailed without a response releases the finite request", async () => {
  await fixture(async ({ page, scope }) => {
    const captured = [];
    const reader = observeC4Responses(page, scope, (value) => {
      captured.push(value);
      return Promise.resolve();
    });
    const original = request("/api/app/workspace/v1/process");
    page.emit("request", original);
    let changed = false;
    const pending = reader.before(() => {
      changed = true;
    });
    try {
      await turn();
      assert.equal(changed, false);
      original.failure = () => ({ errorText: "net::ERR_ABORTED" });
      page.emit("requestfailed", original);
      await pending;
      assert.equal(changed, true);
      assert.equal(reader.ready(), true);
      assert.deepEqual(captured, []);
    } finally {
      page.emit("requestfailed", original);
      await scope.capture(() => pending);
    }
  });
});

test("C4 captured response still waits for requestfinished", async () => {
  await fixture(async ({ page, scope }) => {
    const captured = Promise.withResolvers();
    const reader = observeC4Responses(page, scope, () => {
      captured.resolve();
      return Promise.resolve();
    });
    const value = response();
    page.emit("request", value.request());
    page.emit("response", value);
    await captured.promise;
    let changed = false;
    const pending = reader.before(() => {
      changed = true;
    });
    try {
      await turn();
      assert.equal(changed, false, "capture alone is not a terminal request");
      page.emit("requestfinished", value.request());
      await pending;
      assert.equal(changed, true);
    } finally {
      page.emit("requestfinished", value.request());
      await scope.capture(() => pending);
    }
  });
});

test("C4 requestfinished still waits for the response body capture", async () => {
  const body = Promise.withResolvers();
  const order = [];
  await fixture(async ({ page, scope }) => {
    const reader = observeC4Responses(page, scope, async () => {
      await body.promise;
      order.push("captured");
    });
    const value = response();
    page.emit("request", value.request());
    page.emit("response", value);
    page.emit("requestfinished", value.request());
    const pending = reader.before(() => order.push("navigation"));
    try {
      await turn();
      assert.deepEqual(order, []);
      body.resolve();
      await pending;
      assert.deepEqual(order, ["captured", "navigation"]);
    } finally {
      body.resolve();
      await scope.capture(() => pending);
    }
  });
});

test("C4 follows a redirect chain until the target request and body finish", async () => {
  const body = Promise.withResolvers();
  const targetReceived = Promise.withResolvers();
  await fixture(async ({ page, scope }) => {
    const source = request("/api/app/workspace/v1/redirect");
    const target = request("/api/app/workspace/v1/process");
    source.redirectedTo = () => target;
    target.redirectedFrom = () => source;
    const redirect = response(
      "/api/app/workspace/v1/redirect",
      "application/json",
      source,
    );
    redirect.status = () => 302;
    redirect.headers = () => ({
      location: target.url(),
      "content-type": "application/json",
    });
    const final = response(
      "/api/app/workspace/v1/process",
      "application/json",
      target,
    );
    const reader = observeC4Responses(page, scope, async (value) => {
      if (value.request() === target) {
        targetReceived.resolve();
        await body.promise;
      }
    });
    page.emit("request", source);
    page.emit("response", redirect);
    page.emit("requestfinished", source);
    page.emit("request", target);
    let changed = false;
    const pending = reader.before(() => {
      changed = true;
    });
    try {
      await turn();
      assert.equal(changed, false, "redirect target has not returned headers");
      page.emit("response", final);
      page.emit("requestfinished", target);
      await targetReceived.promise;
      await turn();
      assert.equal(
        changed,
        false,
        "redirect target body has not been captured",
      );
      body.resolve();
      await pending;
      assert.equal(changed, true);
    } finally {
      body.resolve();
      page.emit("requestfailed", target);
      await scope.capture(() => pending);
    }
  });
});

test("C4 releases an unknown stream route when SSE response headers arrive", async () => {
  await fixture(async ({ page, scope }) => {
    const captured = [];
    const reader = observeC4Responses(page, scope, (value) => {
      captured.push(value);
      return Promise.resolve();
    });
    const value = response(
      "/api/app/future-stream",
      "text/event-stream; charset=utf-8",
    );
    page.emit("request", value.request());
    let changed = false;
    const pending = reader.before(() => {
      changed = true;
    });
    try {
      await turn();
      assert.equal(changed, false);
      page.emit("response", value);
      // No terminal event: this stream remains open while navigation is allowed.
      await turn();
      assert.equal(changed, true);
      await pending;
      assert.equal(reader.ready(), true);
      assert.deepEqual(captured, []);
    } finally {
      page.emit("requestfailed", value.request());
      await scope.capture(() => pending);
    }
  });
});

for (const suffix of ["watch", "events"]) {
  test(`C4 excludes /${suffix} before response headers exist`, async () => {
    await fixture(async ({ page, scope }) => {
      const reader = observeC4Responses(page, scope, () => {
        throw new Error("Stream body must not be captured");
      });
      const original = request(`/api/app/workspace/v1/${suffix}`);
      page.emit("request", original);
      let changed = false;
      const pending = reader.before(() => {
        changed = true;
      });
      try {
        await turn();
        assert.equal(changed, true);
        await pending;
        assert.equal(reader.ready(), true);
      } finally {
        page.emit("requestfailed", original);
        await scope.capture(() => pending);
      }
    });
  });
}

test("C4 context close joins an issued request that never received a response", async () => {
  let joined = false;
  await fixture(async ({ page, scope }) => {
    const reader = observeC4Responses(page, scope, () => {
      throw new Error("Closed request has no response body");
    });
    page.emit("request", request());
    const pending = reader.wait().then(() => {
      joined = true;
    });
    try {
      await turn();
      assert.equal(joined, false);
      await scope.closeContext();
      await pending;
      assert.equal(joined, true);
    } finally {
      await scope.closeContext();
      await scope.capture(() => pending);
    }
  });
  assert.equal(joined, true);
});

test("C4 abort joins an issued request without a response and preserves cancellation", async () => {
  const abort = new AbortController();
  const cancellation = new Error("cancel before response headers");
  let joined = false;
  await assert.rejects(
    fixture(
      async ({ page, scope }) => {
        const reader = observeC4Responses(page, scope, () => {
          throw new Error("Cancelled request has no response body");
        });
        page.emit("request", request());
        const pending = reader.wait().then(() => {
          joined = true;
        });
        try {
          await turn();
          assert.equal(joined, false);
          abort.abort(cancellation);
          await pending;
          assert.equal(joined, true);
        } finally {
          abort.abort(cancellation);
          await scope.capture(() => pending);
        }
      },
      { signal: abort.signal },
    ),
    (error) => error === cancellation,
  );
  assert.equal(joined, true);
});

test("C4 page close still joins capture for an already finished request", async () => {
  const body = Promise.withResolvers();
  let joined = false;
  await fixture(async ({ page, scope }) => {
    const reader = observeC4Responses(page, scope, () => body.promise);
    emitResponse(page);
    const pending = reader.wait().then(() => {
      joined = true;
    });
    try {
      await scope.closeContext();
      await turn();
      assert.equal(joined, false);
      body.resolve();
      await pending;
      assert.equal(joined, true);
    } finally {
      body.resolve();
      await scope.capture(() => pending);
    }
  });
});

test(
  "C4 reload waits for an issued process request whose response headers are held",
  { timeout: 15_000 },
  async (t) => {
    const path =
      "/api/app/workspace/v1/agents/agent/sessions/session/turns/run/process";
    const payload = '{"items":[{"text":"original process body"}]}';
    const serverReceived = Promise.withResolvers();
    void serverReceived.promise.catch(() => {});
    let heldReply;
    let processRequests = 0;
    const releaseResponse = () => {
      if (heldReply && !heldReply.destroyed && !heldReply.writableEnded)
        heldReply
          .writeHead(200, { "content-type": "application/json" })
          .end(payload);
    };
    const server = createServer((incoming, reply) => {
      if (incoming.url === path) {
        processRequests++;
        heldReply = reply;
        serverReceived.resolve();
      } else {
        reply
          .writeHead(200, { "content-type": "text/html" })
          .end("<title>Held process request</title>");
      }
    });
    const cancelled = () => serverReceived.reject(t.signal.reason);
    t.signal.addEventListener("abort", cancelled, { once: true });
    t.after(async () => {
      t.signal.removeEventListener("abort", cancelled);
      releaseResponse();
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal: t.signal });
    const gateway = `http://127.0.0.1:${server.address().port}`;
    await runC4BrowserScope(
      {
        signal: t.signal,
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
          bodies.push(await value.text());
        });
        const browserIssued = page.waitForRequest(
          (value) => value.url() === gateway + path,
          { timeout: 5000 },
        );
        void browserIssued.catch(() => {});
        let navigation;
        let navigationStarted = false;
        let bodiesAtNavigation;
        try {
          await page.evaluate((url) => {
            void fetch(url).catch(() => {});
          }, path);
          // Both peers have observed the request; the server has sent no headers.
          await Promise.all([browserIssued, serverReceived.promise]);
          assert.equal(heldReply.headersSent, false);
          assert.equal(processRequests, 1);
          navigation = reader.before(() => {
            navigationStarted = true;
            bodiesAtNavigation = [...bodies];
            return page.reload();
          });
          void navigation.catch(() => {});
          await turn();
          assert.equal(
            navigationStarted,
            false,
            "reload began before the issued process request returned headers",
          );
          assert.equal(page.url(), `${gateway}/first`);
          assert.deepEqual(bodies, []);
          releaseResponse();
          await navigation;
          assert.equal(navigationStarted, true);
          assert.deepEqual(bodiesAtNavigation, [payload]);
          assert.deepEqual(bodies, [payload]);
          assert.equal(processRequests, 1);
        } finally {
          releaseResponse();
          await scope.capture(() => browserIssued);
          if (navigation) await scope.capture(() => navigation);
        }
      },
    );
  },
);

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
