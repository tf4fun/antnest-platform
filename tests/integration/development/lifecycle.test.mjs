import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { lifecycleCliFixture as fixture } from "../../support/fixtures/development-lifecycle-cli.mjs";
import {
  lifecycleKinds,
  publicationTrace,
  addPreparationRetries,
  addLifecycleAuxiliaryAbsences,
} from "../../support/fixtures/development-lifecycle.mjs";

test("lifecycle accepts individually owned auxiliary absence probes", async (t) => {
  const f = await fixture(t);
  for (const kind of lifecycleKinds)
    addLifecycleAuxiliaryAbsences(f.lifecycles[kind].trace, kind);
  const result = await f.run();
  assert.equal(result.exit_code, 0, result.log);
  const report = f.read("lifecycle-report.json");
  assert.deepEqual(
    report.lifecycle.map((item) => item.evidence.platform_absence_probes),
    [6, 1, 5, 6, 1],
  );
  assert.deepEqual(
    report.lifecycle[0].evidence.platform_absence_owners.map((owner) => [
      owner.owner_span_id,
      owner.operation,
      owner.probe_span_ids.length,
    ]),
    [
      ["fixture-platform-0", "runtime.platform.ensure_storage", 1],
      ["fixture-platform-1", "runtime.platform.create", 4],
      [
        "fixture-skill-prepare",
        "HTTP POST /internal/runtimes/{agent_id}/skill-sets/prepare",
        1,
      ],
    ],
  );
  for (const item of report.lifecycle)
    assert.deepEqual(
      f.read(`lifecycle-${item.kind}.json`),
      f.lifecycles[item.kind].trace,
    );
});

for (const scenario of ["unknown owner", "no later allocation"])
  test(`lifecycle auxiliary probes reject ${scenario}`, async (t) => {
    const f = await fixture(t);
    const trace = f.lifecycles.create.trace;
    addLifecycleAuxiliaryAbsences(trace, "create");
    const probe = trace.spans.find(
      (span) => span.spanID === "fixture-auth-probe-0",
    );
    if (scenario === "unknown owner")
      probe.references[0].spanID = "fixture-skill-probe";
    else probe.startTime += 1000000;
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(
      f.read("lifecycle-report.json").failure.stage,
      "lifecycle_trace",
    );
  });

for (const [kind, operation] of [
  ["create", "runtime.platform.ensure_storage"],
  ["enable", "runtime.platform.create"],
])
  test(`lifecycle rejects missing ${kind} ${operation} even with the same total count`, async (t) => {
    const f = await fixture(t);
    const trace = f.lifecycles[kind].trace;
    const owner = trace.spans.find((span) => span.operationName === operation);
    const probe = trace.spans.find(
      (span) =>
        span.references[0]?.spanID === owner.spanID &&
        span.tags.some(
          (tag) => tag.key === "http.response.status_code" && tag.value === 404,
        ),
    );
    probe.tags.find((tag) => tag.key === "http.response.status_code").value =
      200;
    const create = f.lifecycles.create.trace;
    const extra = structuredClone(
      create.spans.find((span) => span.spanID === "fixture-platform-1-probe"),
    );
    extra.spanID = "compensating-probe";
    create.spans.push(extra);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(
      f.read("lifecycle-report.json").failure.stage,
      "lifecycle_trace",
    );
  });

for (const scenario of ["completed", "unknown failure", "no later success"])
  test(`lifecycle preparation: ${scenario}`, async (t) => {
    const f = await fixture(t);
    for (const kind of ["create", "enable", "rebuild"]) {
      const trace = f.lifecycles[kind].trace;
      const [retry] = addPreparationRetries(trace, kind);
      if (scenario === "unknown failure")
        retry.tags.find((tag) => tag.key === "otel.status_description").value =
          "dependency unavailable: Skill preparation rejected";
      if (scenario === "no later success") retry.startTime += 1000000;
    }
    const result = await f.run();
    if (scenario !== "completed") {
      assert.notEqual(result.exit_code, 0);
      assert.equal(
        f.read("lifecycle-report.json").failure.stage,
        "lifecycle_trace",
      );
      return;
    }
    assert.equal(result.exit_code, 0, result.log);
    const report = f.read("lifecycle-report.json");
    for (const item of report.lifecycle)
      if (["create", "enable", "rebuild"].includes(item.kind)) {
        assert.equal(item.skillPreparation, true);
        assert.equal(item.evidence.skill_preparation_retries, 2);
        assert.deepEqual(
          f.read(`lifecycle-${item.kind}.json`),
          f.lifecycles[item.kind].trace,
        );
      }
  });

