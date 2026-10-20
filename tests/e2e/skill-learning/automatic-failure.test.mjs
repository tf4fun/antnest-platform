import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as failures from "./automatic-failure.mjs";
import {
  captureLearningFailureTraces,
  learningClientFailure,
} from "./automatic-failure.mjs";

const traceID = "a".repeat(32);
const changeID = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
const privateText = "private-cookie-prompt-and-notice-body";

test("host failure capture attempts every archive and retains the original failure", async () => {
  assert.equal(typeof failures.collectLearningFailureEvidence, "function");
  const business = new Error("container failed"),
    log = new Error("log archive failed"),
    query = new Error("SQL archive failed");
  const order = [];
  await assert.rejects(
    () =>
      failures.collectLearningFailureEvidence(business, [
        async () => {
          order.push("log");
          throw log;
        },
        async () => {
          order.push("SQL");
          throw query;
        },
      ]),
    (error) => {
      assert.deepEqual(error.errors, [business, log, query]);
      return true;
    },
  );
  assert.deepEqual(order, ["log", "SQL"]);
  await assert.rejects(
    () =>
      failures.collectLearningFailureEvidence(business, [
        async () => {
          order.push("saved");
        },
      ]),
    (error) => error === business,
  );
  assert.equal(order.at(-1), "saved");
});

test("failed learning retains the actual connection, remote close and persisted notice without payloads", async () => {
  const failure = await learningClientFailure(
    {
      traceID,
      observedConnectionTraceID: traceID,
      closeCode: 1013,
      waitForClose: async () => ({
        code: 1013,
        reason: "identity_unavailable",
        at: 21_000,
        localClose: false,
      }),
      cookie: privateText,
      requests: [{ params: { prompt: privateText } }],
      updates: [
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: privateText,
          },
        },
        {
          update: {
            sessionUpdate: "notice",
            content: privateText,
            _meta: {
              "antnest.dev/skill-learning": {
                kind: "skill_created",
                changeId: changeID,
                detail: privateText,
              },
            },
          },
        },
      ],
    },
    {
      startedAt: 1000,
      phase: "create-live-notice",
      persistedNotice: {
        kind: "skill_created",
        changeId: changeID,
        at: 22_000,
        detail: privateText,
      },
      now: () => 52_000,
    },
  );
  assert.equal(failure.connection_trace_id, traceID);
  assert.equal(failure.phase, "create-live-notice");
  assert.equal(failure.started_at, 1000);
  assert.equal(failure.observed_at, 52_000);
  assert.deepEqual(failure.close, {
    code: 1013,
    reason: "identity_unavailable",
    at: 21_000,
    localClose: false,
  });
  assert.deepEqual(failure.persisted_notice, {
    kind: "skill_created",
    change_id: changeID,
    at: 22_000,
  });
  assert.deepEqual(failure.live_notices, [
    { kind: "skill_created", change_id: changeID },
  ]);
  assert.equal(failure.update_count, 2);
  assert.equal(JSON.stringify(failure).includes(privateText), false);
});

test("an open connection is captured without waiting for or causing its closure", async () => {
  let waited = false;
  const failure = await learningClientFailure(
    {
      traceID,
      observedConnectionTraceID: traceID,
      updates: [],
      waitForClose: async () => {
        waited = true;
        throw new Error("should not wait");
      },
    },
    { phase: "create-prompt", startedAt: 1000, now: () => 2000 },
  );
  assert.equal(waited, false);
  assert.equal(failure.close, null);
  assert.equal(failure.connection_trace_id, traceID);
});

test("failure collection retrieves only validated connection IDs and preserves raw detail as diagnostic evidence", async () => {
  const saved = new Map(),
    urls = [];
  const raw = {
    data: [{ traceID, spans: [], warnings: ["original warning"] }],
    errors: null,
  };
  const logs = [
    JSON.stringify({
      status: "skill_learning_client_failed",
      connection_trace_id: traceID,
    }),
    JSON.stringify({
      status: "skill_learning_client_failed",
      connection_trace_id: traceID,
    }),
    JSON.stringify({
      status: "skill_learning_client_failed",
      connection_trace_id: "../../secret",
    }),
    JSON.stringify({
      status: "unrelated",
      connection_trace_id: "c".repeat(32),
    }),
    "non-JSON stderr",
  ].join("\n");
  const result = await captureLearningFailureTraces({
    logs,
    jaeger: "http://jaeger.invalid:16686",
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      assert(options.signal instanceof AbortSignal);
      return { ok: true, status: 200, json: async () => raw };
    },
    save: async (name, value) => saved.set(name, structuredClone(value)),
  });
  assert.deepEqual(urls, [`http://jaeger.invalid:16686/api/traces/${traceID}`]);
  assert.equal(result.diagnostic_only, true);
  assert.deepEqual(
    result.captures.map((r) => r.status),
    ["captured"],
  );
  assert.deepEqual(saved.get(`stream-failure-${traceID}.json`), raw);
  assert.deepEqual(saved.get("stream-failure-index.json"), result);
});

