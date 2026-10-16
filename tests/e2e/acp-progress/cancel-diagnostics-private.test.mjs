import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { cancellationDiagnosticFixture } from "./cancel-diagnostics.fixture.mjs";
import {
  cancelDiagnostics,
  summarizeFrames,
  summarizeSpans,
} from "./cancel-diagnostics.mjs";

const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
function archives(f) {
  return readdirSync(f.directory)
    .filter((name) => statSync(join(f.directory, name)).isDirectory())
    .map((name) => {
      const directory = join(f.directory, name);
      return { directory, manifest: parse(join(directory, "manifest.json")) };
    });
}
for (const version of [1, 2])
  test(`v${version}: timeout diagnosis binds actual prompt and original closed notification`, async (t) => {
    const f = await cancellationDiagnosticFixture(t, version);
    const result = await cancelDiagnostics(f.options);
    assert.equal(result.diagnostic, "cancel_timeout");
    assert.equal(result.admitted, false);
    assert.equal(result.stopped_after_ms, 10000);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.traces.map((row) => row.kind),
      ["prompt", "cancel"],
    );
    assert.deepEqual(
      result.traces.map((row) => row.trace_id),
      [f.prompt.traceID, f.trace.traceID],
    );
    assert.equal(f.attempts, 6);
    const queries = f.calls.filter(
      (url) => url.pathname === "/api/v3/trace-summaries",
    );
    assert.equal(queries.length, 6);
    for (const url of queries) {
      const tags = JSON.parse(url.searchParams.get("query.attributes"));
      assert.equal(tags["antnest.agent.id"], f.receipt.agentId);
      assert.equal(tags["antnest.session.id"], f.receipt.sessionId);
      assert.equal(tags["antnest.protocol.version"], `v${version}`);
      assert.equal(
        tags["antnest.request.id"],
        tags["rpc.method"] === "session/prompt" ? "actual-prompt" : undefined,
      );
    }
    assert(
      !f.calls.some(
        (url) => url.pathname === "/api/traces" || url.pathname === "/status",
      ),
    );
    for (const { directory, manifest } of archives(f)) {
      assert.equal(manifest.status, "collected");
      assert.equal(manifest.stable_samples, 3);
      for (const query of manifest.queries) {
        const path = join(directory, query.file),
          bytes = readFileSync(path);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          query.sha256,
        );
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
    }
    const saved = parse(
      join(f.directory, `cancel-timeout-${f.options.phase}.private.json`),
    );
    assert.equal(saved.diagnostic, "cancel_timeout");
    assert.equal(saved.results.length, 2);
  });

test("diagnostic collection waits for joined close and reads its late frames", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  const closed = Promise.withResolvers(),
    original = f.client.closeAndWait;
  f.client.closeAndWait = async () => {
    await closed.promise;
    await original();
    f.client.updates.push({
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "_unresolved",
      },
    });
  };
  let settled = false;
  const pending = cancelDiagnostics(f.options).finally(() => {
    settled = true;
  });
  void pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false);
    assert.deepEqual(f.calls, []);
  } finally {
    closed.resolve();
    await pending;
  }
  const result = await pending;
  assert.equal(result.frames.at(-1).state, "idle");
});

for (const [kind, change] of [
  [
    "prompt",
    (f, state) => f.field(state.prompt.spans[0], "antnest.agent.id", "other"),
  ],
  [
    "prompt",
    (f, state) => f.field(state.prompt.spans[0], "antnest.session.id", "other"),
  ],
  [
    "prompt",
    (_f, state) => {
      state.prompt.spans[0].references[0].spanID = "f".repeat(16);
    },
  ],
  [
    "cancel",
    (f, state) => f.field(state.cancel.spans[0], "antnest.agent.id", "other"),
  ],
  [
    "cancel",
    (f, state) => f.field(state.cancel.spans[0], "antnest.session.id", "other"),
  ],
  [
    "cancel",
    (_f, state) => {
      state.cancel.spans[0].references[0].spanID = "f".repeat(16);
    },
  ],
  [
    "cancel",
    (_f, state) => {
      const other = structuredClone(state.cancel);
      other.traceID = "f".repeat(32);
      for (const span of other.spans) span.traceID = other.traceID;
      state.extra = [other];
    },
  ],
])
  test(`${kind} diagnostic cannot borrow a different identity or ambiguous source (${change.toString().slice(0, 45)})`, async (t) => {
    let f;
    f = await cancellationDiagnosticFixture(t, 2, (state) => change(f, state));
    const result = await cancelDiagnostics(f.options);
    assert.equal(result.admitted, false);
    assert(!result.traces.some((row) => row.kind === kind));
    assert(result.errors.some((row) => row.step === `${kind}_trace`));
    assert(
      archives(f).some(
        ({ manifest }) =>
          manifest.status === "failed" && manifest.queries.length > 0,
      ),
    );
  });

