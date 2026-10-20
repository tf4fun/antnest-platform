import assert from "node:assert/strict";
import test from "node:test";
import { inspectLoadWire } from "./resolve-cache-load.mjs";
import * as flow from "./resolve-cache-flow.mjs";

const id = (n) => n.toString(16).padStart(32, "0");
const page = () => ({ items: [], nextCursor: null });
function wireFixture() {
  return {
    policy_revision: 4,
    transport: "http",
    profile: "workspace",
    agent_id: "agent",
    started_at: 10,
    completed_at: 6010,
    requests: Array.from({ length: 100 }, (_, index) => {
      const started = index === 99 ? 6000 : 10 + index * 20;
      return {
        method: "GET",
        path: "/api/app/workspace/v1/agents/agent/sessions",
        trace_id: id(index + 1),
        status: 200,
        started_at: started,
        headers_at: started + 1,
        completed_at: started + 10,
        body_complete: true,
        body_bytes: Buffer.byteLength(JSON.stringify(page())),
        body: page(),
        content_type: "application/json; charset=utf-8",
        cache_control: "no-store",
        set_cookie_count: 0,
      };
    }),
  };
}

test("policy4 load accepts exactly 100 complete sequential HTTP session pages", () => {
  const wire = wireFixture();
  assert.equal(inspectLoadWire(wire).length, 100);
  wire.requests[1].body = {
    items: [
      {
        sessionId: "session",
        title: "",
        updatedAt: null,
        activeOperationId: null,
      },
    ],
    nextCursor: "partial-page-cursor",
  };
  wire.requests[2].body = {
    items: [
      {
        sessionId: "session",
        title: "Title",
        updatedAt: "opaque timestamp",
        activeOperationId: "operation",
      },
    ],
    nextCursor: null,
  };
  assert.equal(inspectLoadWire(wire).length, 100);
});

for (const [name, mutate] of [
  ["99 requests", (w) => w.requests.pop()],
  ["101st public initialization", (w) => w.requests.push(w.requests.at(-1))],
  ["missing response trace", (w) => delete w.requests[1].trace_id],
  [
    "duplicate response trace",
    (w) => {
      w.requests[1].trace_id = w.requests[0].trace_id;
    },
  ],
  [
    "legacy transport",
    (w) => {
      w.transport = "websocket";
    },
  ],
  [
    "wrong profile",
    (w) => {
      w.profile = "acp";
    },
  ],
  [
    "different Agent",
    (w) => {
      w.requests[1].path = "/api/app/workspace/v1/agents/other/sessions";
    },
  ],
  [
    "activity request",
    (w) => {
      w.requests[1].path = "/api/session/activity";
    },
  ],
  [
    "POST instead of GET",
    (w) => {
      w.requests[1].method = "POST";
    },
  ],
  [
    "redirect",
    (w) => {
      w.requests[1].status = 302;
    },
  ],
  [
    "incomplete body",
    (w) => {
      w.requests[1].body_complete = false;
    },
  ],
  [
    "missing body bytes",
    (w) => {
      w.requests[1].body_bytes = 0;
    },
  ],
  [
    "timer ends at headers",
    (w) => {
      w.completed_at = w.requests.at(-1).headers_at;
    },
  ],
  [
    "over eight seconds including final body",
    (w) => {
      w.completed_at = 8011;
      w.requests.at(-1).completed_at = 8011;
    },
  ],
  [
    "timer starts after send",
    (w) => {
      w.started_at = 11;
    },
  ],
  [
    "overlapping requests",
    (w) => {
      w.requests[1].started_at = w.requests[0].completed_at - 1;
    },
  ],
  [
    "nonmonotonic headers",
    (w) => {
      w.requests[1].headers_at = w.requests[1].started_at - 1;
    },
  ],
  [
    "final request before half TTL",
    (w) => {
      Object.assign(w.requests.at(-1), {
        started_at: 2000,
        headers_at: 2001,
        completed_at: 2010,
      });
      w.completed_at = 2010;
    },
  ],
  [
    "old ACP list DTO",
    (w) => {
      w.requests[1].body = { sessions: [] };
    },
  ],
  [
    "unexpected response field",
    (w) => {
      w.requests[1].body.extra = true;
    },
  ],
  [
    "invalid cursor",
    (w) => {
      w.requests[1].body.nextCursor = "";
    },
  ],
  [
    "missing session fields",
    (w) => {
      w.requests[1].body.items.push({ sessionId: "session" });
    },
  ],
  [
    "invalid nullable field",
    (w) => {
      w.requests[1].body.items.push({
        sessionId: "session",
        title: "",
        updatedAt: false,
        activeOperationId: null,
      });
    },
  ],
  [
    "non-JSON response",
    (w) => {
      w.requests[1].content_type = "text/html";
    },
  ],
  [
    "cacheable response",
    (w) => {
      w.requests[1].cache_control = "public";
    },
  ],
  [
    "session rotation",
    (w) => {
      w.requests[1].set_cookie_count = 1;
    },
  ],
]) {
  test(`HTTP load rejects ${name}`, () => {
    const wire = wireFixture();
    inspectLoadWire(wire);
    mutate(wire);
    assert.throws(() => inspectLoadWire(wire));
  });
}

