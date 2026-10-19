import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { view } from "../edge-gateway/resolve-cache-stream-fixtures.mjs";

const url = new URL("./development-browser-flow.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture() {
  const current = view("session-1", "cursor");
  const receipt = {
    agentId: "agent-1",
    sessionId: "session-1",
    body: {
      operationId: "original-operation",
      acceptance: "bridge",
      phase: "dispatching",
    },
    request: { body: { prompt: [{ type: "text", text: "Read the marker" }] } },
  };
  const operation = {
    operationId: "original-operation",
    sessionId: "session-1",
    phase: "completed",
    acceptance: "acp",
    runId: "original-run",
    outputWatermark: 2,
    stopReason: "end_turn",
  };
  const turn = {
    turnId: "original-run",
    outcome: "completed",
    prompt: receipt.request.body.prompt,
    finalResponse: [{ type: "text", text: "Read " }],
    contentCursor: "answer-page",
    contentSection: "finalResponse",
    processVersion: 2,
    processCount: 2,
  };
  current.selectedView.operations.push(operation);
  current.selectedView.turns.push(turn);
  const select = () => {
    assert.equal(typeof implementation.developmentCompletedTurn, "function");
    return implementation.developmentCompletedTurn(current, receipt);
  };
  return { current, receipt, operation, turn, select };
}

test("Development binds completion to the admitted operation and its actual Run turn", () => {
  const f = fixture();
  assert.deepEqual(f.select(), { operation: f.operation, turn: f.turn });
});
for (const [name, change] of [
  [
    "admission only",
    (f) => {
      f.operation.phase = "dispatching";
    },
  ],
  [
    "another completed operation",
    (f) => {
      f.operation.operationId = "older-operation";
    },
  ],
  [
    "another completed turn",
    (f) => {
      f.turn.turnId = "older-run";
    },
  ],
  [
    "turn still running",
    (f) => {
      f.turn.outcome = "running";
    },
  ],
  [
    "output not yet projected",
    (f) => {
      f.current.selectedView.outputWatermark = 1;
    },
  ],
])
  test(`Development does not accept ${name} as completion`, () => {
    const f = fixture();
    change(f);
    assert.equal(f.select(), null);
  });
