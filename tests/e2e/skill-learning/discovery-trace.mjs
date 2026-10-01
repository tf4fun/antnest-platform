import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { assertCaptureDisabled, tag } from "../observability/trace-tree.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

export async function collectDiscoveryTrace(config, selection, signal) {
  const traces = await until(
    async () => {
      const found = await searchJaegerTraces(
        config.jaeger,
        new URLSearchParams({
          service: "agent-acp-service",
          operation: "skill.discovery.load",
          tags: JSON.stringify({ "skill.source.agent_id": selection.agent_id }),
          lookback: "30m",
          limit: "50",
        }),
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
      );
      return found.length ? found : null;
    },
    "exported Skill discovery Trace",
    signal,
    45000,
  );
  assert.equal(traces.length, 1);
  const trace = traces[0];
  const load = trace.spans.find(
    (span) => span.operationName === "skill.discovery.load",
  );
  const find = trace.spans.find(
    (span) => span.operationName === "skill.discovery.search",
  );
  assert(load && find);
  assert.equal(tag(load, "skill.content_digest"), selection.content_digest);
  assert.equal(tag(load, "skill.source.sequence"), selection.sequence);
  assert.equal(tag(load, "skill.source.kind"), "agent");
  assert.equal(tag(load, "run.id"), tag(find, "run.id"));
  for (const span of [load, find]) {
    const parents = span.references.filter((ref) => ref.refType === "CHILD_OF");
    assert.equal(parents.length, 1);
    const parent = trace.spans.find(
      (node) => node.spanID === parents[0].spanID,
    );
    assert.equal(parent?.operationName, "mcp.tools.call");
    assert.equal(tag(parent, "mcp.source_id"), "skill_registry");
  }
  assertCaptureDisabled(trace);
  assert(
    !JSON.stringify(trace).includes("For the fixture task, inspect the target"),
  );
  const directory = new URL(
    "../../../artifacts/verification/skill-discovery-d3-20261001/",
    import.meta.url,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    new URL(`${config.project}-discovery-trace.json`, directory),
    JSON.stringify(trace),
    { flag: "wx", mode: 0o600 },
  );
  return {
    trace_id: trace.traceID,
    run_id: tag(load, "run.id"),
    source_agent_id: selection.agent_id,
    content_digest: selection.content_digest,
    operations: [find.operationName, load.operationName],
  };
}
