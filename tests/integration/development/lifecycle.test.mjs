import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { lifecycleCliFixture as fixture } from "../../support/fixtures/development-lifecycle-cli.mjs";
import {
  lifecycleKinds,
  publicationTrace,
} from "../../support/fixtures/development-lifecycle.mjs";

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
      3,
    );
  assert.equal(
    f.requests.filter((r) => r.url === `/api/admin/agents/${f.retainedId}`)
      .length,
    2,
  );
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