for (const [name, change] of [
  [
    "foreign Agent",
    (f) => {
      f.receipt.agentId = "foreign";
    },
  ],
  [
    "foreign Session",
    (f) => {
      f.receipt.sessionId = "foreign";
    },
  ],
  [
    "failed operation",
    (f) => {
      f.operation.phase = "failed";
    },
  ],
  [
    "cancelled operation",
    (f) => {
      f.operation.phase = "cancelled";
    },
  ],
  [
    "uncertain operation",
    (f) => {
      f.operation.phase = "uncertain";
    },
  ],
  [
    "unaccepted completion",
    (f) => {
      f.operation.acceptance = "bridge";
    },
  ],
  [
    "wrong stop reason",
    (f) => {
      f.operation.stopReason = "refusal";
    },
  ],
  [
    "failed actual turn",
    (f) => {
      f.turn.outcome = "failed";
    },
  ],
])
  test(`Development rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(f.select);
  });

async function serverFixture(t) {
  assert.equal(typeof implementation.readDevelopmentTurn, "function");
  const f = fixture(),
    wire = [];
  f.pages = [
    {
      turnId: f.turn.turnId,
      processVersion: 2,
      items: [
        {
          id: "thought",
          kind: "thought",
          summary: "Checking",
          status: "completed",
          content: [],
          contentCursor: null,
        },
      ],
      nextCursor: "process-next",
    },
    {
      turnId: f.turn.turnId,
      processVersion: 2,
      items: [
        {
          id: "read",
          kind: "tool",
          summary: "Read file",
          status: "completed",
          content: [],
          contentCursor: null,
          toolSections: { detailStartIndex: 0 },
        },
      ],
      nextCursor: null,
    },
  ];
  const server = createServer((request, response) => {
    const address = new URL(request.url, "http://fixture");
    wire.push({
      path: address.pathname,
      cursor: address.searchParams.get("cursor"),
      cookie: request.headers.cookie,
    });
    const result = address.pathname.endsWith("/content")
      ? {
          section: "finalResponse",
          items: [{ type: "text", text: "MARKER" }],
          nextCursor: null,
          complete: true,
        }
      : f.pages[address.searchParams.has("cursor") ? 1 : 0];
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  f.config = {
    gateway: "http://127.0.0.1:" + server.address().port,
    agentId: "agent-1",
    cookies: [
      { name: "antnest_session", value: "original-session" },
      { name: "antnest_csrf", value: "original-csrf" },
    ],
  };
  f.evidence = {};
  f.read = () =>
    implementation.readDevelopmentTurn(
      f.config,
      "session-1",
      f.turn,
      f.evidence,
    );
  f.wire = wire;
  return f;
}

test("Development reads complete content and process pages with original browser authority", async (t) => {
  const f = await serverFixture(t),
    result = await f.read();
  assert.equal(
    implementation.assertDevelopmentTurnContent(f.receipt, result, {
      marker: "MARKER",
      requireTools: true,
    }),
    "Read MARKER",
  );
  assert.equal(result.process.length, 2);
  assert.equal(f.evidence.process_pages.length, 2);
  assert.equal(f.wire.length, 3);
  assert(
    f.wire.every(
      (row) =>
        row.cookie ===
        "antnest_session=original-session; antnest_csrf=original-csrf",
    ),
  );
  assert(
    f.wire.every((row) =>
      row.path.startsWith(
        "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/original-run/",
      ),
    ),
  );
  assert.deepEqual(
    f.wire.map((row) => row.cursor),
    ["answer-page", null, "process-next"],
  );
});
for (const [name, change] of [
  [
    "foreign process turn",
    (f) => {
      f.pages[1].turnId = "another-run";
    },
  ],
  [
    "changed process version",
    (f) => {
      f.pages[1].processVersion++;
    },
  ],
  [
    "repeated process item",
    (f) => {
      f.pages[1].items[0].id = "thought";
    },
  ],
  [
    "premature final page",
    (f) => {
      f.pages[0].nextCursor = null;
    },
  ],
])
  test(`Development rejects ${name} in actual paged responses`, async (t) => {
    const f = await serverFixture(t);
    change(f);
    await assert.rejects(f.read());
  });

for (const [name, change] of [
  [
    "empty current answer",
    (d) => {
      d.content.finalResponse = [];
    },
  ],
  [
    "marker only in another turn",
    (d) => {
      d.content.finalResponse[0].text = "Other reply";
    },
  ],
  [
    "foreign prompt content",
    (d) => {
      d.content.prompt[0].text = "Other question";
    },
  ],
  [
    "no completed tool in this turn",
    (d) => {
      d.process[0].status = "failed";
    },
  ],
])
  test(`Development rejects ${name} despite older successful history`, () => {
    const f = fixture(),
      detail = {
        content: structuredClone({
          prompt: f.receipt.request.body.prompt,
          finalResponse: [{ type: "text", text: "MARKER" }],
        }),
        process: [{ kind: "tool", status: "completed" }],
      };
    change(detail);
    assert.equal(
      typeof implementation.assertDevelopmentTurnContent,
      "function",
    );
    assert.throws(() =>
      implementation.assertDevelopmentTurnContent(f.receipt, detail, {
        marker: "MARKER",
        requireTools: true,
      }),
    );
  });

test("Development request observer catches a reload Prompt even when its response fails", () => {
  assert.equal(typeof implementation.observeDevelopmentRequests, "function");
  const page = new EventEmitter(),
    records = [];
  implementation.observeDevelopmentRequests(page, records);
  const before = {
    sessionId: "session",
    turns: [{ turnId: "run", text: "MARKER" }],
  };
  const requestCount = records.length;
  page.emit("request", {
    method: () => "POST",
    url: () =>
      "http://127.0.0.1:8123/api/app/workspace/v1/agents/agent/sessions/session/prompts",
    postData: () => '{"prompt":[]}',
  });
  assert.equal(records.length, 1);
  assert.throws(
    () =>
      implementation.assertDevelopmentReload(
        before,
        structuredClone(before),
        requestCount,
        records.length,
      ),
    /Reload repeated prompt/,
  );
});
test("Development reload requires identical Session and retained content", () => {
  assert.equal(typeof implementation.assertDevelopmentReload, "function");
  const before = {
    sessionId: "session",
    turns: [{ turnId: "run", text: "MARKER" }],
  };
  implementation.assertDevelopmentReload(before, structuredClone(before), 2, 2);
  for (const after of [
    { ...before, sessionId: "foreign" },
    { ...before, turns: [] },
  ])
    assert.throws(() =>
      implementation.assertDevelopmentReload(before, after, 2, 2),
    );
});

function scopeFixture() {
  assert.equal(typeof implementation.runDevelopmentBrowserScope, "function");
  const report = {},
    events = [],
    context = {
      close: async () => {
        events.push("context");
      },
    };
  const browser = {
    newContext: async () => context,
    close: async () => {
      events.push("browser");
    },
  };
  const run = (work) =>
    implementation.runDevelopmentBrowserScope(
      {
        launch: async () => browser,
        report,
        preserve: async (value) => {
          events.push("save");
          assert.equal(value, report);
        },
      },
      work,
    );
  return { report, events, context, browser, run };
}
test("Development passing report is preserved only after browser cleanup", async () => {
  const f = scopeFixture();
  await f.run(async () => {
    f.events.push("work");
    assert.notEqual(f.report.status, "passed");
  });
  assert.deepEqual(f.events, ["work", "context", "browser", "save"]);
  assert.equal(f.report.status, "passed");
});
test("Development retains original body and cleanup errors and saves a failed report", async () => {
  const f = scopeFixture(),
    body = new Error("original body read"),
    cleanup = new Error("original browser cleanup");
  f.browser.close = async () => {
    throw cleanup;
  };
  await assert.rejects(
    f.run(async (scope) => {
      await scope.track(Promise.reject(body));
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(new Set(error.errors), new Set([body, cleanup]));
      return true;
    },
  );
  assert.equal(f.report.status, "failed");
  assert.equal(f.events.at(-1), "save");
});
test("Development cleanup failure prohibits a passing report after successful business", async () => {
  const f = scopeFixture(),
    cleanup = new Error("context cleanup");
  f.context.close = async () => {
    throw cleanup;
  };
  await assert.rejects(
    f.run(async () => {}),
    (error) => error === cleanup,
  );
  assert.equal(f.report.status, "failed");
});

test("Development cancellation during final archive retains the reason and saves a failed terminal report", async () => {
  const f = scopeFixture(),
    abort = new AbortController(),
    reason = new Error("cancelled while archiving"),
    saved = [];
  await assert.rejects(
    implementation.runDevelopmentBrowserScope(
      {
        launch: async () => f.browser,
        signal: abort.signal,
        report: f.report,
        async preserve(report) {
          saved.push(structuredClone(report));
          if (saved.length === 1) abort.abort(reason);
        },
      },
      async () => {},
    ),
    (error) => error === reason,
  );
  assert.deepEqual(
    saved.map((report) => report.status),
    ["passed", "failed"],
  );
  assert(saved.at(-1).errors.some((value) => value.includes(reason.message)));
});
