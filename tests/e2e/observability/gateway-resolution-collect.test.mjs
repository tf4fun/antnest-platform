import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { collectResolutionSources } from "../../support/gateway-resolution-collect.mjs";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import {
  addResolveRPC,
  sharedResolutionFixture,
  setTag,
  resolvePrefix as prefix,
  sourceID,
  triggerID,
} from "./gateway-resolution-fixtures.mjs";

function fixture(t, background = false) {
  const f = sharedResolutionFixture(background);
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-resolve-source-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    requests.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  return { ...f, directory, requests, request };
}

test("source collector archives exact raw source and trigger traces without mutating them", async (t) => {
  const f = fixture(t, true);
  const before = JSON.stringify([...f.traces.values()]);
  const result = await collectResolutionSources("http://jaeger/", [f.trace], f);
  assert.deepEqual(f.requests, [sourceID, triggerID]);
  assert.deepEqual(new Set(result.traces.keys()), new Set(f.traces.keys()));
  assert.deepEqual(result.archivedTraceIDs, new Set(f.traces.keys()));
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, id + ".json"))),
      trace,
    );
  assert.equal(JSON.stringify([...f.traces.values()]), before);
});

test("revisited trace is fetched once but each exact linked span is checked", async (t) => {
  const f = fixture(t);
  const another = structuredClone(f.decision);
  another.spanID = "second-decision";
  f.trace.spans.push(another);
  await collectResolutionSources("http://jaeger", [f.trace], f);
  assert.deepEqual(f.requests, [sourceID]);
  another.references[1].spanID = "missing-client";
  f.requests.length = 0;
  await assert.rejects(
    collectResolutionSources("http://jaeger", [f.trace], f),
    /exact linked/u,
  );
  assert.deepEqual(f.requests, [sourceID]);
});

test("causal references back to a retained trace do not cause fetch loops", async (t) => {
  const f = fixture(t, true);
  // The trigger can be an earlier cache decision in the same request trace as
  // a later waiter. Trace-level cycles do not imply a span ancestry cycle.
  const trigger = structuredClone(f.traces.get(triggerID).spans[1]);
  trigger.traceID = f.trace.traceID;
  trigger.spanID = "earlier-hit";
  trigger.startTime = f.root.startTime + 1;
  for (const ref of trigger.references) ref.traceID = f.trace.traceID;
  f.trace.spans.push(trigger);
  f.origin.root.references[0].traceID = f.trace.traceID;
  f.origin.root.references[0].spanID = trigger.spanID;
  await collectResolutionSources("http://jaeger", [f.trace], f);
  assert.deepEqual(f.requests, [sourceID]);
});

for (const [name, response] of [
  ["missing export", () => new Response(null, { status: 404 })],
  ["backend failure", () => new Response(null, { status: 503 })],
  ["invalid JSON", () => new Response("private-source-body")],
  [
    "query error",
    (f) => Response.json({ data: [f.origin.trace], errors: ["failed"] }),
  ],
  ["missing source", () => Response.json({ data: [] })],
  [
    "duplicate source",
    (f) => Response.json({ data: [f.origin.trace, f.origin.trace] }),
  ],
  [
    "wrong source",
    (f) => Response.json({ data: [{ ...f.origin.trace, traceID: triggerID }] }),
  ],
  [
    "partial source",
    (f) =>
      Response.json({
        data: [
          {
            ...f.origin.trace,
            spans: f.origin.trace.spans.filter((s) => s.spanID !== "root"),
          },
        ],
      }),
  ],
])
  test(`source collector rejects ${name} without inventing or retrying evidence`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    f.request = async () => {
      calls++;
      return response(f);
    };
    await assert.rejects(
      collectResolutionSources("http://jaeger", [f.trace], f),
      (error) => {
        assert(!error.message.includes("private-source-body"));
        return true;
      },
    );
    assert.equal(calls, 1);
  });

test("source acquisition awaits the actual response and aborts owned fetches", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let active = 0;
  f.request = async (_url, { signal }) => {
    active++;
    entered();
    try {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    } finally {
      active--;
    }
  };
  const pending = collectResolutionSources("http://jaeger", [f.trace], {
    ...f,
    signal: controller.signal,
  });
  await started;
  assert.equal(active, 1);
  controller.abort(new Error("source acquisition cancelled"));
  await assert.rejects(pending, /cancelled/u);
  assert.equal(active, 0);
});

