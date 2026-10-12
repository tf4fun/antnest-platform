import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { loadFixture } from "./resolve-cache-load-fixtures.mjs";
import * as collector from "./resolve-cache-collect.mjs";

function setup(t) {
  const f = loadFixture();
  const directory = mkdtempSync(join(temporaryStorageRoot(), "resolve-load-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let rounds = 0;
  const search = async (_base, parameters) => {
    if (parameters.get("operation") === "acp session/list") rounds++;
    const all = [...f.traces.values()];
    const operation = parameters.get("operation");
    if (operation === "acp session/list")
      return all.filter(
        (trace) => trace.spans[0].operationName === "acp session/list",
      );
    if (operation === "acp initialize")
      return all.filter(
        (trace) => trace.spans[0].operationName === "acp initialize",
      );
    if (operation === "gateway.identity.resolve.refresh")
      return rounds >= 2 ? [f.refresh] : [];
    // Model a late background export: both independent inventories acquire it
    // on the second search round, after the message set was already complete.
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
  test(`upgrade Trace query rejects malformed errors ${JSON.stringify(errors)}`, async (t) => {
    const f = setup(t);
    f.request = async () =>
      Response.json({ data: [f.traces.get(f.wire.upgrade.trace_id)], errors });
    await assert.rejects(collect(f), /backend errors/u);
  });

test("load collector converges late refresh and independently archives both RPC searches", async (t) => {
  const f = setup(t);
  const result = await collect(f);
  assert.equal(result.gateway_rpc_attempts, 2);
  assert.equal(result.identity_rpc_receipts, 2);
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
  f.search = async (base, parameters, options) =>
    parameters.get("operation") === "HTTP POST identity-service"
      ? []
      : search(base, parameters, options);
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
