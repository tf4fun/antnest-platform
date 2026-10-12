import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  assertDisplayReadHeaders,
  observeDisplayRejection,
  searchOrganizationFeed,
} from "./organization-freshness-client.mjs";
import {
  selectSessionFeedRequests,
  inspectEmptySessionFeed,
} from "./organization-freshness.mjs";
import {
  resolutionFixture,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

function queryFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-organization-feed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = resolutionFixture("rpc");
  const client = f.trace.spans.find((s) => s.spanID === "resolve-client");
  const server = f.trace.spans.find((s) => s.spanID === "resolve-server");
  const sql = f.trace.spans.find((s) => s.spanID === "sql");
  client.references = [];
  setTag(client, "rpc.method", "list_session_revocations");
  setTag(server, "http.route", "/rpc/identity/list-session-revocations");
  setTag(server, "rpc.method", "list_session_revocations");
  setTag(
    sql,
    "db.query.text",
    "SELECT sequence, token_id, user_id, organization_id, reason, occurred_at, traceparent FROM session_revocations WHERE sequence > $1 ORDER BY sequence LIMIT $2",
  );
  setTag(sql, "pgx.rows_affected", 0);
  f.trace.spans = [client, server, sql];
  const outside = structuredClone(f.trace);
  outside.traceID = "d".repeat(32);
  outside.spans = outside.spans.filter((s) => s.spanID !== client.spanID);
  for (const span of outside.spans) {
    span.traceID = outside.traceID;
    span.startTime += 8000000;
    for (const ref of span.references) ref.traceID = outside.traceID;
  }
  const earliest = 1000123,
    latest = 4000567;
  const inventory = [f.trace, outside],
    queries = [];
  let nextPageToken;
  const fetchImpl = async (url) => {
    url = new URL(url);
    if (url.pathname === "/api/v3/trace-summaries") {
      const low = Date.parse(url.searchParams.get("query.startTimeMin")) * 1000;
      const high =
        Date.parse(url.searchParams.get("query.startTimeMax")) * 1000;
      queries.push({ low, high });
      return Response.json({
        summaries: inventory
          .filter((trace) =>
            trace.spans.some(
              (s) =>
                s.processID === "identity" &&
                s.startTime >= low &&
                s.startTime <= high,
            ),
          )
          .map((trace) => ({ traceId: trace.traceID })),
        ...(nextPageToken ? { nextPageToken } : {}),
      });
    }
    const traceID = url.pathname.split("/").at(-1);
    return Response.json({
      data: [inventory.find((trace) => trace.traceID === traceID)],
    });
  };
  const search = () =>
    searchOrganizationFeed("http://synthetic-jaeger", {
      directory,
      earliest,
      latest,
      fetchImpl,
    });
  return {
    directory,
    earliest,
    latest,
    client,
    server,
    sql,
    trace: f.trace,
    inventory,
    queries,
    search,
    paginate() {
      nextPageToken = "unread";
    },
  };
}

test("display feed search freezes the observed window and excludes a later incomplete trace", async (t) => {
  let clock = 10000;
  t.mock.method(Date, "now", () => clock);
  const f = queryFixture(t);
  for (const next of [10000, 120000]) {
    clock = next;
    const traces = await f.search();
    assert.deepEqual(selectSessionFeedRequests(traces, f.earliest, f.latest), [
      { traceID: f.trace.traceID },
    ]);
    assert.equal(
      inspectEmptySessionFeed(traces[0], { traceID: f.trace.traceID }, []).rows,
      0,
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(f.directory, "organization-feed-search.json")),
      ).length,
      1,
    );
  }
  assert.deepEqual(f.queries, [
    { low: 1000000, high: 4001000 },
    { low: 1000000, high: 4001000 },
  ]);
});