test("ordinary lifecycle CLI preserves five operations, four absences, workspace and retained Agent", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.exit_code, 0, result.log);
  const report = f.read("lifecycle-report.json");
  assert.equal(report.status, "passed");
  assert.deepEqual(
    report.lifecycle.map((x) => x.kind),
    lifecycleKinds,
  );
  assert.equal(report.publication.length, 3);
  assert.equal(
    report.lifecycle.reduce(
      (n, x) => n + x.evidence.platform_absence_probes,
      0,
    ),
    4,
  );
  assert.equal(report.checks.length, 5);
  for (const trace of [
    ...f.publications,
    ...Object.values(f.lifecycles).map((x) => x.trace),
  ])
    assert.equal(
      f.requests.filter((r) => r.url === `/api/traces/${trace.traceID}`).length,
      // Search first loads each publication in full, then the stable collector
      // verifies it with the same three snapshots as lifecycle traces.
      f.publications.includes(trace) ? 4 : 3,
    );
  assert.equal(
    f.requests.filter((r) => r.url === `/api/admin/agents/${f.retainedId}`)
      .length,
    2,
  );
});

test("lifecycle waits for three independent publication roots before creating an Agent", async (t) => {
  const f = await fixture(t);
  let searches = 0;
  f.searchResponse = () => {
    searches++;
    assert(!f.requests.some((r) => r.url === "/api/admin/agents"));
    if (searches === 1) return [];
    if (searches === 2) return f.publications.slice(0, 2);
    if (searches === 3) {
      const data = structuredClone(f.publications);
      const trace = data[2],
        publication = trace.spans[0];
      trace.spans.push({
        ...structuredClone(publication),
        spanID: "publication-parent",
        operationName: "fixture.parent",
      });
      publication.references = [
        {
          refType: "CHILD_OF",
          traceID: trace.traceID,
          spanID: "publication-parent",
        },
      ];
      return data;
    }
    return f.publications;
  };
  const result = await f.run();
  assert.equal(result.exit_code, 0, result.log);
  assert.equal(searches, 4);
  assert.equal(f.read("lifecycle-report.json").publication.length, 3);
});

test("lifecycle publication wait expires without creating an Agent", async (t) => {
  const f = await fixture(t);
  let searches = 0;
  f.searchResponse = () => {
    searches++;
    return f.publications.slice(0, 2);
  };
  // Advance the polling clock without changing the deadline or attempt count.
  f.preload =
    "import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';let tick=0;const now=Date.now;Date.now=()=>now()+tick;const delay=timers.setTimeout;timers.setTimeout=(ms,...args)=>{tick+=ms;return delay(1,...args)};syncBuiltinESMExports();";
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.notEqual(result.exit_code, 0);
  assert(searches > 1 && searches <= 120);
  assert.match(
    f.read("lifecycle-report.json").failure.message,
    /three independent publication traces required/,
  );
  assert(!f.requests.some((r) => r.url === "/api/admin/agents"));
});

test("lifecycle publication wait does not retry a failed Jaeger request", async (t) => {
  const f = await fixture(t);
  let searches = 0;
  f.searchResponse = () => {
    searches++;
    throw new Error("fixture search failure");
  };
  const result = await f.run();
  assert.notEqual(result.exit_code, 0);
  assert.equal(searches, 1);
  assert.match(
    f.read("lifecycle-report.json").failure.message,
    /Jaeger v3 trace search failed: HTTP 500/,
  );
  assert(!f.requests.some((r) => r.url === "/api/admin/agents"));
});

for (const [name, mutate] of [
  ["name whitespace", (f) => (f.config.fixtureName = " lifecycle-fixture ")],
  ["bad origin", (f) => (f.config.gateway += "/bad")],
  ["missing scope", (f) => delete f.config.runtimeControllerScope],
  [
    "escaping workspace",
    (f) => (f.config.workspaceFile = "/workspace/../escape"),
  ],
  [
    "cached workspace",
    (f) => (f.config.workspaceFile = "/workspace/.cache/marker.txt"),
  ],
  [
    "ambiguous marker whitespace",
    (f) => (f.config.workspaceMarker = " marker "),
  ],
  [
    "missing credential",
    (f) =>
      writeFileSync(
        f.config.envFile,
        "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
      ),
  ],
])
  test(`lifecycle rejects ${name} before HTTP`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.dockerCalls(), []);
  });

