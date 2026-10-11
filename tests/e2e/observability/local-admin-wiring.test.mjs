import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { collectTrace } from "./collect.mjs";
import { collectObservabilityResolution } from "./resolve-evidence.mjs";
import { exerciseLocalAdminLogin } from "./exercise-local-admin-login.mjs";
import { inspectLocalAdminLogin } from "./local-admin-login.mjs";
import { fixture as loginFixture } from "./local-admin-login-fixtures.mjs";
import { fakeClient } from "./local-admin-client-fixture.mjs";
import { observabilityResolutionFixture } from "./resolve-evidence-fixtures.mjs";

function setup(t, source = "shared-background") {
  const f = observabilityResolutionFixture(source);
  const remap = new Map(
    [...["a", "b", "c"]].map((letter, i) => [
      letter.repeat(32),
      ["b", "c", "d"][i].repeat(32),
    ]),
  );
  const traces = new Map();
  for (const trace of f.traces.values()) {
    trace.traceID = remap.get(trace.traceID);
    for (const span of trace.spans) {
      span.traceID = trace.traceID;
      for (const ref of span.references) ref.traceID = remap.get(ref.traceID);
    }
    traces.set(trace.traceID, trace);
  }
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-login-wiring-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queries = [],
    waits = [],
    expected = [];
  const request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    queries.push(id);
    return Response.json({
      data: [id === "a".repeat(32) ? loginFixture() : traces.get(id)],
    });
  };
  const options = {
    client: fakeClient(),
    settings: {
      ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "true",
      ANTNEST_EDGE_RESOLVE_CACHE_TTL: "30s",
    },
    jaeger: "http://jaeger",
    resolveEvidenceDirectory: directory,
    collect: (base, id, inspect, signal) =>
      collectTrace(base, id, inspect, signal, {
        request,
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
    collectResolution: (base, item, options) => {
      expected.push(item);
      return collectObservabilityResolution(base, item, {
        ...options,
        request,
        wait: async (ms) => {
          waits.push(ms);
        },
      });
    },
  };
  return { f, traces, directory, queries, waits, expected, options };
}

for (const source of ["rpc", "cache", "shared", "shared-background"])
  test(`login exercise uses real single-query login and fixed-source session collectors: ${source}`, async (t) => {
    const f = setup(t, source);
    const result = await exerciseLocalAdminLogin(f.options);
    assert.deepEqual(f.waits, [6000, 6000, 1000, 1000]);
    assert.equal(f.queries[0], "a".repeat(32));
    assert.equal(f.expected.length, 1);
    assert.deepEqual(f.expected[0], {
      traceID: "b".repeat(32),
      profile: "session",
      route: "/api/session",
      method: "GET",
      status: 200,
      resolveTTLMS: 30000,
    });
    assert.equal(result.traces[0].database_spans, 8);
    assert.equal(result.traces[0].transactions, 1);
    assert.equal(
      result.traces[1].gateway_resolution.source,
      source.startsWith("shared") ? "shared" : source,
    );
    assert.equal(result.traces[1].trace_id, "b".repeat(32));
    assert(result.cleanup_revoked && f.options.client.revoked);
    assert.equal(f.options.client.cookie, "");
    assert.equal(
      f.options.client.calls.filter((call) => call.method === "DELETE").length,
      1,
    );
    assert.equal(
      f.options.client.calls.filter((call) => call.method === "GET").length,
      2,
    );
  });

test("source validation failure still archives raw evidence, revokes original Cookie and verifies denial", async (t) => {
  const f = setup(t);
  f.traces.get("c".repeat(32)).warnings = ["source observation incomplete"];
  await assert.rejects(exerciseLocalAdminLogin(f.options), {
    name: "Error",
    message: "observability Resolve evidence validation failed",
  });
  assert(f.options.client.revoked);
  assert.equal(f.options.client.calls.at(-1).method, "GET");
  const run = readdirSync(f.directory)[0];
  const raw = JSON.parse(
    readFileSync(
      join(f.directory, run, "sample-1", `${"c".repeat(32)}.json`),
      "utf8",
    ),
  );
  assert.deepEqual(raw.warnings, ["source observation incomplete"]);
});

test("session collection uses the configured TTL, not the observed cache marker budget", async (t) => {
  const f = setup(t, "cache");
  f.options.settings.ANTNEST_EDGE_RESOLVE_CACHE_TTL = "1s";
  await assert.rejects(exerciseLocalAdminLogin(f.options));
  assert(f.options.client.revoked);
  assert.equal(f.expected[0].resolveTTLMS, 1000);
});

for (const directory of [undefined, ".cache/forbidden"])
  test(`login preflights evidence directory ${String(directory)} before using credentials`, async () => {
    const client = fakeClient();
    await assert.rejects(
      exerciseLocalAdminLogin({
        client,
        settings: {},
        jaeger: "http://jaeger",
        resolveEvidenceDirectory: directory,
        collect: async () => ({}),
        collectResolution: async () => ({}),
      }),
    );
    assert.deepEqual(client.calls, []);
  });

test("an already-cancelled exercise does not use login credentials", async (t) => {
  const f = setup(t);
  const controller = new AbortController();
  const reason = new Error("caller cancelled before login");
  controller.abort(reason);
  await assert.rejects(
    exerciseLocalAdminLogin({ ...f.options, signal: controller.signal }),
    (error) => error === reason,
  );
  assert.deepEqual(f.options.client.calls, []);
  assert.deepEqual(f.queries, []);
});

for (const stage of ["login", "session"])
  test(`cancellation after ${stage} HTTP response prevents further work and still revokes the original session`, async (t) => {
    const f = setup(t);
    const controller = new AbortController();
    const reason = new Error(`caller cancelled after ${stage}`);
    const client = f.options.client;
    const request = client.request.bind(client);
    client.request = async (path, options) => {
      const result = await request(path, options);
      if (
        path === (stage === "login" ? "/api/session/login" : "/api/session") &&
        !controller.signal.aborted
      )
        controller.abort(reason);
      return result;
    };
    await assert.rejects(
      exerciseLocalAdminLogin({ ...f.options, signal: controller.signal }),
      (error) => error === reason,
    );
    assert.deepEqual(f.queries, []);
    assert.deepEqual(
      client.calls.map((call) => call.method),
      stage === "login"
        ? ["POST", "DELETE", "GET"]
        : ["POST", "GET", "DELETE", "GET"],
    );
    assert(client.revoked);
    assert.equal(client.cookie, "");
  });

test("login content gate cannot ignore an explicitly disabled deployment capture setting", () => {
  assert.throws(
    () =>
      inspectLocalAdminLogin(loginFixture(), "login", {
        captureRpcContent: false,
      }),
    { name: "Error", message: "local admin trace validation failed" },
  );
});