for (const scenario of ["unavailable", "wrong-id", "errors", "aborted"]) {
  test(`failed trace collection retains ${scenario} without claiming completion`, async () => {
    const saved = new Map();
    const result = await captureLearningFailureTraces({
      logs: JSON.stringify({
        status: "skill_learning_client_failed",
        connection_trace_id: traceID,
      }),
      jaeger: "http://jaeger.invalid:16686",
      fetchImpl: async () => {
        if (scenario === "aborted")
          throw new DOMException("cancelled", "AbortError");
        return {
          ok: scenario !== "unavailable",
          status: scenario === "unavailable" ? 503 : 200,
          json: async () => ({
            data: [
              {
                traceID: scenario === "wrong-id" ? "d".repeat(32) : traceID,
                spans: [],
              },
            ],
            errors: scenario === "errors" ? ["query failed"] : null,
          }),
        };
      },
      save: async (name, value) => saved.set(name, structuredClone(value)),
    });
    assert.equal(result.diagnostic_only, true);
    assert.equal(result.captures.length, 1);
    assert.equal(result.captures[0].status, "unavailable");
    assert.deepEqual(saved.get("stream-failure-index.json"), result);
  });
}

test("an attempted trace parent is not evidence of an upgraded connection", async () => {
  const failure = await learningClientFailure(
    { traceID, updates: [] },
    { phase: "initialize", startedAt: 1000 },
  );
  assert.equal(failure.connection_trace_id, null);
  const urls = [];
  const result = await captureLearningFailureTraces({
    logs: JSON.stringify(failure),
    jaeger: "http://jaeger.invalid:16686",
    fetchImpl: async (url) => {
      urls.push(url);
      throw new Error("unexpected query");
    },
    save: async () => {},
  });
  assert.deepEqual(urls, []);
  assert.equal(result.discovery_status, "no_observed_trace");
  assert.equal(result.record_count, 1);
  assert.equal(result.unobserved_trace_count, 1);
});

test("the observed upgrade trace wins over the attempted parent", async () => {
  const observed = "e".repeat(32);
  const failure = await learningClientFailure(
    { traceID, observedConnectionTraceID: observed, updates: [] },
    { phase: "create-live-notice", startedAt: 1000 },
  );
  assert.equal(failure.connection_trace_id, observed);
});

test("a private learning failure uses its actual exporting CLIENT trace", async () => {
  const actual = "c".repeat(32);
  const failure = await learningClientFailure(
    {
      boundary: "private-acp",
      connectionTraceID: actual,
      observedConnectionTraceID: "f".repeat(32),
      updates: [],
    },
    { phase: "create-live-notice", startedAt: 1000 },
  );
  assert.equal(failure.connection_trace_id, actual);
});

test("a missing diagnostic record is distinct from a connection without an observed trace", async () => {
  const result = await captureLearningFailureTraces({
    logs: "stderr only",
    jaeger: "http://jaeger.invalid:16686",
    save: async () => {},
  });
  assert.equal(result.discovery_status, "no_record");
  assert.equal(result.record_count, 0);
  assert.equal(result.unobserved_trace_count, 0);
});

