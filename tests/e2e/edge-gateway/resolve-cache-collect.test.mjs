import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { loadFixture } from "./resolve-cache-load-fixtures.mjs";
import { addLoadCleanup } from "./resolve-cache-load-close-fixtures.mjs";
import * as collector from "./resolve-cache-collect.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";

function setup(t) {
  const f = addLoadCleanup(loadFixture());
  const directory = mkdtempSync(join(temporaryStorageRoot(), "resolve-load-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let rounds = 0;
  const search = async (_base, parameters) => {
    if (parameters.get("operation") === "HTTP POST identity-service") rounds++;
    const all = [...f.traces.values()];
    const operation = parameters.get("operation");
    if (operation === "agent_ui.acp.close") return [f.close];
    if (operation === "HTTP DELETE /v1/acp") return [f.close];
    if (operation === "HTTP GET /status") return [f.health];
    if (operation === "gateway.identity.resolve.refresh")
      return rounds >= 2 ? [f.refresh] : [];
    // Model a late background export: both independent inventories acquire it
    // on the second search round, after the actual HTTP request set was already complete.
    return [all[0], ...(rounds >= 2 ? [f.refresh] : [])];
  };
  const request = async (url) =>
    Response.json({
      data: [f.traces.get(new URL(url).pathname.split("/").at(-1))],
    });
  return {
    ...f,
    directory,
    search,
    request,
    wait: async () => {},
    settleMS: 0,
    attempts: 5,
    rounds: () => rounds,
  };
}
const collect = (f) =>
  collector.collectResolveLoad(
    "http://jaeger",
    f.wire,
    f.agentID,
    f.settings,
    [],
    f,
  );

for (const errors of [{}, false, "", 0])
  test(`actual HTTP Trace query rejects malformed errors ${JSON.stringify(errors)}`, async (t) => {
    const f = setup(t);
    f.request = async () =>
      Response.json({
        data: [f.traces.get(f.wire.requests[0].trace_id)],
        errors,
      });
    await assert.rejects(collect(f), /backend errors/u);
  });

test("load collector converges late refresh and independently archives both RPC searches", async (t) => {
  const f = setup(t);
  const result = await collect(f);
  assert.equal(result.gateway_rpc_attempts, 2);
  assert.equal(result.identity_rpc_receipts, 2);
  assert.deepEqual(
    result.convergence.map((round) => round.attempt),
    [2, 3, 4],
  );
  assert.equal(
    new Set(result.convergence.map((round) => round.snapshot_sha256)).size,
    1,
  );
  for (const round of result.convergence) {
    assert.match(round.snapshot_sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(round.archived_trace_ids, [...f.traces.keys()].sort());
    assert.deepEqual(round.causal_query_ids.close, [f.close.traceID]);
    assert.deepEqual(round.causal_query_ids.delete, [f.close.traceID]);
    assert.equal(round.causal_query_ids.http.length, 100);
  }
  assert(f.rounds() >= 4);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(f.directory, "traces", `${f.refresh.traceID}.json`)),
    ),
    f.refresh,
  );
  const inventory = JSON.parse(
    readFileSync(join(f.directory, "search-4.json")),
  );
  assert(
    inventory.gateway.some((trace) => trace.traceID === f.refresh.traceID),
  );
  assert(
    inventory.identity.some((trace) => trace.traceID === f.refresh.traceID),
  );
});

test("load collector rejects saturated searches instead of inferring a low RPC count", async (t) => {
  const f = setup(t);
  f.search = async () => Array(500).fill(f.refresh);
  await assert.rejects(collect(f), /saturated/u);
});

test("independent feed polling remains archived without preventing measured scope convergence", async (t) => {
  const f = setup(t),
    search = f.search;
  f.search = async (base, parameters, options) => {
    const rows = await search(base, parameters, options);
    if (parameters.get("operation") === "HTTP POST identity-service") {
      const traceID = (1000 + f.rounds()).toString(16).padStart(32, "0");
      rows.push({
        traceID,
        processes: { edge: { serviceName: "edge-gateway" } },
        spans: [
          {
            traceID,
            spanID: "feed-poll",
            processID: "edge",
            operationName: "session.revocations.poll",
            references: [],
            tags: [],
            startTime: 1,
            duration: 1,
          },
        ],
      });
    }
    return rows;
  };
  assert.equal((await collect(f)).gateway_rpc_attempts, 2);
  assert(
    JSON.parse(readFileSync(join(f.directory, "search-4.json"))).gateway.some(
      (trace) => trace.spans[0].operationName === "session.revocations.poll",
    ),
  );
});