for (const failure of ["missing parent", "SQL error", "nonempty page"])
  test(`fixed display feed window still rejects in-window ${failure}`, async (t) => {
    t.mock.method(Date, "now", () => 120000);
    const f = queryFixture(t);
    f.inventory.pop();
    if (failure === "missing parent") f.trace.spans = [f.server, f.sql];
    if (failure === "SQL error") setTag(f.sql, "otel.status_code", "ERROR");
    if (failure === "nonempty page") setTag(f.sql, "pgx.rows_affected", 1);
    const traces = await f.search();
    assert.equal(traces.length, 1);
    assert.throws(() => {
      const selected = selectSessionFeedRequests(traces, f.earliest, f.latest);
      assert.equal(selected.length, 1);
      inspectEmptySessionFeed(traces[0], selected[0], []);
    });
  });

test("fixed display feed search does not accept an unread Jaeger page", async (t) => {
  t.mock.method(Date, "now", () => 120000);
  const f = queryFixture(t);
  f.paginate();
  await assert.rejects(f.search(), /unread Jaeger search page/);
});

test("actual SSR private/no-store policy is admitted while JSON retains its exact no-store policy", () => {
  for (const surface of ["session", "bootstrap", "ssr"]) {
    const value = surface === "ssr" ? "private, no-store" : "no-store";
    const headers = new Headers({ "cache-control": value });
    assert.doesNotThrow(() => assertDisplayReadHeaders(headers, surface));
    headers.set("cache-control", value + ", public");
    assert.throws(() => assertDisplayReadHeaders(headers, surface));
    headers.set("cache-control", value);
    headers.append("set-cookie", "synthetic=changed; Secure; HttpOnly");
    assert.throws(() => assertDisplayReadHeaders(headers, surface));
  }
  assert.throws(() =>
    assertDisplayReadHeaders(
      new Headers({ "cache-control": "no-store" }),
      "ssr",
    ),
  );
  assert.throws(() =>
    assertDisplayReadHeaders(
      new Headers({ "cache-control": "private, no-store" }),
      "session",
    ),
  );
});

test("membership rejection observes bounded 200-to-401 convergence with real request identities", async () => {
  let clock = 100;
  const saved = [];
  const result = await observeDisplayRejection({
    committedMS: 100,
    ttlMS: 1000,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    record: (item) => saved.push(structuredClone(item)),
    request: async () => ({
      status: clock < 300 ? 200 : 401,
      traceID: clock.toString(16).padStart(32, "0"),
    }),
  });
  assert.deepEqual(
    result.map((r) => r.status),
    [200, 200, 401],
  );
  assert.equal(saved.length, 3);
});

test("membership content failure preserves its actual response and trace before validation", async () => {
  const saved = [];
  const body = { principal: { userId: "synthetic-member" }, agents: [] };
  const failure = new Error("membership bootstrap content failed");
  let calls = 0;
  await assert.rejects(
    observeDisplayRejection({
      committedMS: 100,
      ttlMS: 1000,
      now: () => 110,
      wait: async () => {},
      request: async () => ({
        status: ++calls === 1 ? 200 : 401,
        traceID: calls.toString(16).padStart(32, "0"),
        body,
      }),
      record: (item, response) => saved.push({ item, response }),
      validate: async (response, item) => {
        assert.equal(saved.length, 1);
        assert.equal(saved[0].item, item);
        assert.equal(saved[0].response, response);
        assert.equal(response.body, body);
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1, "content failure must not retry the request");
  assert.deepEqual(saved[0].item, {
    startedMS: 110,
    completedMS: 110,
    status: 200,
    traceID: "00000000000000000000000000000001",
  });
});

test("membership rejection fails on continued admission after TTL or an unrelated HTTP failure", async () => {
  for (const status of [200, 503]) {
    let clock = 0;
    await assert.rejects(
      observeDisplayRejection({
        committedMS: 0,
        ttlMS: 200,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        request: async () => ({
          status,
          traceID: clock.toString(16).padStart(32, "0"),
        }),
      }),
    );
  }
});

test("a pre-deadline read may complete late before the next read rejects", async () => {
  let clock = 150,
    calls = 0;
  const result = await observeDisplayRejection({
    committedMS: 0,
    ttlMS: 200,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    request: async () => {
      clock = 250;
      return {
        status: ++calls === 1 ? 200 : 401,
        traceID: calls.toString(16).padStart(32, "0"),
      };
    },
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].startedMS, 150);
  assert.equal(result[1].status, 401);
});
