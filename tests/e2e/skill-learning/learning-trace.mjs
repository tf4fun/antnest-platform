import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { assertCaptureDisabled, tag } from "../observability/trace-tree.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";

/** ACP task coverage; this does not assert a shared notice/Bridge/UI Trace. */
export async function collectLearningTraces(
  config,
  agentId,
  changeIds,
  signal,
  { fileSuffix = "" } = {},
) {
  assert(/^(?:-[a-z0-9-]+)?$/u.test(fileSuffix));
  const traces = await until(
    async () => {
      const found = await searchJaegerTraces(
        config.jaeger,
        new URLSearchParams({
          service: "agent-acp-service",
          operation: "skill_learning.task",
          tags: JSON.stringify({ "antnest.agent.id": agentId }),
          lookback: "30m",
          limit: "100",
        }),
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      const applied = found.filter((trace) =>
        trace.spans.some(
          (span) =>
            span.operationName === "skill_learning.task" &&
            tag(span, "antnest.learning.outcome") === "applied",
        ),
      );
      return applied.length === changeIds.length ? applied : null;
    },
    "exported learning task Traces",
    signal,
    45_000,
  );
  const evidenceDir = fileURLToPath(
    new URL("../../../artifacts/verification/skill-learning/", import.meta.url),
  );
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    `${evidenceDir}${config.project}${fileSuffix}.learning-trace.json`,
    JSON.stringify(traces),
    { mode: 0o600, flag: "wx" },
  );
  const summaries = [];
  for (const trace of traces) {
    assertCaptureDisabled(trace);
    const ids = new Set(trace.spans.map((span) => span.spanID));
    for (const span of trace.spans)
      for (const parent of span.references.filter(
        (ref) => ref.refType === "CHILD_OF",
      )) {
        assert.equal(parent.traceID, trace.traceID);
        assert(
          ids.has(parent.spanID),
          `missing parent of ${span.operationName}`,
        );
      }
    const one = (name) => {
      const spans = trace.spans.filter((span) => span.operationName === name);
      assert.equal(spans.length, 1, `expected one ${name} span`);
      return spans[0];
    };
    const task = one("skill_learning.task");
    const review = one("skill_learning.review");
    const calls = trace.spans.filter(
      (span) => span.operationName === "skill_learning.review.call",
    );
    const models = trace.spans.filter(
      (span) => span.operationName === "model.complete",
    );
    const validations = trace.spans.filter(
      (span) => span.operationName === "skill_learning.review.validate",
    );
    assert(
      calls.length >= 1 && calls.length <= 2,
      "review must respect its two-call ceiling",
    );
    assert.equal(models.length, calls.length);
    assert.equal(validations.length, calls.length);
    const apply = one("skill_learning.apply");
    const child = (span, parent) =>
      assert(
        span.references.some(
          (ref) => ref.refType === "CHILD_OF" && ref.spanID === parent.spanID,
        ),
      );
    child(review, task);
    for (const call of calls) {
      child(call, review);
      const model = models.find((span) =>
        span.references.some(
          (ref) => ref.refType === "CHILD_OF" && ref.spanID === call.spanID,
        ),
      );
      assert(model, "each review call must own its model span");
      child(model, call);
      assert.equal(tag(model, "model.purpose"), "skill_learning");
    }
    for (const validation of validations) child(validation, review);
    child(apply, task);
    const maintenance = trace.spans.filter(
      (span) =>
        tag(span, "http.route") === "/internal/skill-maintenance/{action}",
    );
    assert(
      maintenance.length >= 3,
      "Runtime prepare/check/commit must join the task Trace",
    );
    for (const server of maintenance) {
      const parentId = server.references.find(
        (ref) => ref.refType === "CHILD_OF",
      )?.spanID;
      const client = trace.spans.find((span) => span.spanID === parentId);
      assert(
        client,
        "Runtime maintenance server must have an ACP HTTP client parent",
      );
      assert.equal(tag(client, "peer.service"), "antnest-runtime");
      child(client, apply);
      // Runtime tracing and Node export this scalar with different Jaeger types.
      assert.equal(String(tag(server, "http.response.status_code")), "200");
    }
    assert.equal(
      validations.filter(
        (span) =>
          tag(span, "antnest.learning.validation.result") === "accepted",
      ).length,
      1,
    );
    assert.equal(tag(review, "antnest.learning.review.decision"), "propose");
    assert.equal(tag(apply, "antnest.learning.apply.outcome"), "applied");
    assert.equal(
      typeof tag(review, "antnest.learning.evidence.truncated"),
      "boolean",
    );
    assert(tag(review, "antnest.learning.evidence.items") > 0);
    assert(tag(task, "antnest.learning.source_run.id"));
    summaries.push({
      traceId: trace.traceID,
      taskId: tag(task, "antnest.learning.task.id"),
      sourceRunId: tag(task, "antnest.learning.source_run.id"),
      changeId: tag(task, "antnest.learning.change.id"),
      evidenceTruncated: tag(review, "antnest.learning.evidence.truncated"),
      spanCount: trace.spans.length,
      debug: tag(task, "antnest.learning.debug"),
      modelCalls: calls.length,
      rejectionReasons: validations
        .map((span) => tag(span, "antnest.learning.validation.reason"))
        .filter(Boolean),
    });
  }
  assert.deepEqual(
    summaries.map((item) => item.changeId).sort(),
    [...changeIds].sort(),
  );
  return {
    coverage: [
      "task",
      "review",
      "model",
      "validation",
      "apply",
      "runtime_http",
    ],
    summaries,
    traces,
  };
}
