import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { exerciseTemplate } from "./exercise-template.mjs";
import { exerciseEgressDatabase } from "./exercise-egress-database.mjs";
import { collectObservabilityResolution } from "./resolve-evidence.mjs";
import { consoleObservationFixture } from "./console-observation-fixtures.mjs";

function setup(t, kind, source = "cache") {
  const f = consoleObservationFixture(kind, source);
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-console-observation-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The entrypoint must use the injected collector; never issue a real Jaeger
  // request if it accidentally retains its former inline fetch.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("un-injected trace query");
  });
  const values = {
    model: "model-1",
    image: "runtime:test",
    agent: "agent-1",
    database: "antnest_egress",
    jaeger: "http://jaeger",
    "resolve-evidence-directory": directory,
  };
  const settings = {
    ANTNEST_EDGE_RESOLVE_CACHE_TTL: "30s",
    ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT: "true",
  };
  const calls = [],
    outputs = [],
    requests = [],
    waits = [],
    expected = [];
  const template = {
    template_id: "template-1",
    runtime: { image_ref: values.image },
    revision: 1,
  };
  const assignment = {
    agent_id: values.agent,
    action: "allow_all",
    resource_version: 7,
  };
  const policy = {
    ...assignment,
    attachment: { state: "open", resource_version: 4 },
  };
  let writes = 0,
    reads = 0;
  const client = {
    revoked: false,
    async request(path, options = {}) {
      const method = options.method ?? (options.body ? "POST" : "GET");
      calls.push({ path, method, options });
      if (path === "/api/session/login")
        return {
          body: { principal: { organization_id: "org-1", user_id: "user-1" } },
        };
      if (method === "DELETE") {
        assert.equal(path, "/api/session");
        assert.equal(options.status, 204);
        this.revoked = true;
        return {};
      }
      let body;
      if (kind === "template") {
        if (method === "POST") {
          assert.equal(path, "/api/admin/templates");
          assert.equal(options.status, 201);
          assert.equal(options.body.model_profile_id, values.model);
          assert.equal(options.body.runtime.image_ref, values.image);
          if (writes++)
            assert.deepEqual(
              options,
              calls.find((call) => call.path === "/api/admin/templates")
                .options,
            );
        } else assert.equal(path, "/api/admin/templates/template-1");
        body = structuredClone(template);
      } else {
        assert.equal(path, "/api/admin/agents/agent-1/network-policy");
        if (method === "PUT") {
          writes++;
          assert.deepEqual(options.body, {
            action: policy.action,
            expected_resource_version: policy.resource_version,
          });
          assert.deepEqual(
            JSON.parse(
              decodeURIComponent(
                options.headers["X-Antnest-Expected-Principal"],
              ),
            ),
            ["org-1", "user-1"],
          );
        } else reads++;
        body = structuredClone(method === "PUT" ? assignment : policy);
      }
      f.mutateResponse?.(body, { method, writes, reads });
      return { body, traceID: f.trace.traceID };
    },
  };
  const options = {
    output: (text) => outputs.push(JSON.parse(text)),
    collect: async (base, item, options) => {
      expected.push(item);
      return collectObservabilityResolution(base, item, {
        ...options,
        request: async (url) => {
          const id = new URL(url).pathname.split("/").at(-1);
          requests.push(id);
          return Response.json({ data: [f.traces.get(id)] });
        },
        wait: async (ms) => {
          waits.push(ms);
        },
      });
    },
  };
  const invoke = () =>
    (kind === "template" ? exerciseTemplate : exerciseEgressDatabase)(
      client,
      settings,
      values,
      options,
    );
  return Object.assign(f, {
    kind,
    directory,
    values,
    settings,
    client,
    calls,
    outputs,
    requests,
    waits,
    expectedCalls: expected,
    options,
    invoke,
  });
}

for (const kind of ["template", "egress"])
  for (const source of ["rpc", "cache", "shared", "shared-background"])
    test(`${kind} entrypoint collects complete ${source} evidence while retaining the business flow`, async (t) => {
      const f = setup(t, kind, source);
      const result = await f.invoke();
      assert.equal(
        result.gateway_resolution.source,
        source.startsWith("shared") ? "shared" : source,
      );
      assert.deepEqual(f.waits, [6000, 1000, 1000]);
      assert.equal(f.requests.length, f.traces.size * 3);
      assert.deepEqual(f.expectedCalls, [
        { ...f.expected, resolveTTLMS: 30000 },
      ]);
      assert(f.client.revoked);
      assert.deepEqual(
        f.calls.map((call) => call.method),
        kind === "template"
          ? ["POST", "POST", "POST", "GET", "DELETE"]
          : ["POST", "GET", "PUT", "GET", "DELETE"],
      );
      assert.equal(result.transactions, 1);
      assert.equal(result.strict_trace, "passed");
      assert.equal(f.outputs.at(-1).trace_id, f.trace.traceID);
      assert.equal(
        kind === "template" ? result.replay_verified : result.policy_unchanged,
        true,
      );
    });