test("nested connection failure captures the reconnect before cleanup and emits only once", async () => {
  const order = [],
    receipts = [];
  const boundary = failures.learningFailureBoundary((receipt) =>
    receipts.push(receipt),
  );
  const client = (id, name) => ({
    observedConnectionTraceID: id,
    updates: [],
    closeAndWait() {
      order.push(name);
      this.closeCode = 1000;
    },
    waitForClose() {
      throw new Error("local cleanup must follow capture");
    },
  });
  const original = client(traceID, "original");
  const reconnect = client("f".repeat(32), "reconnect");
  const error = new Error("reconnect failed");
  await assert.rejects(
    boundary(
      original,
      () => ({ phase: "update", startedAt: 1000 }),
      async () => {
        await original.closeAndWait();
        await boundary(
          reconnect,
          () => ({ phase: "update-reconnect", startedAt: 2000 }),
          async () => {
            throw error;
          },
        );
      },
    ),
    (actual) => actual === error,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].connection_trace_id, "f".repeat(32));
  assert.equal(receipts[0].phase, "update-reconnect");
  assert.equal(receipts[0].started_at, 2000);
  assert.equal(receipts[0].close, null);
  assert.deepEqual(order, ["original", "reconnect", "original"]);
});

test("a diagnostic emitter failure preserves the business error and still closes the client", async () => {
  let closed = false;
  const error = new Error("business failure"),
    captureError = new Error("archive failure");
  const boundary = failures.learningFailureBoundary(() => {
    throw captureError;
  });
  await assert.rejects(
    boundary(
      {
        updates: [],
        closeAndWait: async () => {
          closed = true;
        },
      },
      () => ({ phase: "initialize", startedAt: 1000 }),
      async () => {
        throw error;
      },
    ),
    (actual) =>
      actual instanceof AggregateError &&
      actual.errors[0] === error &&
      actual.errors[1] === captureError,
  );
  assert.equal(closed, true);
});

test("learning failure joins asynchronous cleanup and preserves business, archive and cleanup failures", async () => {
  const business = new Error("business failure"),
    archive = new Error("archive failure"),
    cleanup = new Error("cleanup failure");
  const order = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const boundary = failures.learningFailureBoundary(() => {
    order.push("archive");
    throw archive;
  });
  let completed = false;
  const operation = boundary(
    {
      updates: [],
      async closeAndWait() {
        order.push("close-start");
        await held;
        order.push("close-end");
        throw cleanup;
      },
    },
    () => ({ phase: "create-prompt", startedAt: 1000 }),
    () => {
      throw business;
    },
  );
  const observed = operation.then(
    () => {
      completed = true;
      return null;
    },
    (error) => {
      completed = true;
      return error;
    },
  );
  await new Promise(setImmediate);
  assert.equal(completed, false);
  assert.deepEqual(order, ["archive", "close-start"]);
  release();
  const error = await observed;
  const flatten = (value) =>
    value instanceof AggregateError ? value.errors.flatMap(flatten) : [value];
  assert.deepEqual(flatten(error), [business, archive, cleanup]);
  assert.deepEqual(order, ["archive", "close-start", "close-end"]);
});

test("an unavailable trace response cancels its held body before completing", async () => {
  let cancelled = false;
  const result = await captureLearningFailureTraces({
    logs: JSON.stringify({
      status: "skill_learning_client_failed",
      connection_trace_id: traceID,
    }),
    jaeger: "http://jaeger.invalid:16686",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      ),
    save: async () => {},
  });
  assert.equal(cancelled, true);
  assert.equal(result.captures[0].failure_stage, "response");
});

for (const stage of ["query", "decode", "validation", "archive"]) {
  test(`trace diagnostic exposes the fixed ${stage} failure stage`, async () => {
    const result = await captureLearningFailureTraces({
      logs: JSON.stringify({
        status: "skill_learning_client_failed",
        connection_trace_id: traceID,
      }),
      jaeger: "http://jaeger.invalid:16686",
      fetchImpl: async () => {
        if (stage === "query") throw new Error(privateText);
        return new Response(
          stage === "decode"
            ? "{"
            : JSON.stringify({
                data: [
                  {
                    traceID: stage === "validation" ? "e".repeat(32) : traceID,
                  },
                ],
                errors: null,
              }),
        );
      },
      save: async (name) => {
        if (stage === "archive" && name !== "stream-failure-index.json")
          throw new Error(privateText);
      },
    });
    assert.equal(result.captures[0].status, "unavailable");
    assert.equal(result.captures[0].failure_stage, stage);
    assert.equal(JSON.stringify(result).includes(privateText), false);
  });
}

test("an abort during the query is retained as a query gap", async () => {
  const controller = new AbortController();
  const result = await captureLearningFailureTraces({
    logs: JSON.stringify({
      status: "skill_learning_client_failed",
      connection_trace_id: traceID,
    }),
    jaeger: "http://jaeger.invalid:16686",
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        controller.abort(new Error(privateText));
      }),
    save: async () => {},
  });
  assert.equal(result.captures[0].failure_stage, "query");
  assert.equal(result.captures[0].status, "unavailable");
});