test("an incomplete independent Identity search cannot borrow Gateway results", async (t) => {
  const f = setup(t),
    search = f.search;
  f.search = async (base, parameters, options) =>
    parameters.get("service") === "identity-service"
      ? []
      : search(base, parameters, options);
  await assert.rejects(collect(f), /independent Identity/u);
});

test("an incomplete independent Gateway search cannot borrow Identity results", async (t) => {
  const f = setup(t),
    search = f.search;
  f.search = async (base, parameters, options) => {
    const rows = await search(base, parameters, options);
    return parameters.get("operation") === "HTTP POST identity-service"
      ? []
      : rows;
  };
  await assert.rejects(collect(f), /independent Gateway/u);
});

test("unclassified orphan RPC attempts cannot disappear from independent search inventories", async (t) => {
  const f = setup(t),
    search = f.search;
  const orphan = structuredClone(f.refresh);
  orphan.traceID = "f".repeat(32);
  orphan.spans.shift();
  for (const span of orphan.spans) {
    span.traceID = orphan.traceID;
    for (const reference of span.references) reference.traceID = orphan.traceID;
  }
  f.search = async (base, parameters, options) => {
    const rows = await search(base, parameters, options);
    if (
      parameters.get("service") === "identity-service" ||
      parameters.get("operation") === "HTTP POST identity-service"
    )
      rows.push(orphan);
    return rows;
  };
  await assert.rejects(collect(f), /missing synchronous parent/u);
});

test("collector reads all 100 actual HTTP trace IDs in each round without legacy searches", async (t) => {
  const f = setup(t),
    request = f.request,
    search = f.search;
  const reads = new Map();
  f.request = async (url, options) => {
    const id = new URL(url).pathname.split("/").at(-1);
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return request(url, options);
  };
  f.search = async (base, query, options) => {
    assert(
      !["acp session/list", "acp initialize"].includes(query.get("operation")),
    );
    return search(base, query, options);
  };
  const result = await collect(f);
  assert.equal(result.http_traces, 100);
  for (const row of f.wire.requests)
    assert.equal(reads.get(row.trace_id), f.rounds());
  assert.equal(new Set(result.requests.map((row) => row.trace_id)).size, 100);
});

test("one missing actual HTTP trace cannot be substituted by complete search results", async (t) => {
  const f = setup(t),
    request = f.request;
  f.request = async (url, options) =>
    url.endsWith(f.wire.requests[50].trace_id)
      ? Response.json({ data: [] })
      : request(url, options);
  await assert.rejects(collect(f), /actual HTTP Trace missing/u);
});

test("a wrong direct HTTP trace snapshot is rejected even if the expected trace exists elsewhere", async (t) => {
  const f = setup(t),
    request = f.request;
  f.request = async (url, options) =>
    url.endsWith(f.wire.requests[50].trace_id)
      ? Response.json({ data: [f.traces.get(f.wire.requests[0].trace_id)] })
      : request(url, options);
  await assert.rejects(collect(f), /wrong actual HTTP Trace/u);
});

test("late SQL warnings reset complete-closure convergence and remain in raw and strict diagnostics", async (t) => {
  const f = setup(t),
    search = f.search;
  const first = f.traces.get(f.wire.requests[0].trace_id);
  f.search = async (base, query, options) => {
    const rows = await search(base, query, options);
    if (f.rounds() >= 3)
      first.spans.find((span) => span.spanID === "list-sql").warnings = [
        "late SQL warning",
      ];
    return rows;
  };
  const result = await collect(f);
  assert.equal(f.rounds(), 5);
  assert.equal(result.strict_trace, "failed");
  assert(result.warnings.includes("late SQL warning"));
  const raw = JSON.parse(
    readFileSync(join(f.directory, "traces", first.traceID + ".json")),
  );
  assert.deepEqual(
    raw.spans.find((span) => span.spanID === "list-sql").warnings,
    ["late SQL warning"],
  );
});