test("a cloned notification receipt cannot start notification queries", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  f.client.notifications = [structuredClone(f.receipt)];
  const result = await cancelDiagnostics(f.options);
  assert.equal(result.admitted, false);
  assert(result.errors.some((row) => row.step === "cancel_trace"));
  assert(
    !f.calls.some((url) =>
      url.searchParams.get("query.attributes")?.includes("session/cancel"),
    ),
  );
});

test("failed close prevents trace queries and keeps the original private failure", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  f.client.closeAndWait = async () => {
    throw new Error("secret-close-canary");
  };
  const result = await cancelDiagnostics(f.options);
  assert.deepEqual(f.calls, []);
  assert.equal(result.admitted, false);
  assert(result.errors.some((row) => row.step === "connection_close"));
  assert(!JSON.stringify(result).includes("secret-close-canary"));
  assert(
    readFileSync(
      join(f.directory, `cancel-timeout-${f.options.phase}.private.json`),
      "utf8",
    ).includes("secret-close-canary"),
  );
});

test("CLIENT export failure retains its original span identity and cause before any query", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  const original = Object.assign(
    new Error("secret-export-cause", {
      cause: new Error("underlying-export-rejection"),
    }),
    {
      code: "PRIVATE_ACP_EXPORT_FAILED",
      traceID: f.receipt.connectionTraceID,
      clientSpanID: f.receipt.clientSpanID,
    },
  );
  f.options.flush = async () => {
    throw original;
  };
  const result = await cancelDiagnostics(f.options);
  assert.deepEqual(f.calls, []);
  assert.equal(result.admitted, false);
  assert.equal(result.traces.length, 0);
  assert(!JSON.stringify(result).includes("secret-export-cause"));
  const raw = readFileSync(
    join(f.directory, `cancel-timeout-${f.options.phase}.private.json`),
    "utf8",
  );
  assert(raw.includes("PRIVATE_ACP_EXPORT_FAILED"));
  assert(raw.includes("secret-export-cause"));
  assert(raw.includes("underlying-export-rejection"));
  assert(raw.includes(f.receipt.clientSpanID));
});

test("partial response failures retain received bytes and cannot appear collected", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  const prefix = Buffer.from('{"private":"received-partial-canary');
  f.options.request = async () => {
    let reads = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(prefix);
          else controller.error(new Error("reset"));
        },
      }),
    );
  };
  const result = await cancelDiagnostics(f.options);
  assert.equal(result.traces.length, 0);
  assert.equal(result.admitted, false);
  assert.equal(archives(f).length, 2);
  for (const { directory, manifest } of archives(f)) {
    assert.equal(manifest.status, "failed");
    assert(manifest.queries.length > 0);
    for (const query of manifest.queries) {
      assert.equal(query.body_complete, false);
      assert.deepEqual(readFileSync(join(directory, query.file)), prefix);
      assert.equal(
        query.sha256,
        createHash("sha256").update(prefix).digest("hex"),
      );
    }
  }
  assert(!JSON.stringify(result).includes("received-partial-canary"));
});

test("paged searches and a changing complete source never become collected", async (t) => {
  for (const kind of ["page", "changing"]) {
    const f = await cancellationDiagnosticFixture(t, 2, (state, attempt) => {
      if (kind === "page") state.page = true;
      else state.connection.warnings = [`raw-warning-${attempt}`];
    });
    const result = await cancelDiagnostics(f.options);
    assert.equal(result.traces.length, 0);
    assert.equal(result.admitted, false);
    assert.equal(archives(f).length, 2);
    assert(archives(f).every(({ manifest }) => manifest.status === "failed"));
  }
});

test("late stop probing passes its remaining budget and rejects late success", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  let elapsed = 10000;
  const received = [];
  f.options.now = () => elapsed;
  f.options.lateBudgetMs = 500;
  f.options.stopped = async (options) => {
    received.push(options.timeoutMS);
    elapsed += 501;
    return true;
  };
  const result = await cancelDiagnostics(f.options);
  assert.deepEqual(received, [500]);
  assert.equal(result.stopped_after_ms, null);
  assert.equal(result.admitted, false);
  assert(result.errors.some((row) => row.step === "late_stop"));
});