for (const kind of ["template", "egress"]) {
  test(`${kind} observes cancellation after the real collector completes before reporting success`, async (t) => {
    const f = setup(t, kind),
      controller = new AbortController(),
      reason = new Error("caller cancelled after collection");
    f.options.signal = controller.signal;
    const collect = f.options.collect;
    f.options.collect = async (...args) => {
      const result = await collect(...args);
      controller.abort(reason);
      return result;
    };
    await assert.rejects(f.invoke(), (error) => error === reason);
    assert(f.client.revoked);
    assert.equal(f.requests.length, 3);
    assert(!f.outputs.some((report) => report.strict_trace === "passed"));
  });

  test(`${kind} cannot report success when current business SQL has a strict error`, async (t) => {
    const f = setup(t, kind);
    f.trace.spans
      .find(
        (span) =>
          span.spanID === (kind === "template" ? "catalog-write" : "inside-0"),
      )
      .tags.push({ key: "otel.status_code", value: "ERROR" });
    await assert.rejects(f.invoke());
    assert(f.client.revoked);
    assert.equal(f.requests.length, 3);
    const run = readdirSync(f.directory)[0];
    assert(
      JSON.parse(
        readFileSync(
          join(f.directory, run, "sample-3", `${f.trace.traceID}.json`),
          "utf8",
        ),
      ).spans.some((span) =>
        span.tags.some(
          (tag) => tag.key === "otel.status_code" && tag.value === "ERROR",
        ),
      ),
    );
  });

  test(`${kind} forwards the actual caller cancellation signal into collection`, async (t) => {
    const f = setup(t, kind),
      controller = new AbortController(),
      reason = new Error("caller cancelled collection");
    f.options.signal = controller.signal;
    const collect = f.options.collect;
    f.options.collect = (base, item, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort(reason);
      return collect(base, item, options);
    };
    await assert.rejects(f.invoke(), (error) => error === reason);
    assert(f.client.revoked);
    assert.deepEqual(f.requests, []);
  });

  test(`${kind} source failure retains raw evidence and still logs out`, async (t) => {
    const f = setup(t, kind, "shared");
    f.traces.get("b".repeat(32)).warnings = ["missing source parent"];
    await assert.rejects(f.invoke());
    assert(f.client.revoked);
    const run = readdirSync(f.directory)[0];
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(f.directory, run, "sample-1", `${"b".repeat(32)}.json`),
          "utf8",
        ),
      ).warnings,
      ["missing source parent"],
    );
  });

  for (const value of [undefined, ".cache/forbidden"])
    test(`${kind} preflights its evidence directory before login: ${String(value)}`, async (t) => {
      const f = setup(t, kind);
      f.values["resolve-evidence-directory"] = value;
      await assert.rejects(f.invoke());
      assert.deepEqual(f.calls, []);
    });

  test(`${kind} rejects a stale cache using the configured TTL`, async (t) => {
    const f = setup(t, kind);
    f.settings.ANTNEST_EDGE_RESOLVE_CACHE_TTL = "1s";
    await assert.rejects(f.invoke());
    assert(f.client.revoked);
    assert.equal(f.expectedCalls[0].resolveTTLMS, 1000);
  });

  test(`${kind} invalid capture config fails before login`, async (t) => {
    const f = setup(t, kind);
    f.settings.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT = "yes";
    await assert.rejects(f.invoke());
    assert.deepEqual(f.calls, []);
  });

  for (const afterLogin of [false, true])
    test(`${kind} cancellation ${afterLogin ? "after login still cleans up" : "before login prevents credentials"}`, async (t) => {
      const f = setup(t, kind),
        controller = new AbortController(),
        reason = new Error("caller cancelled");
      f.options.signal = controller.signal;
      if (afterLogin) {
        const request = f.client.request.bind(f.client);
        f.client.request = async (...args) => {
          const response = await request(...args);
          controller.abort(reason);
          return response;
        };
      } else controller.abort(reason);
      await assert.rejects(f.invoke(), (error) => error === reason);
      assert.deepEqual(
        f.calls.map((call) => call.method),
        afterLogin ? ["POST", "DELETE"] : [],
      );
      assert.deepEqual(f.requests, []);
    });
}

for (const [name, mutate] of [
  [
    "created image",
    (body, stage) => {
      if (stage.writes === 1) body.runtime.image_ref = "unexpected";
    },
  ],
  [
    "idempotency replay",
    (body, stage) => {
      if (stage.writes === 2) body.template_id = "other";
    },
  ],
  [
    "read revision",
    (body, stage) => {
      if (stage.method === "GET") body.revision = 2;
    },
  ],
])
  test(`Template still rejects changed ${name}`, async (t) => {
    const f = setup(t, "template");
    f.mutateResponse = mutate;
    await assert.rejects(f.invoke());
    assert(f.client.revoked);
    assert.deepEqual(f.requests, []);
  });
for (const [name, mutate] of [
  [
    "unknown initial action",
    (body, stage) => {
      if (stage.reads === 1) body.action = "unknown";
    },
  ],
  [
    "saved action",
    (body, stage) => {
      if (stage.method === "PUT") body.action = "deny_all";
    },
  ],
  [
    "saved revision",
    (body, stage) => {
      if (stage.method === "PUT") body.resource_version = 8;
    },
  ],
  [
    "subsequent read",
    (body, stage) => {
      if (stage.reads === 2) body.action = "deny_all";
    },
  ],
])
  test(`Egress still rejects changed ${name}`, async (t) => {
    const f = setup(t, "egress");
    f.mutateResponse = mutate;
    await assert.rejects(f.invoke());
    assert(f.client.revoked);
    assert.deepEqual(f.requests, []);
  });