test("a refresh linked to an earlier request cannot replace the final request's refresh", async (t) => {
  const f = setup(t);
  f.refresh.spans[0].references[0].traceID = f.wire.requests[98].trace_id;
  await assert.rejects(collect(f));
});

test("HTTP trace collection cancellation stops requests and keeps the completed query archive", async (t) => {
  const f = setup(t),
    request = f.request,
    controller = new AbortController();
  let calls = 0;
  f.signal = controller.signal;
  f.request = async (url, options) => {
    calls++;
    const response = await request(url, options);
    if (calls === 1) controller.abort(new Error("collector cancelled"));
    return response;
  };
  await assert.rejects(collect(f), /collector cancelled/u);
  assert.equal(calls, 1);
});

for (const [name, operation] of [
  ["close", "agent_ui.acp.close"],
  ["DELETE", "HTTP DELETE /v1/acp"],
  ["health", "HTTP GET /status"],
])
  test(`independent ${name} inventory cannot borrow another search's spans`, async (t) => {
    const f = setup(t),
      search = f.search;
    f.search = (base, query, options) =>
      query.get("operation") === operation ? [] : search(base, query, options);
    await assert.rejects(collect(f), /close|DELETE|health/u);
  });

test("load collector selects and archives reverse-linked close plus independent health sources", async (t) => {
  const f = setup(t),
    search = f.search,
    seen = new Set();
  f.search = (base, query, options) => {
    seen.add(query.get("operation"));
    return search(base, query, options);
  };
  const result = await collect(f);
  for (const operation of [
    "agent_ui.acp.close",
    "HTTP DELETE /v1/acp",
    "HTTP GET /status",
  ])
    assert(seen.has(operation));
  for (const trace of [f.close, f.health])
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(f.directory, "traces", trace.traceID + ".json")),
      ),
      trace,
    );
  assert.equal(result.owner_cleanup.close_trace_id, f.close.traceID);
  assert.equal(result.owner_cleanup.clock.source_trace_id, f.health.traceID);
});

test("late close export requires three stable complete protocol snapshots", async (t) => {
  const f = setup(t),
    search = f.search;
  f.search = async (base, query, options) => {
    const rows = await search(base, query, options);
    return query.get("operation") === "agent_ui.acp.close" && f.rounds() < 3
      ? []
      : rows;
  };
  assert.equal((await collect(f)).owner_cleanup.classified_errors.length, 2);
  assert.equal(f.rounds(), 5);
});

test("late close warning resets raw closure convergence and is retained", async (t) => {
  const f = setup(t),
    search = f.search;
  f.search = async (base, query, options) => {
    const rows = await search(base, query, options);
    if (f.rounds() >= 3) f.close.spans[1].warnings = ["late DELETE warning"];
    return rows;
  };
  const result = await collect(f);
  assert.equal(f.rounds(), 5);
  assert(result.warnings.includes("late DELETE warning"));
  assert.equal(result.strict_trace, "failed");
});

test("real Jaeger v3 search adapter uses one cutoff for all six inventories", async (t) => {
  const f = setup(t),
    request = f.request,
    cutoffs = [];
  f.search = searchJaegerTraces;
  f.request = async (input, options) => {
    const url = new URL(input);
    if (url.pathname !== "/api/v3/trace-summaries")
      return request(input, options);
    const operation = url.searchParams.get("query.operationName");
    cutoffs.push(url.searchParams.get("query.startTimeMax"));
    let rows;
    if (
      operation === "agent_ui.acp.close" ||
      operation === "HTTP DELETE /v1/acp"
    )
      rows = [f.close];
    else if (operation === "HTTP GET /status") {
      assert.equal(
        JSON.parse(url.searchParams.get("query.attributes"))[
          "antnest.listener"
        ],
        "control",
      );
      rows = [f.health];
    } else if (operation === "gateway.identity.resolve.refresh")
      rows = [f.refresh];
    else rows = [f.traces.get(f.wire.requests[0].trace_id), f.refresh];
    return Response.json({
      summaries: rows.map((trace) => ({ traceId: trace.traceID })),
    });
  };
  const result = await collect(f);
  assert.equal(result.owner_cleanup.classified_errors.length, 2);
  assert.equal(cutoffs.length, 18);
  for (let i = 0; i < cutoffs.length; i += 6)
    assert.equal(new Set(cutoffs.slice(i, i + 6)).size, 1);
});

