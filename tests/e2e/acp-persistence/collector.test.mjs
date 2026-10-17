import assert from "node:assert/strict";
import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspect as inspectError } from "node:util";
import {
  persistenceCollectorFixture as fixture,
  persistenceCollectionFixture,
} from "./collector.fixture.mjs";
import { lifecycleResolutionFixture } from "../stage3-base/resolve-fixtures.mjs";

const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) => {
  assert.equal(
    typeof implementation.inspectPrivatePersistenceTrace,
    "function",
  );
  return implementation.inspectPrivatePersistenceTrace(
    f.trace,
    f.expected,
    ["PRIVATE-PERSISTENCE-CANARY"],
    f.requests,
    f.faults,
  );
};
function source(t, f) {
  const directory = mkdtempSync(
    join(tmpdir(), "antnest-persistence-collector-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = { ...f.expected };
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  let flushed = false;
  const bodies = [];
  return {
    directory,
    expected,
    bodies,
    options: {
      directory,
      attempts: 3,
      wait: async () => {},
      requests: f.requests,
      faults: f.faults,
      secrets: ["PRIVATE-PERSISTENCE-CANARY"],
      flush: async () => {
        flushed = true;
      },
      request: async (address) => {
        assert(flushed);
        const url = new URL(address);
        const body = JSON.stringify(
          url.pathname === "/api/v3/trace-summaries"
            ? { summaries: [{ traceId: f.trace.traceID }] }
            : {
                data: [
                  url.pathname.endsWith(f.expected.connectionTraceID)
                    ? f.expected.connectionTrace
                    : f.trace,
                ],
              },
        );
        bodies.push(body);
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}
const collect = (s) => {
  assert.equal(
    typeof implementation.collectPrivatePersistenceTrace,
    "function",
  );
  return implementation.collectPrivatePersistenceTrace(
    "http://jaeger.test:16686",
    s.expected,
    s.options,
  );
};
for (const version of [1, 2])
  for (const kind of [
    "initialize",
    "new",
    "replay",
    "ordinary",
    "intent",
    "accept",
    "finish",
  ]) {
    test(`v${version} ${kind}: private consumer dispatch retains actual receipts and raw sources`, () => {
      const f = fixture(version, kind);
      const original = structuredClone({
        trace: f.trace,
        expected: f.expected,
        requests: f.requests,
        faults: f.faults,
      });
      const result = inspect(f);
      assert.equal(result.trace_id, f.trace.traceID);
      assert.equal(result.method, f.expected.method);
      assert.equal(result.connection_trace_id, f.expected.connectionTraceID);
      assert.deepEqual(
        {
          trace: f.trace,
          expected: f.expected,
          requests: f.requests,
          faults: f.faults,
        },
        original,
      );
    });
    test(`v${version} ${kind}: collector archives three complete samples and exact raw diagnostic ownership`, async (t) => {
      const f = fixture(version, kind),
        s = source(t, f);
      const original = structuredClone({
        trace: f.trace,
        expected: f.expected,
        faults: f.faults,
        requests: f.requests,
      });
      const result = await collect(s);
      assert.equal(result.complete_source_receipt.stable_samples, 3);
      assert.equal(result.diagnostic_inventory_verified, true);
      const strict = implementation.privatePersistenceStrictOutcome([result]);
      assert.equal(strict.accepted, true);
      if (f.fault) {
        assert.equal(strict.exit_code, 2);
        assert.equal(strict.strict_trace, "failed");
        assert(
          result.owned_error_spans.some(
            (row) => row.reason === "persistence-lost-acknowledgement",
          ),
        );
      }
      const manifest = JSON.parse(
        readFileSync(join(result.evidence_directory, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.status, "collected");
      assert.equal(manifest.queries.length, 9);
      for (const [index, query] of manifest.queries.entries()) {
        assert.equal(query.body_complete, true);
        assert.equal(
          readFileSync(join(result.evidence_directory, query.file), "utf8"),
          s.bodies[index],
        );
      }
      assert.deepEqual(
        {
          trace: f.trace,
          expected: f.expected,
          faults: f.faults,
          requests: f.requests,
        },
        original,
      );
    });
  }
for (const [name, mutate, kind = "intent"] of [
  [
    "missing fault",
    (f) => {
      f.faults = [];
    },
  ],
  [
    "ambiguous fault",
    (f) => {
      f.faults.push(structuredClone(f.fault));
    },
  ],
  [
    "foreign original prompt",
    (f) => {
      f.fault.prompt_receipt.requestId = "foreign";
    },
  ],
  [
    "foreign original prompt parameters",
    (f) => {
      f.fault.prompt_receipt.requestParams.prompt[0].text = "foreign";
    },
  ],
  [
    "wrong original prompt result",
    (f) => {
      f.fault.prompt_receipt.outcome = "succeeded";
    },
  ],
  [
    "connection reached Provider",
    (f) => {
      f.requests.push({
        trace_id: f.expected.connectionTraceID,
        phase: "foreign",
      });
    },
  ],
  [
    "other Trace reused fault Provider phase",
    (f) => {
      f.requests[0].trace_id = "f".repeat(32);
    },
    "finish",
  ],
  [
    "other Trace reused ordinary Provider phase",
    (f) => {
      f.requests[0].trace_id = "f".repeat(32);
    },
    "ordinary",
  ],
  [
    "success request has failure",
    (f) => {
      f.expected.failure = "unexpected";
    },
    "ordinary",
  ],
  [
    "wrong ordinary prompt body",
    (f) => {
      f.expected.requestParams.prompt[0].text = "foreign";
    },
    "ordinary",
  ],
  [
    "missing original Session result",
    (f) => {
      delete f.expected.requestResult;
    },
    "new",
  ],
  [
    "borrowed Session requestReceipt",
    (f) => {
      f.expected.requestReceipt = {
        params: f.expected.requestParams,
        result: f.expected.requestResult,
        requestId: "foreign",
      };
    },
    "new",
  ],
  [
    "private Session result leaks secret",
    (f) => {
      f.expected.requestResult.private = "PRIVATE-PERSISTENCE-CANARY";
    },
    "new",
  ],
  [
    "unknown method",
    (f) => {
      f.expected.method = "session/delete";
    },
    "new",
  ],
  [
    "unsupported boundary",
    (f) => {
      f.expected.boundary = "gateway";
    },
    "initialize",
  ],
  [
    "false business kind",
    (f) => {
      f.expected.kind = "unknown";
    },
    "initialize",
  ],
])
  test(`private Persistence dispatch rejects ${name}`, () => {
    const f = fixture(1, kind);
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });
for (const [name, mutate] of [
  [
    "missing synchronous SQL parent",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.origin);
    },
  ],
  [
    "unowned same-type error",
    (f) => {
      f.set(f.sql, "error.type", "Error");
    },
  ],
  [
    "unrecognized warning",
    (f) => {
      f.trace.spans[0].warnings = ["missing internal span"];
    },
  ],
])
  test(`private collector preserves rejected raw sources for ${name}`, async (t) => {
    const selected = fixture(1, "intent");
    mutate(selected);
    const s = source(t, selected);
    await assert.rejects(collect(s));
    const [entry] = readdirSync(s.directory);
    const archive = join(s.directory, entry);
    const manifest = JSON.parse(
      readFileSync(join(archive, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.status, "failed");
    assert(manifest.queries.length >= 3);
    for (const query of manifest.queries)
      assert.equal(query.body_complete, true);
  });
for (const kind of ["create", "delete"])
  test(`Persistence ${kind} retains existing complete Lifecycle admission collection`, async (t) => {
    assert.equal(
      typeof implementation.collectPersistenceLifecycleTrace,
      "function",
    );
    const f = lifecycleResolutionFixture(kind, "shared");
    const directory = mkdtempSync(
      join(tmpdir(), "antnest-persistence-lifecycle-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const originalBodies = [];
    const result = await implementation.collectPersistenceLifecycleTrace(
      "http://jaeger",
      f.expected,
      {
        directory,
        attempts: 3,
        secrets: ["PRIVATE"],
        flush: async () => {},
        wait: async () => {},
        request: async (address) => {
          const body = JSON.stringify({
            data: [f.traces.get(new URL(address).pathname.split("/").at(-1))],
          });
          originalBodies.push(body);
          return new Response(body, {
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    assert.equal(result.kind, kind);
    assert.equal(result.gateway_resolution.source, "shared");
    assert.equal(result.strict_trace, "passed");
    const manifest = JSON.parse(
      readFileSync(
        join(result.raw_evidence_directory, "manifest.private.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.outcome, "complete");
    assert.equal(manifest.queries.length, originalBodies.length);
    assert(manifest.queries.length >= 9);
    for (const [index, query] of manifest.queries.entries()) {
      assert.equal(query.body_complete, true);
      assert.equal(
        readFileSync(join(result.raw_evidence_directory, query.file), "utf8"),
        originalBodies[index],
      );
    }
  });
for (const broken of ["malformed", "partial", "cancelled"])
  test(`Lifecycle ${broken} response retains original bytes and joins its body before failure`, async (t) => {
    assert.equal(
      typeof implementation.collectPersistenceLifecycleTrace,
      "function",
    );
    const f = lifecycleResolutionFixture("create", "shared"),
      controller = new AbortController();
    const directory = mkdtempSync(
      join(tmpdir(), "antnest-persistence-lifecycle-failed-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let reads = 0,
      cancelled = false;
    const pending = Promise.withResolvers();
    const original = "{original-private-prefix";
    const error = new Error("original private body failure");
    const response =
      broken === "malformed"
        ? new Response(original, { status: 503 })
        : new Response(
            new ReadableStream({
              pull(stream) {
                if (reads++ === 0)
                  stream.enqueue(new TextEncoder().encode(original));
                else if (broken === "partial") throw error;
                else {
                  pending.resolve();
                  return new Promise(() => {});
                }
              },
              async cancel() {
                await Promise.resolve();
                cancelled = true;
              },
            }),
          );
    const operation = implementation.collectPersistenceLifecycleTrace(
      "http://jaeger",
      f.expected,
      {
        directory,
        attempts: 3,
        flush: async () => {},
        wait: async () => {},
        signal: controller.signal,
        request: async () => response,
      },
    );
    if (broken === "cancelled") {
      await pending.promise;
      controller.abort(error);
    }
    await assert.rejects(operation);
    if (broken === "cancelled") assert.equal(cancelled, true);
    const archive = join(directory, readdirSync(directory)[0]);
    const manifest = JSON.parse(
      readFileSync(join(archive, "manifest.private.json"), "utf8"),
    );
    assert.equal(
      manifest.outcome,
      broken === "cancelled" ? "aborted" : "failed",
    );
    assert.equal(manifest.queries.length, 1);
    const query = manifest.queries[0];
    assert.equal(query.body_complete, broken === "malformed");
    assert.equal(readFileSync(join(archive, query.file), "utf8"), original);
  });
for (const broken of ["cancel", "header-archive", "body-and-archive"])
  test(`Lifecycle retains original ${broken} errors and joins owned body cleanup`, async (t) => {
    const f = lifecycleResolutionFixture("create", "shared"),
      controller = new AbortController();
    const directory = mkdtempSync(
      join(tmpdir(), "antnest-persistence-lifecycle-cleanup-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bodyError = new Error("original private body failure"),
      cleanupError = new Error("independent private cancel failure");
    const pending = Promise.withResolvers();
    let archive,
      cancelled = false,
      released = false,
      reads = 0;
    const breakArchive = () => {
      const file = join(archive, "query-0001.raw");
      rmSync(file);
      mkdirSync(file);
    };
    const reader = {
      async read() {
        if (broken === "cancel") {
          pending.resolve();
          return new Promise((resolve) => {
            reader.finishRead = resolve;
          });
        }
        if (reads++ === 0)
          return { value: Buffer.from("private original prefix"), done: false };
        breakArchive();
        throw bodyError;
      },
      async cancel() {
        await Promise.resolve();
        cancelled = true;
        if (broken === "cancel") {
          reader.finishRead({ done: true });
          throw cleanupError;
        }
      },
      releaseLock() {
        released = true;
      },
    };
    const operation = implementation.collectPersistenceLifecycleTrace(
      "http://jaeger",
      f.expected,
      {
        directory,
        attempts: 3,
        flush: async () => {},
        wait: async () => {},
        signal: controller.signal,
        request: async () => {
          archive = join(directory, readdirSync(directory)[0]);
          if (broken === "header-archive") breakArchive();
          return { status: 200, body: { getReader: () => reader } };
        },
      },
    );
    if (broken === "cancel") {
      await pending.promise;
      controller.abort(bodyError);
    }
    let failure;
    await assert.rejects(operation, (error) => {
      failure = error;
      return true;
    });
    assert.equal(cancelled, true, "owned body cancellation must be joined");
    assert.equal(
      released,
      true,
      "owned reader must be released even when archiving fails",
    );
    const retained = inspectError(failure, { depth: 16 });
    const privateFailure = readFileSync(
      join(archive, "failure.private.txt"),
      "utf8",
    );
    const queryFailure = readFileSync(
      join(archive, "query-0001.raw.failure.private.txt"),
      "utf8",
    );
    for (const original of broken === "cancel"
      ? [bodyError.message, cleanupError.message]
      : broken === "body-and-archive"
        ? [bodyError.message, "evidence output must be a regular file"]
        : ["evidence output must be a regular file"]) {
      for (const text of [retained, privateFailure, queryFailure])
        assert(text.includes(original), `lost original error: ${original}`);
    }
  });
test("combined outcome retains injected raw failure and rejects missing lifecycle or unowned failures", async (t) => {
  const result = await collect(source(t, fixture(1, "intent")));
  const lifecycle = ["create", "delete"].map((kind, index) => ({
    kind,
    trace_id: String(index + 8).repeat(32),
    strict_trace: "passed",
    warnings: [],
    warning_count: 0,
    error_spans: 0,
    lifecycle_error_span_ids: [],
    lifecycle_error_claims: [],
  }));
  const accepted = implementation.persistenceTraceOutcome([result], lifecycle);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.strict_trace, "failed");
  assert.equal(accepted.exit_code, 2);
  for (const [privateResults, lifecycleResults] of [
    [[result], []],
    [[result, result], lifecycle],
    [[{ ...result, owned_error_spans: [] }], lifecycle],
    [[result], [lifecycle[0], { ...lifecycle[1], error_spans: 1 }]],
    [
      [result],
      [
        lifecycle[0],
        {
          ...lifecycle[1],
          warnings: ["unowned internal warning"],
          warning_count: 1,
          strict_trace: "failed",
        },
      ],
    ],
  ])
    assert.equal(
      implementation.persistenceTraceOutcome(privateResults, lifecycleResults)
        .accepted,
      false,
    );
});

function fullCollection(t) {
  const f = persistenceCollectionFixture();
  const directory = mkdtempSync(
    join(tmpdir(), "antnest-persistence-full-collection-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stages = [];
  let label;
  const options = {
    directory,
    attempts: 3,
    secrets: ["PRIVATE-PERSISTENCE-CANARY"],
    flush: async () => {},
    wait: async () => {},
    onStage: async (expected) => {
      label = expected.label ?? expected.kind;
      stages.push(label);
    },
    request: async (address) => {
      const url = new URL(address);
      const body =
        url.pathname === "/api/v3/trace-summaries"
          ? { summaries: [{ traceId: f.byLabel.get(label) }] }
          : { data: [f.traces.get(url.pathname.split("/").at(-1))] };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const collect = () => {
    assert.equal(
      typeof implementation.collectPersistenceTraceEvidence,
      "function",
    );
    return implementation.collectPersistenceTraceEvidence(
      "http://jaeger",
      f.input,
      options,
    );
  };
  return { ...f, directory, options, stages, collect };
}
test("complete Persistence collection admits all 50 distinct Traces and retains raw fault failure", async (t) => {
  const f = fullCollection(t),
    original = structuredClone(f.input);
  for (const expected of [...f.input.initializations, ...f.input.requests]) {
    const connectionTrace = f.traces.get(expected.connectionTraceID);
    implementation.inspectPrivatePersistenceTrace(
      f.traces.get(f.byLabel.get(expected.label)),
      {
        ...expected,
        connectionTrace,
        connectionSpanID: connectionTrace.spans[1].spanID,
      },
      [],
      f.input.modelRequests,
      f.input.faults,
    );
  }
  const result = await f.collect();
  assert.equal(result.accepted, true);
  assert.equal(result.exit_code, 2);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.privateResults.length, 48);
  assert.equal(result.lifecycleResults.length, 2);
  assert.equal(
    new Set(
      [...result.privateResults, ...result.lifecycleResults].map(
        (row) => row.trace_id,
      ),
    ).size,
    50,
  );
  assert.equal(
    result.privateResults.filter((row) => row.kind === "fault").length,
    6,
  );
  assert.equal(
    result.privateResults.reduce((count, row) => count + (row.runs ?? 0), 0),
    8,
  );
  assert.equal(
    new Set(
      result.privateResults
        .filter((row) => row.run_id)
        .map((row) => row.run_id),
    ).size,
    12,
  );
  assert.equal(f.stages.length, 50);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(f.directory, "collection.private.json"), "utf8"),
    ),
    JSON.parse(JSON.stringify(result)),
  );
  assert.deepEqual(f.input, original);
});
for (const [name, mutate] of [
  [
    "missing original connection",
    (f) => {
      f.input.connections.pop();
    },
  ],
  [
    "forged indexed request",
    (f) => {
      f.input.requests[0].requestId = "foreign";
    },
  ],
  [
    "missing lifecycle",
    (f) => {
      f.input.lifecycle.pop();
    },
  ],
  [
    "foreign lifecycle Agent",
    (f) => {
      f.input.lifecycle[0].agentId = "foreign";
    },
  ],
  [
    "foreign Provider phase",
    (f) => {
      f.input.modelRequests[0].phase = "foreign";
    },
  ],
  [
    "missing original fault",
    (f) => {
      f.input.faults.pop();
    },
  ],
])
  test(`complete Persistence collection rejects ${name}`, async (t) => {
    const f = fullCollection(t);
    assert.equal(
      typeof implementation.collectPersistenceTraceEvidence,
      "function",
    );
    mutate(f);
    await assert.rejects(f.collect());
  });
test("complete Persistence collection retains partial reports on later internal source failure", async (t) => {
  const f = fullCollection(t);
  const broken = f.traces.get(f.byLabel.get("v1-intent-new"));
  broken.spans[0].warnings = ["unowned internal failure"];
  assert.equal(
    typeof implementation.collectPersistenceTraceEvidence,
    "function",
  );
  await assert.rejects(f.collect());
  const partial = JSON.parse(
    readFileSync(join(f.directory, "collection.private.json"), "utf8"),
  );
  assert.equal(partial.accepted, false);
  assert(
    partial.privateResults.length >= 1 && partial.privateResults.length < 48,
  );
  assert.equal(partial.exit_code, 1);
});
test("cancellation after final Lifecycle archival cannot publish an accepted collection", async (t) => {
  const f = fullCollection(t),
    controller = new AbortController();
  const original = new Error("cancelled after final raw Lifecycle archive");
  const stage = f.options.onStage;
  let settled = false,
    observed = false,
    monitor;
  f.options.signal = controller.signal;
  f.options.onStage = async (expected) => {
    await stage(expected);
    if (expected.kind !== "delete") return;
    monitor = (async () => {
      // The real private manifest marks the child's completion. Observe it
      // between async continuations, before the parent resumes admission.
      while (!settled) {
        await Promise.resolve();
        const name = readdirSync(f.directory).find((name) =>
          name.startsWith("persistence-delete-"),
        );
        if (!name) continue;
        const manifest = JSON.parse(
          readFileSync(
            join(f.directory, name, "manifest.private.json"),
            "utf8",
          ),
        );
        if (manifest.outcome !== "complete") continue;
        observed = true;
        controller.abort(original);
        return;
      }
    })();
  };
  try {
    await assert.rejects(
      f.collect().finally(() => {
        settled = true;
      }),
      (error) => error === original,
    );
  } finally {
    settled = true;
    await monitor;
  }
  assert.equal(observed, true);
  const partial = JSON.parse(
    readFileSync(join(f.directory, "collection.private.json"), "utf8"),
  );
  assert.equal(partial.accepted, false);
  assert.equal(partial.exit_code, 1);
});
