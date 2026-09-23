import fs from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { traceTopology } from "../../e2e/observability/trace-tree.mjs";
import { hasError } from "../../e2e/acp-plan/requests.mjs";
import { durablePath, readConfiguration } from "../storage.mjs";
const { values } = parseArgs({ options: { config: { type: "string" } } });
const config = readConfiguration(values.config);
const output = durablePath(join(config.output, "trace-audit.json"));
const results = [];
assert(
  Array.isArray(config.profiles) && config.profiles.length,
  "profiles must be a nonempty array",
);
const profiles = config.profiles.map((entry) => {
  assert(
    entry && ["interrupted", "foundation"].includes(entry.profile),
    "unknown audit profile",
  );
  assert(
    Number.isInteger(entry.expectedTraceCount) && entry.expectedTraceCount > 0,
    "expectedTraceCount must be positive",
  );
  assert(
    typeof entry.projectPattern === "string" && entry.projectPattern.length,
    "projectPattern is required",
  );
  if (entry.profile === "interrupted") {
    assert(
      Number.isInteger(entry.expectedTargetTemplateRevision) &&
        entry.expectedTargetTemplateRevision > 0,
      "expectedTargetTemplateRevision must be positive",
    );
    assert(
      Number.isInteger(entry.expectedErrors) && entry.expectedErrors >= 0,
      "expectedErrors must be nonnegative",
    );
  }
  return {
    ...entry,
    log: durablePath(entry.log),
    evidenceRoot: durablePath(entry.evidenceRoot),
    pattern: new RegExp(entry.projectPattern),
  };
});
for (const entry of profiles) {
  const { profile, expectedTraceCount: count } = entry;
  const log = durablePath(entry.log);
  const evidenceRoot = durablePath(entry.evidenceRoot);
  const project = fs.readFileSync(log, "utf8").match(entry.pattern)?.[1];
  assert(
    typeof project === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project),
    "projectPattern must capture one project name",
  );
  const p = durablePath(join(evidenceRoot, project));
  const b = JSON.parse(fs.readFileSync(durablePath(`${p}/business.json`)));
  const checks = [...b.traces, ...(b.active_run_rebuild?.run_traces ?? [])];
  assert.equal(checks.length, count);
  let errors = 0,
    runtimeErrors = 0;
  for (const check of checks) {
    assert.notEqual(check.topology, "failed");
    const t = JSON.parse(
      fs.readFileSync(durablePath(`${p}/traces/${check.trace_id}.json`)),
    );
    const tree = traceTopology(t);
    const e = t.spans.filter(hasError);
    errors += e.length;
    runtimeErrors += e.filter(
      (s) => tree.service(s) === "runtime-controller",
    ).length;
  }
  assert.equal(runtimeErrors, 0);
  results.push({
    project,
    profile,
    topologies: checks.length,
    strict_failed: checks.filter((x) => x.strict_trace === "failed").length,
    error_spans: errors,
    runtime_controller_errors: runtimeErrors,
    missing_parent_edges: 0,
  });
  if (profile === "interrupted") {
    assert.equal(
      b.target_template_revision,
      entry.expectedTargetTemplateRevision,
    );
    const c = JSON.parse(
      fs.readFileSync(durablePath(`${p}/checkpoint.private.json`)),
    );
    assert.deepEqual(c.checkpoint.rc, c.recovered.rc);
    assert.deepEqual(
      c.receipts.records.map((r) => r.delivery),
      ["caller_disconnected", "delivered"],
    );
    assert.equal(errors, entry.expectedErrors);
  }
}
fs.writeFileSync(durablePath(output), JSON.stringify(results, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(results));