test("unexpected publication warning preserves private raw evidence and prevents creation", async (t) => {
  const f = await fixture(t);
  f.publications[0].spans[0].warnings = ["unexpected warning"];
  const result = await f.run();
  assert.notEqual(result.exit_code, 0);
  assert.deepEqual(
    f.read(`publication-${f.publications[0].traceID}.json`),
    f.publications[0],
  );
  assert(!f.requests.some((r) => r.url === "/api/admin/agents"));
});

test("unexpected lifecycle error preserves the original failed Trace", async (t) => {
  const f = await fixture(t);
  const trace = f.lifecycles.create.trace;
  trace.spans[0].tags.push({ key: "error", type: "bool", value: true });
  const result = await f.run();
  assert.notEqual(result.exit_code, 0);
  assert.equal(
    f.read("lifecycle-report.json").failure.stage,
    "lifecycle_trace",
  );
  assert.deepEqual(f.read("lifecycle-create.json"), trace);
});

for (const name of [
  "lifecycle-progress.json",
  "temporary-agent.json",
  "lifecycle-report.json",
  ...lifecycleKinds.map((k) => `lifecycle-${k}.json`),
  "publication-" + "a".repeat(32) + ".json",
])
  test(`lifecycle rejects cached ${name} output before HTTP`, async (t) => {
    const f = await fixture(t);
    mkdirSync(f.config.output);
    mkdirSync(join(f.root, ".cache"));
    symlinkSync(
      join(f.root, ".cache/missing.json"),
      join(f.config.output, name),
    );
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.requests.length, 0);
    assert(!existsSync(join(f.root, ".cache/missing.json")));
  });

test("created retained identity never becomes a cleanup target", async (t) => {
  const f = await fixture(t);
  f.createdId = f.retainedId;
  const result = await f.run();
  assert.notEqual(result.exit_code, 0);
  assert(
    !f.requests.some(
      (r) => r.url === `/api/admin/agents/${f.retainedId}/delete`,
    ),
  );
});

for (const [name, mutate] of [
  [
    "foreign runtime",
    (f) => (f.inspection.Config.Labels["io.antnest.agent-id"] = "foreign"),
  ],
  [
    "foreign scope",
    (f) =>
      (f.inspection.Config.Labels["io.antnest.runtime-controller-scope"] =
        "foreign"),
  ],
  ["readonly workspace", (f) => (f.inspection.Mounts[0].RW = false)],
  [
    "tmpfs shadow",
    (f) => (f.inspection.HostConfig = { Tmpfs: { "/workspace/hidden": "" } }),
  ],
  ["foreign volume", (f) => (f.inspection.Mounts[0].Name = "foreign")],
])
  test(`lifecycle rejects ${name} before marker write and cleans the temporary Agent`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(
      f.read("lifecycle-report.json").cleanup,
      "deleted_after_failure",
    );
    assert(!f.dockerCalls().some((args) => args[0] === "exec"));
    assert(
      f.requests.some(
        (r) => r.url === `/api/admin/agents/${f.temporaryId}/delete`,
      ),
    );
  });

for (const [name, mutate] of [
  ["duplicate publication", (f) => (f.publications[1] = f.publications[0])],
  [
    "wrong publication organization",
    (f) => (f.publications[0] = publicationTrace(1, "foreign")),
  ],
  [
    "duplicate lifecycle trace",
    (f) =>
      (f.lifecycles.disable.expected.traceID =
        f.lifecycles.create.expected.traceID),
  ],
  [
    "duplicate lifecycle request",
    (f) =>
      (f.lifecycles.disable.expected.requestId =
        f.lifecycles.create.expected.requestId),
  ],
  [
    "wrong Agent response",
    (f) => (f.agentResponse = (row) => ({ ...row, agent_id: "foreign" })),
  ],
  [
    "changed retained configuration",
    (f) => {
      const old = f.transition;
      f.transition = (kind) => {
        old(kind);
        if (kind === "delete")
          f.retained.configuration.model.model_id = "changed";
      };
    },
  ],
  ["workspace loss", (f) => (f.marker = "changed")],
  ["resource residue", (f) => (f.residue = "unexpected")],
])
  test(`lifecycle rejects ${name}`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    const result = await f.run();
    assert.notEqual(result.exit_code, 0);
    assert.equal(f.read("lifecycle-report.json").status, "failed");
  });