test("public diagnostics never copy untrusted values from allowed field names", () => {
  const secret = "secret-allowed-field-canary";
  const spans = summarizeSpans(
    {
      processes: { p: { serviceName: secret } },
      spans: [
        {
          processID: "p",
          operationName: secret,
          startTime: 0,
          duration: 1,
          tags: [
            "rpc.method",
            "error.type",
            "otel.status_code",
            "executor.exit.classification",
            "http.status_code",
          ].map((key) => ({ key, value: secret })),
        },
      ],
    },
    0,
  );
  const frames = summarizeFrames([
    {
      update: {
        sessionUpdate: "state_update",
        state: secret,
        stopReason: secret,
        status: secret,
      },
    },
  ]);
  assert(!JSON.stringify({ spans, frames }).includes(secret));
});

for (const stage of ["request", "read"])
  test(`original ${stage} failure and cause stay private`, async (t) => {
    const f = await cancellationDiagnosticFixture(t);
    const original = new Error(`secret-${stage}-canary`, {
      cause: new Error("secret-original-cause"),
    });
    const bytes = Buffer.from("partial-original-bytes");
    f.options.request = async () => {
      if (stage === "request") throw original;
      let reads = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(bytes);
            else controller.error(original);
          },
        }),
      );
    };
    const result = await cancelDiagnostics(f.options);
    assert.equal(result.admitted, false);
    assert.equal(result.traces.length, 0);
    assert(!JSON.stringify(result).includes("secret-"));
    const raw = readFileSync(
      join(f.directory, `cancel-timeout-${f.options.phase}.private.json`),
      "utf8",
    );
    assert(raw.includes(`secret-${stage}-canary`));
    assert(raw.includes("secret-original-cause"));
    if (stage === "read")
      for (const { directory, manifest } of archives(f))
        for (const query of manifest.queries)
          assert.deepEqual(readFileSync(join(directory, query.file)), bytes);
  });

test("diagnostic abort joins reader cancellation and preserves the received prefix", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  const controller = new AbortController(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const prefix = Buffer.from("partial-before-abort");
  let joined = false,
    settled = false;
  f.options.signal = controller.signal;
  f.options.request = async () => {
    let reads = 0;
    return new Response(
      new ReadableStream({
        pull(stream) {
          if (reads++ === 0) stream.enqueue(prefix);
          else controller.abort(new Error("secret-abort-cause"));
        },
        async cancel() {
          entered.resolve();
          await release.promise;
          joined = true;
        },
      }),
    );
  };
  const pending = cancelDiagnostics(f.options).finally(() => {
    settled = true;
  });
  void pending.catch(() => {});
  await entered.promise;
  try {
    assert.equal(settled, false);
    assert.equal(joined, false);
  } finally {
    release.resolve();
  }
  const result = await pending;
  assert.equal(joined, true);
  assert.equal(result.traces.length, 0);
  assert.equal(result.admitted, false);
  assert(!JSON.stringify(result).includes("secret-abort-cause"));
  const saved = archives(f);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].manifest.aborted, true);
  assert.deepEqual(
    readFileSync(join(saved[0].directory, saved[0].manifest.queries[0].file)),
    prefix,
  );
});

test("an evidence write failure retains the original network error in the thrown failure", async (t) => {
  const f = await cancellationDiagnosticFixture(t),
    original = new Error("original-network-error");
  const filename = join(
    f.directory,
    `cancel-timeout-${f.options.phase}.private.json`,
  );
  f.options.request = async () => {
    unlinkSync(filename);
    mkdirSync(filename);
    throw original;
  };
  const contains = (error) =>
    error === original ||
    (error instanceof AggregateError && error.errors.some(contains));
  await assert.rejects(cancelDiagnostics(f.options), contains);
});

test("an earlier abort cannot hide a joined cancel error when its evidence write fails", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  const controller = new AbortController();
  let joined = false;
  const original = new Error("original-cancel-canary", {
    cause: new Error("original-cancel-cause"),
  });
  const filename = join(
    f.directory,
    `cancel-timeout-${f.options.phase}.private.json`,
  );
  f.options.signal = controller.signal;
  f.options.request = async () => {
    let reads = 0;
    return new Response(
      new ReadableStream({
        pull(stream) {
          if (reads++ === 0) stream.enqueue(Buffer.from("partial"));
          else controller.abort(new Error("earlier external abort"));
        },
        async cancel() {
          await Promise.resolve();
          unlinkSync(filename);
          mkdirSync(filename);
          joined = true;
          throw original;
        },
      }),
    );
  };
  const contains = (error) =>
    error === original ||
    (error instanceof AggregateError && error.errors.some(contains));
  await assert.rejects(cancelDiagnostics(f.options), contains);
  assert.equal(joined, true);
});