function measurement() {
  let clock = 10;
  const calls = [],
    waits = [],
    wire = {};
  const controller = new AbortController();
  const options = {
    gateway: "https://gateway.example",
    agentID: "agent",
    cookie: "session=synthetic-private-token",
    signal: controller.signal,
    wire,
    now: () => clock,
    wait: async (ms, _value, { signal }) => {
      signal.throwIfAborted();
      waits.push(ms);
      clock += ms;
    },
    request: async (url, init) => {
      const index = calls.length;
      const call = { url, init, started: clock, bodyRead: false };
      assert(
        calls.every((previous) => previous.bodyRead),
        "next request preceded body EOF",
      );
      calls.push(call);
      clock += 1;
      return {
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-antnest-trace-id": id(index + 1),
        }),
        text: async () => {
          clock += index === 0 ? 500 : 2;
          call.bodyRead = true;
          call.completed = clock;
          return JSON.stringify(page());
        },
      };
    },
  };
  return {
    options,
    calls,
    waits,
    wire,
    controller,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("measurer sends one fixed Cookie scope, awaits every body, and delays only the 100th request", async () => {
  const f = measurement();
  await flow.measureResolveLoad(f.options);
  assert.equal(f.calls.length, 100);
  assert.equal(f.waits.length, 1);
  assert(f.calls[99].started >= f.calls[0].completed + 5000);
  assert(
    f.calls.slice(0, 99).every((c) => c.started < f.calls[0].completed + 5000),
  );
  for (const call of f.calls) {
    assert.equal(
      call.url,
      "https://gateway.example/api/app/workspace/v1/agents/agent/sessions",
    );
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "manual");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("cookie"), f.options.cookie);
    assert.equal(headers.get("origin"), "https://gateway.example");
    assert.equal(headers.get("traceparent"), null);
    assert.equal(call.init.body, undefined);
  }
  assert.equal(f.wire.started_at, f.calls[0].started);
  assert.equal(f.wire.completed_at, f.calls.at(-1).completed);
  assert.equal(inspectLoadWire(f.wire).length, 100);
  assert(!JSON.stringify(f.wire).includes("synthetic-private-token"));
});

test("measurer rejects the full-body eight-second overrun even when headers arrived in budget", async () => {
  const f = measurement(),
    request = f.options.request;
  f.options.request = async (...args) => {
    const response = await request(...args);
    if (f.calls.length === 100) {
      const read = response.text;
      response.text = async () => {
        f.advance(3000);
        return read();
      };
    }
    return response;
  };
  await assert.rejects(flow.measureResolveLoad(f.options), /eight seconds/u);
  assert(f.wire.requests.at(-1).headers_at - f.wire.started_at < 8000);
});

test("measurer propagates cancellation through fetch and never sends the next request", async () => {
  const f = measurement();
  f.options.request = async (_url, { signal }) => {
    f.controller.abort();
    signal.throwIfAborted();
  };
  await assert.rejects(flow.measureResolveLoad(f.options));
  assert.equal(f.wire.requests.length, 1);
  assert.notEqual(f.wire.requests[0].body_complete, true);
});

for (const stage of ["request", "body", "json"]) {
  test(`measurer preserves partial evidence but does not expose ${stage} failure contents`, async () => {
    const f = measurement(),
      request = f.options.request;
    f.options.request = async (...args) => {
      if (stage === "request") throw new Error(f.options.cookie);
      const response = await request(...args);
      response.text = async () => {
        if (stage === "body") throw new Error(f.options.cookie);
        return f.options.cookie;
      };
      return response;
    };
    await assert.rejects(flow.measureResolveLoad(f.options), (error) => {
      assert(!String(error.stack).includes("synthetic-private-token"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.wire.requests.length, 1);
    assert(!JSON.stringify(f.wire).includes("synthetic-private-token"));
  });
}

for (const stage of [
  "error DTO",
  "valid DTO",
  "trace header",
  "content type",
  "cache control",
]) {
  test(`measurer rejects private ${stage} before recording it or dispatching again`, async () => {
    const f = measurement(),
      request = f.options.request;
    f.options.request = async (...args) => {
      const response = await request(...args);
      const read = response.text;
      if (stage === "error DTO")
        response.text = async () => {
          await read();
          return JSON.stringify({ error: f.options.cookie });
        };
      if (stage === "valid DTO")
        response.text = async () => {
          await read();
          return JSON.stringify({
            items: [
              {
                sessionId: "session",
                title: "synthetic-private-token",
                updatedAt: null,
                activeOperationId: null,
              },
            ],
            nextCursor: null,
          });
        };
      if (stage === "trace header")
        response.headers.set("x-antnest-trace-id", f.options.cookie);
      if (stage === "content type")
        response.headers.set(
          "content-type",
          "application/json; private=" + f.options.cookie,
        );
      if (stage === "cache control")
        response.headers.set(
          "cache-control",
          "no-store, private=" + f.options.cookie,
        );
      return response;
    };
    await assert.rejects(flow.measureResolveLoad(f.options), (error) => {
      assert(!String(error.stack).includes("synthetic-private-token"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.wire.requests.length, 1);
    assert(!JSON.stringify(f.wire).includes("synthetic-private-token"));
  });
}

for (const stage of ["before dispatch", "half-TTL wait"]) {
  test(`measurer sanitizes cancellation ${stage} and does not dispatch again`, async () => {
    const f = measurement();
    if (stage === "before dispatch")
      f.controller.abort(new Error(f.options.cookie));
    else
      f.options.wait = async () => {
        f.controller.abort(new Error(f.options.cookie));
        throw new Error("private wait: " + f.options.cookie, {
          cause: f.controller.signal.reason,
        });
      };
    await assert.rejects(flow.measureResolveLoad(f.options), (error) => {
      assert(!String(error.stack).includes("synthetic-private-token"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.calls.length, stage === "before dispatch" ? 0 : 99);
    assert(!JSON.stringify(f.wire).includes("synthetic-private-token"));
  });
}