for (const malformed of [{ message: "backend failure" }, "", 0, { length: 0 }])
  test(`source query rejects malformed error envelope ${JSON.stringify(malformed)}`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    f.request = async () => {
      calls++;
      return Response.json({ data: [f.origin.trace], errors: malformed });
    };
    await assert.rejects(
      collectResolutionSources("http://jaeger", [f.trace], f),
      /query errors/u,
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, f.trace.traceID + ".json"))),
      f.trace,
    );
  });

test("shared sources require durable archival, while cancellation has no invented source", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    collectResolutionSources("http://jaeger", [f.trace], {
      ...f,
      directory: undefined,
    }),
    /archive/u,
  );
  assert.deepEqual(f.requests, []);
  setTag(f.decision, prefix + "shared_source_state", "cancelled-before-client");
  setTag(f.decision, prefix + "outcome", "unavailable");
  f.decision.references.pop();
  const result = await collectResolutionSources("http://jaeger", [f.trace], f);
  assert.equal(result.traces.size, 1);
  assert.deepEqual(f.requests, []);
});

test("controlled source content capture requires an explicit configured opt-in", async (t) => {
  const f = fixture(t);
  f.origin.trace.spans.find((s) => s.spanID === "resolve-server").logs = [
    {
      fields: [{ key: "antnest.payload.json", value: '{"fixture":true}' }],
    },
  ];
  await assert.rejects(
    collectResolutionSources("http://jaeger", [f.trace], f),
    /capture=false/u,
  );
  const result = await collectResolutionSources("http://jaeger", [f.trace], {
    ...f,
    captureRpcContent: true,
  });
  assert.equal(result.traces.size, 2);
});

test("controlled trigger content capture also requires explicit configured opt-in", async (t) => {
  const f = fixture(t, true);
  const trigger = f.traces.get(triggerID);
  const server = addResolveRPC(
    trigger,
    "",
    trigger.spans[0].startTime + 30000,
  ).server;
  server.logs = [
    { fields: [{ key: "antnest.payload.json", value: '{"fixture":true}' }] },
  ];
  await assert.rejects(
    collectResolutionSources("http://jaeger", [f.trace], f),
    /capture=false/u,
  );
  const result = await collectResolutionSources("http://jaeger", [f.trace], {
    ...f,
    captureRpcContent: true,
  });
  assert.equal(result.traces.size, 3);
});

test("archiving an exact POST source does not itself prove Resolve admission", async (t) => {
  const f = fixture(t);
  const client = structuredClone(
    f.origin.trace.spans.find((s) => s.spanID === "resolve-client"),
  );
  client.spanID = "other-post-client";
  client.operationName = "HTTP POST agent-controller";
  f.origin.trace.spans.push(client);
  f.decision.references[1].spanID = client.spanID;
  const collection = await collectResolutionSources(
    "http://jaeger",
    [f.trace],
    f,
  );
  assert(collection.archivedTraceIDs.has(sourceID));
  assert.throws(
    () => inspectGatewayResolution(f.trace, f.expected, collection),
    /exact Resolve receiving SERVER/u,
  );
});

for (const maxTraces of [1, 2])
  test(`recursive trace limit ${maxTraces} preserves raw evidence without issuing excess queries`, async (t) => {
    const f = fixture(t, true);
    await assert.rejects(
      collectResolutionSources("http://jaeger", [f.trace], { ...f, maxTraces }),
      /collection limit/u,
    );
    assert.deepEqual(f.requests, maxTraces === 1 ? [] : [sourceID]);
    assert(existsSync(join(f.directory, f.trace.traceID + ".json")));
    assert.equal(
      existsSync(join(f.directory, sourceID + ".json")),
      maxTraces === 2,
    );
    assert.equal(existsSync(join(f.directory, triggerID + ".json")), false);
  });

test("a source with missing ancestry remains archived for failure review", async (t) => {
  const f = fixture(t);
  f.origin.trace.spans = f.origin.trace.spans.filter(
    (span) => span.spanID !== "root",
  );
  await assert.rejects(
    collectResolutionSources("http://jaeger", [f.trace], f),
    /parent/u,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.directory, sourceID + ".json"))),
    f.origin.trace,
  );
});

test("abort during response body reading joins that read before returning", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  const entered = Promise.withResolvers();
  let activeReads = 0;
  f.request = async (_url, { signal }) => ({
    status: 200,
    async text() {
      activeReads++;
      entered.resolve();
      try {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      } finally {
        activeReads--;
      }
    },
  });
  const pending = collectResolutionSources("http://jaeger", [f.trace], {
    ...f,
    signal: controller.signal,
  });
  await entered.promise;
  assert.equal(activeReads, 1);
  controller.abort(new Error("body read cancelled"));
  await assert.rejects(pending, /body read cancelled/u);
  assert.equal(activeReads, 0);
});