test("index archive failures are propagated to the owning failure handler", async () => {
  const error = new Error("archive unavailable");
  await assert.rejects(
    captureLearningFailureTraces({
      logs: "no record",
      jaeger: "http://jaeger.invalid:16686",
      save: async () => {
        throw error;
      },
    }),
    (actual) => actual === error,
  );
});

test("a view receipt retains the actual failed HTTP response without its private payload", () => {
  assert.equal(typeof failures.learningViewReceipt, "function");
  const context = {
    mode: "update",
    agentId: "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb",
    sessionId: "cccccccc-cccc-4ccc-accc-cccccccccccc",
    requestedAt: 1000,
    now: () => 1007,
    cookie: privateText,
  };
  const receipt = failures.learningViewReceipt(
    {
      status: 503,
      traceID,
      text: JSON.stringify({
        code: "upstream_unavailable",
        detail: privateText,
      }),
      headers: { cookie: privateText },
    },
    context,
  );
  assert.deepEqual(receipt, {
    status: "skill_learning_view_response",
    mode: "update",
    method: "GET",
    operation: "agent_view",
    agent_id: context.agentId,
    session_id: context.sessionId,
    requested_at: 1000,
    observed_at: 1007,
    http_status: 503,
    expected_status: 200,
    trace_id: traceID,
    response_code: "upstream_unavailable",
  });
  assert(!JSON.stringify(receipt).includes(privateText));
  for (const invalidID of ["0".repeat(32), "../../private", undefined]) {
    const unknown = failures.learningViewReceipt(
      {
        status: 503,
        traceID: invalidID,
        text: JSON.stringify({ code: privateText }),
      },
      context,
    );
    assert.equal(unknown.trace_id, undefined);
    assert.equal(unknown.response_code, undefined);
    assert(!JSON.stringify(unknown).includes(privateText));
  }
});