for (const failedOperation of [
  "agent_ui.acp.close",
  "HTTP DELETE /v1/acp",
  "HTTP GET /status",
])
  test(`failed ${failedOperation} query still archives other independent inventories and known HTTP sources`, async (t) => {
    const f = setup(t),
      search = f.search;
    f.attempts = 3;
    f.search = async (base, query, options) => {
      if (query.get("operation") === failedOperation)
        throw new Error("controlled independent query failure");
      return search(base, query, options);
    };
    await assert.rejects(collect(f), /controlled independent query failure/u);
    const raw = JSON.parse(readFileSync(join(f.directory, "search-1.json")));
    assert.equal(raw.http.length, 100);
    for (const [name, operation] of [
      ["close", "agent_ui.acp.close"],
      ["delete", "HTTP DELETE /v1/acp"],
      ["health", "HTTP GET /status"],
    ])
      if (operation !== failedOperation) assert.equal(raw[name].length, 1);
    assert.equal(
      JSON.parse(
        readFileSync(
          join(
            f.directory,
            `http-query-1-${f.wire.requests[99].trace_id}.json`,
          ),
        ),
      ).data[0].traceID,
      f.wire.requests[99].trace_id,
    );
  });

test("global cancellation during independent searches archives completed sources and dispatches no more queries", async (t) => {
  const f = setup(t),
    search = f.search,
    controller = new AbortController(),
    seen = [];
  f.signal = controller.signal;
  f.search = async (base, query, options) => {
    seen.push(query.get("operation"));
    const rows = await search(base, query, options);
    if (query.get("operation") === "agent_ui.acp.close")
      controller.abort(new Error("cancelled during close inventory"));
    return rows;
  };
  await assert.rejects(collect(f), /cancelled during close inventory/u);
  assert.equal(seen.at(-1), "agent_ui.acp.close");
  assert.equal(
    JSON.parse(readFileSync(join(f.directory, "search-1.json"))).close[0]
      .traceID,
    f.close.traceID,
  );
});

for (const cancel of [false, true])
  test(`collector retains ${cancel ? "abort" : "query"} failure when final search archive also fails`, async (t) => {
    const f = setup(t),
      search = f.search,
      controller = new AbortController();
    const original = new Error(
      cancel ? "original collection abort" : "original close search failure",
    );
    const archive = new Error("search archive failure");
    f.signal = controller.signal;
    f.search = async (base, query, options) => {
      if (query.get("operation") === "agent_ui.acp.close") {
        if (cancel) controller.abort(original);
        throw original;
      }
      return search(base, query, options);
    };
    f.write = (directory, name, raw) => {
      if (name === "search-1.json") throw archive;
      return writeEvidenceFile(directory, name, raw);
    };
    await assert.rejects(
      collect(f),
      (error) =>
        error instanceof AggregateError &&
        error.errors.includes(original) &&
        error.errors.includes(archive),
    );
  });

for (const source of ["missing-link", "wrong-ui-link", "unparented-delete"])
  test(`independent ${source} cleanup source cannot be silently dropped`, async (t) => {
    const f = setup(t),
      search = f.search;
    const extra = structuredClone(f.close);
    extra.traceID = "c".repeat(32);
    for (const span of extra.spans) {
      span.traceID = extra.traceID;
      for (const ref of span.references)
        if (ref.refType === "CHILD_OF") ref.traceID = extra.traceID;
    }
    if (source === "missing-link") extra.spans[0].references = [];
    if (source === "wrong-ui-link")
      extra.spans[0].references[0].spanID = "root";
    if (source === "unparented-delete") {
      extra.spans.shift();
      extra.spans[0].references = [];
    }
    f.search = async (base, query, options) => {
      const rows = await search(base, query, options);
      if (
        query.get("operation") ===
        (source === "unparented-delete"
          ? "HTTP DELETE /v1/acp"
          : "agent_ui.acp.close")
      )
        rows.push(extra);
      return rows;
    };
    await assert.rejects(collect(f), /close|DELETE|cleanup/u);
  });