test("a real HTTP body reset preserves already archived bytes and the socket cause", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  const prefix = Buffer.from('{"incomplete":"actual-socket-prefix');
  let first,
    requests = 0;
  const server = createServer((_request, response) => {
    if (requests++ === 0) {
      first = response;
      response.writeHead(200, { "content-type": "application/json" });
      response.write(prefix);
    } else {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"unavailable":true}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  f.options.jaeger = `http://127.0.0.1:${server.address().port}`;
  delete f.options.request;
  const controller = new AbortController();
  f.options.signal = controller.signal;
  let settled = false;
  const pending = cancelDiagnostics(f.options).finally(() => {
    settled = true;
  });
  void pending.catch(() => {});
  try {
    const end = performance.now() + 5000;
    for (;;) {
      const received = archives(f).some(({ directory, manifest }) =>
        manifest.queries.some((query) =>
          readFileSync(join(directory, query.file)).equals(prefix),
        ),
      );
      if (received) break;
      assert(
        performance.now() < end && !settled,
        "actual response prefix was not archived",
      );
      await delay(10);
    }
    first.destroy();
    const result = await pending;
    assert.equal(result.admitted, false);
    assert.equal(result.traces.length, 0);
    assert(!JSON.stringify(result).includes("actual-socket-prefix"));
    const raw = readFileSync(
      join(f.directory, `cancel-timeout-${f.options.phase}.private.json`),
      "utf8",
    );
    assert(raw.includes("terminated"));
    assert(raw.includes("UND_ERR_SOCKET"));
    const partial = archives(f).flatMap(({ directory, manifest }) =>
      manifest.queries
        .filter((query) => !query.body_complete)
        .map((query) => readFileSync(join(directory, query.file))),
    );
    assert(partial.some((bytes) => bytes.equals(prefix)));
  } finally {
    if (!settled) controller.abort(new Error("HTTP reset test cleanup"));
    first?.destroy();
    await pending;
  }
});

test("a delayed cancel rejection remains original after an already propagated abort", async (t) => {
  const f = await cancellationDiagnosticFixture(t);
  const controller = new AbortController(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    readPending = Promise.withResolvers();
  const original = new Error("delayed-original-cancel", {
    cause: new Error("delayed-cancel-cause"),
  });
  const prefix = Buffer.from("held-body-prefix");
  const filename = join(
    f.directory,
    `cancel-timeout-${f.options.phase}.private.json`,
  );
  f.options.signal = controller.signal;
  let requestSignal,
    reads = 0;
  f.options.request = async (_url, options) => {
    requestSignal = options.signal;
    return new Response(
      new ReadableStream(
        {
          pull(stream) {
            if (reads++ === 0) stream.enqueue(prefix);
            else readPending.resolve();
          },
          async cancel() {
            entered.resolve();
            await release.promise;
            unlinkSync(filename);
            mkdirSync(filename);
            throw original;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  };
  let settled = false;
  const pending = cancelDiagnostics(f.options).finally(() => {
    settled = true;
  });
  void pending.catch(() => {});
  try {
    const end = performance.now() + 5000;
    while (
      !archives(f).some(({ directory, manifest }) =>
        manifest.queries.some((query) =>
          readFileSync(join(directory, query.file)).equals(prefix),
        ),
      )
    ) {
      assert(
        performance.now() < end && !settled,
        "prefix not archived before external abort",
      );
      await delay(5);
    }
    await readPending.promise;
    const abortReason = new Error("first-external-abort");
    controller.abort(abortReason);
    await entered.promise;
    assert.equal(requestSignal.aborted, true);
    assert.strictEqual(requestSignal.reason, abortReason);
    assert.equal(settled, false);
    release.resolve();
    const contains = (error) =>
      error === original ||
      (error instanceof AggregateError && error.errors.some(contains));
    await assert.rejects(pending, contains);
  } finally {
    controller.abort();
    release.resolve();
    await pending.catch(() => {});
  }
});