test("view failure collection keeps the warm request, failed GET and private connection distinct", async () => {
  const warm = "b".repeat(32),
    failed = "c".repeat(32),
    close = "d".repeat(32);
  const saved = new Map(),
    queried = [];
  const raw = (id) => ({
    data: [{ traceID: id, spans: [], warnings: ["original diagnostic"] }],
    errors: null,
  });
  // Close roots are independent of the failed GET. These are raw candidates,
  // not an ownership verdict: exact initialization Link/process review follows.
  const foreignClose = {
    traceID: close,
    spans: [{ operationName: "agent_ui.acp.close", references: [] }],
  };
  const result = await captureLearningFailureTraces({
    logs: [
      {
        status: "skill_learning_view_response",
        http_status: 200,
        trace_id: warm,
      },
      {
        status: "skill_learning_view_response",
        http_status: 503,
        trace_id: failed,
      },
      {
        status: "skill_learning_client_failed",
        connection_trace_id: traceID,
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n"),
    jaeger: "http://jaeger.invalid:16686",
    fetchImpl: async (url) => {
      const id = new URL(url).pathname.split("/").at(-1);
      queried.push(id);
      assert([warm, failed, traceID].includes(id));
      return new Response(JSON.stringify(raw(id)));
    },
    searchImpl: async (base, query, options) => {
      assert.equal(base, "http://jaeger.invalid:16686");
      assert.deepEqual(Object.fromEntries(query), {
        service: "agent-ui",
        operation: "agent_ui.acp.close",
        lookback: "1h",
        limit: "100",
      });
      assert(options.signal instanceof AbortSignal);
      return [foreignClose];
    },
    save: async (name, value) => saved.set(name, structuredClone(value)),
  });
  assert.deepEqual(queried, [warm, failed, traceID]);
  assert.equal(result.diagnostic_only, true);
  assert.deepEqual(
    result.captures.map(({ trace_id, sources, status }) => ({
      trace_id,
      sources,
      status,
    })),
    [
      { trace_id: warm, sources: ["view_success"], status: "captured" },
      { trace_id: failed, sources: ["view_failure"], status: "captured" },
      {
        trace_id: traceID,
        sources: ["private_connection"],
        status: "captured",
      },
    ],
  );
  for (const id of queried)
    assert.deepEqual(saved.get(`stream-failure-${id}.json`), raw(id));
  assert.deepEqual(saved.get("view-close-candidates.json"), [foreignClose]);
  assert.deepEqual(result.close_search, {
    status: "captured",
    count: 1,
    ownership: "unattributed",
  });
});

test("missing or zero HTTP Trace IDs remain explicit gaps without invented request traces", async () => {
  let searches = 0;
  const result = await captureLearningFailureTraces({
    logs: [undefined, "0".repeat(32), "../../private"]
      .map((id) =>
        JSON.stringify({
          status: "skill_learning_view_response",
          http_status: 503,
          trace_id: id,
        }),
      )
      .join("\n"),
    jaeger: "http://jaeger.invalid:16686",
    fetchImpl: async () => {
      assert.fail("a missing request Trace must not be invented");
    },
    searchImpl: async () => {
      searches++;
      return [];
    },
    save: async () => {},
  });
  assert.equal(result.record_count, 3);
  assert.equal(result.unobserved_trace_count, 3);
  assert.equal(result.discovery_status, "no_observed_trace");
  assert.deepEqual(result.captures, []);
  assert.equal(searches, 1);
  assert.deepEqual(result.close_search, {
    status: "empty",
    count: 0,
    ownership: "unattributed",
  });
});

for (const failure of ["query", "archive"]) {
  test(`independent close ${failure} failure stays diagnostic and preserves the original failure`, async () => {
    const original = new Error("original HTTP 503");
    let result;
    await assert.rejects(
      failures.collectLearningFailureEvidence(original, [
        async () => {
          result = await captureLearningFailureTraces({
            logs: JSON.stringify({
              status: "skill_learning_view_response",
              http_status: 503,
            }),
            jaeger: "http://jaeger.invalid:16686",
            searchImpl: async () => {
              if (failure === "query") throw new Error(privateText);
              return [{ traceID }];
            },
            save: async (name) => {
              if (
                failure === "archive" &&
                name === "view-close-candidates.json"
              )
                throw new Error(privateText);
            },
          });
        },
      ]),
      (error) => error === original,
    );
    assert.equal(result.close_search.status, "unavailable");
    assert.equal(result.close_search.failure_stage, failure);
    assert.equal(result.close_search.ownership, "unattributed");
    assert(!JSON.stringify(result).includes(privateText));
  });
}

test("the actual host catch preserves a directory failure and still attempts every diagnostic", async () => {
  const sourceURL = new URL("./automatic-flow.test.mjs", import.meta.url);
  const source = await readFile(sourceURL, "utf8");
  const start = source.indexOf(
    "} catch (error) {",
    source.indexOf("const runClient ="),
  );
  const end = source.indexOf(
    "\n        }\n        learningClientLogs.push(output);",
    start,
  );
  assert(start >= 0 && end > start);
  const body = source
    .slice(start + "} catch (error) {".length, end)
    .replaceAll("import.meta.url", "sourceURL");
  const original = new Error("original Docker HTTP 503"),
    directory = new Error("evidence directory unavailable"),
    archive = new Error("evidence file unavailable");
  const attempted = [];
  const environment = {
    sourceURL,
    fileURLToPath,
    config: {
      project: "antnest-lifecycle-12345678",
      env: {},
      jaeger: "http://jaeger.invalid",
    },
    clientName: "failed-client",
    learningClientLogs: ["earlier successful client"],
    mkdir: async () => {
      attempted.push("directory");
      throw directory;
    },
    logs: () => "original client log",
    docker: async () => "",
    composeArgs: (_project, args) => args,
    overlay: [],
    discovery: false,
    writeFile: async (path) => {
      attempted.push(
        path.endsWith(".failure.json")
          ? "archive"
          : path.includes("agent-ui")
            ? "agent-ui"
            : "edge-gateway",
      );
      throw archive;
    },
    dockerClient: () => async () => "",
    collectLearningFailureEvidence: failures.collectLearningFailureEvidence,
    delay: async () => {},
    captureLearningFailureTraces: async () => {
      attempted.push("traces");
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("error", ...Object.keys(environment), body);
  await assert.rejects(
    run(original, ...Object.values(environment)),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors.slice(0, 2), [original, directory]);
      assert(error.errors.includes(archive));
      return true;
    },
  );
  assert.deepEqual(attempted, [
    "directory",
    "archive",
    "agent-ui",
    "edge-gateway",
    "traces",
    "traces",
    "traces",
  ]);
});
