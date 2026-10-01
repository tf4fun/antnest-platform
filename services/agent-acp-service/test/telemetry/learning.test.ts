import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { generateKeyPairSync } from "node:crypto";
import { node, tracing } from "@opentelemetry/sdk-node";

import { configureBoundaries } from "../../src/telemetry/diagnostics.js";
import {
  LearningTelemetry,
  InstrumentedLearningTaskProcessor,
} from "../../src/telemetry/learning.js";
import { ServiceTelemetry } from "../../src/telemetry/telemetry.js";
import { parseLearningReviewProposal } from "../../src/domain/learning-review-proposal.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";
import type { ModelResult } from "../../src/ports/model.js";
import { RuntimeSkillMaintenanceClient } from "../../src/adapters/runtime-skill-maintenance-client.js";
import { RuntimeSkillMaintenanceSigner } from "../../src/adapters/runtime-skill-maintenance-signer.js";

const claim: LearningTaskClaim = {
  taskId: "learn-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  sourceRunId: "run-1",
  frozenPolicy: {},
};
const evidence = { sourceRunId: "run-1", items: [], truncated: false };
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const lines: string[] = [];
const telemetry = new ServiceTelemetry("learning-test", (line) => lines.push(line));
const diagnostics = new LearningTelemetry(telemetry);
const response = (text: string): Extract<ModelResult, { kind: "message" }> => ({
  kind: "message",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 20 },
});
function exportedDiagnostics() {
  return JSON.stringify({
    spans: exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    })),
    lines,
  });
}

beforeAll(() => {
  configureBoundaries({ disabled: false, captureRpcContent: false });
  provider.register();
});
beforeEach(() => {
  exporter.reset();
  lines.length = 0;
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("learning Trace", () => {
  it("identifies a debug skip and the frozen debug prompt without exporting response text", async () => {
    const debugClaim = { ...claim, reviewPromptVersion: 2 as const };
    const raw = '{"decision":"skip","reason":"private-debug-reason"}';
    const result = response(raw);
    await expect(
      diagnostics.validate(debugClaim, 1, result, () =>
        parseLearningReviewProposal(raw, evidence, 2),
      ),
    ).rejects.toThrow("Debug learning requires a proposal");
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes).toMatchObject({
      "antnest.learning.debug": true,
      "antnest.learning.review_prompt_version": 2,
      "antnest.learning.validation.reason": "debug_skip",
    });
    expect(exportedDiagnostics()).not.toContain("private-debug-reason");
  });

  it("propagates the task Trace to Runtime maintenance without exporting its authorization", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let authorization = "";
    let traceparent = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        authorization = headers.get("authorization") ?? "";
        traceparent = headers.get("traceparent") ?? "";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              request_id: "cancel-1",
              action: "cancel",
              execution_id: "execution-1",
              outcome: "cancelled",
              observed_digest: null,
            }),
          ),
        );
      }),
    );
    try {
      const client = new RuntimeSkillMaintenanceClient(
        new RuntimeSkillMaintenanceSigner("test-key", privateKey),
        {
          reserve: () => Promise.resolve({ dispatch: true, state: "pending" }),
          settle: () => Promise.resolve(),
          reject: () => Promise.resolve(),
          markUnknown: () => Promise.resolve(),
        },
      );
      await telemetry.span("skill_learning.task", {}, () =>
        client.cancel({
          claim,
          binding: { mcpEndpoint: "http://runtime.test:8093/mcp", executionId: "execution-1" },
          requestId: "cancel-1",
          signal: new AbortController().signal,
        }),
      );
      const task = exporter.getFinishedSpans().find((s) => s.name === "skill_learning.task")!;
      const http = exporter.getFinishedSpans().find((s) => s.name === "HTTP POST antnest-runtime")!;
      expect(http).toBeDefined();
      expect(http.parentSpanContext?.spanId).toBe(task.spanContext().spanId);
      expect(traceparent).toBe(`00-${task.spanContext().traceId}-${http.spanContext().spanId}-01`);
      expect(authorization.length).toBeGreaterThan(0);
      expect(exportedDiagnostics()).not.toContain(authorization);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records evidence coverage and truncation without recording evidence contents", async () => {
    await diagnostics.review(claim, () => {
      diagnostics.evidence(claim, {
        sourceRunId: claim.sourceRunId,
        truncated: true,
        items: [
          {
            evidenceId: "private-id",
            sourceId: "private-source",
            kind: "authenticated_user",
            scope: "user_prompt",
            text: "private-user",
          },
          {
            evidenceId: "private-id-2",
            sourceId: "private-source-2",
            kind: "observed_execution",
            scope: "tool_attempt",
            text: "private-execution",
          },
          {
            evidenceId: "private-id-3",
            sourceId: "private-source-3",
            kind: "untrusted_material",
            scope: "tool_output",
            text: "private-output",
          },
        ],
      });
      return Promise.resolve(null);
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === "skill_learning.review")!;
    expect(span.attributes).toMatchObject({
      "antnest.learning.evidence.truncated": true,
      "antnest.learning.evidence.items": 3,
      "antnest.learning.evidence.user_items": 1,
      "antnest.learning.evidence.execution_items": 1,
      "antnest.learning.evidence.untrusted_items": 1,
      "antnest.learning.evidence.content_bytes": 43,
    });
    expect(exportedDiagnostics()).not.toContain("private-");
  });

  it("joins model and validation spans to the claimed task and records a failed review", async () => {
    const result = response("private-invalid-json");
    const processor = new InstrumentedLearningTaskProcessor(
      {
        process: async () => {
          await diagnostics.review(claim, async () => {
            await diagnostics.modelCall(claim, 1, "request-1", async () =>
              telemetry.span("model.complete", { "model.purpose": "skill_learning" }, () =>
                Promise.resolve(result),
              ),
            );
            try {
              await diagnostics.validate(claim, 1, result, () =>
                parseLearningReviewProposal("private-invalid-json", evidence),
              );
            } catch {
              /* bounded repair owns rejection */
            }
            return null;
          });
          return { kind: "paused", reason: "review_inconclusive" };
        },
      },
      telemetry,
    );
    await processor.process(claim, new AbortController().signal);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const task = spans.find((s) => s.name === "skill_learning.task")!;
    const review = spans.find((s) => s.name === "skill_learning.review")!;
    const call = spans.find((s) => s.name === "skill_learning.review.call")!;
    const model = spans.find((s) => s.name === "model.complete")!;
    const validation = spans.find((s) => s.name === "skill_learning.review.validate")!;
    expect(review.parentSpanContext?.spanId).toBe(task.spanContext().spanId);
    expect(call.parentSpanContext?.spanId).toBe(review.spanContext().spanId);
    expect(model.parentSpanContext?.spanId).toBe(call.spanContext().spanId);
    expect(validation.parentSpanContext?.spanId).toBe(review.spanContext().spanId);
    expect(task.attributes).toMatchObject({
      "antnest.learning.task.id": "learn-1",
      "antnest.learning.source_run.id": "run-1",
      "antnest.agent.id": "agent-1",
      "antnest.learning.outcome": "paused",
      "antnest.learning.pause_reason": "review_inconclusive",
    });
    expect(task.status.code).toBe(SpanStatusCode.ERROR);
    expect(validation.attributes["antnest.learning.validation.reason"]).toBe("invalid_json");
    expect(call.attributes["antnest.model.stop_reason"]).toBe("end_turn");
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({
        event: "skill_learning_review_rejected",
        reason: "invalid_json",
        trace_id: task.spanContext().traceId,
      }),
    );
    expect(exportedDiagnostics()).not.toContain("private-invalid-json");
  });

  it("exports only bounded schema paths and codes, including unknown-key failures", async () => {
    const raw = '{"decision":"skip","reason":"private-content","private-key":"private-value"}';
    const result = response(raw);
    await expect(
      diagnostics.validate(claim, 1, result, () => parseLearningReviewProposal(raw, evidence)),
    ).rejects.toThrow();
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "skill_learning.review.validate")!;
    expect(span.attributes["antnest.learning.validation.reason"]).toBe("invalid_schema");
    expect(span.attributes["antnest.learning.validation.codes"]).toContain("unrecognized_keys");
    expect(exportedDiagnostics()).not.toContain("private-");
  });

  it("identifies a fenced JSON response without exporting its body", async () => {
    const raw = '```json\n{"decision":"skip","reason":"private-content"}\n```';
    await expect(
      diagnostics.validate(claim, 1, response(raw), () =>
        parseLearningReviewProposal(raw, evidence),
      ),
    ).rejects.toThrow();
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "skill_learning.review.validate")!;
    expect(span.attributes["antnest.learning.validation.reason"]).toBe("invalid_json");
    expect(span.attributes["antnest.model.markdown_fence"]).toBe(true);
    expect(exportedDiagnostics()).not.toContain("private-content");
  });

  it("distinguishes output truncation from invalid JSON without exporting thought content", async () => {
    const result: ModelResult = {
      ...response("private-answer"),
      stopReason: "max_tokens",
      thought: [{ type: "text", text: "private-thought" }],
    };
    await expect(
      diagnostics.validate(claim, 1, result, () => {
        throw new Error("private-error");
      }),
    ).rejects.toThrow();
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "skill_learning.review.validate")!;
    expect(span.attributes["antnest.learning.validation.reason"]).toBe("output_limit");
    expect(exportedDiagnostics()).not.toContain("private-");
  });

  it("records an intentional skip as a successful review and keeps metrics free of identities", async () => {
    const count = vi.spyOn(telemetry, "count");
    const raw = '{"decision":"skip","reason":"No reusable procedure"}';
    const processor = new InstrumentedLearningTaskProcessor(
      {
        process: async () => {
          await diagnostics.review(claim, () =>
            diagnostics.validate(claim, 1, response(raw), () =>
              parseLearningReviewProposal(raw, evidence),
            ),
          );
          return { kind: "skipped" };
        },
      },
      telemetry,
    );
    await expect(processor.process(claim, new AbortController().signal)).resolves.toEqual({
      kind: "skipped",
    });
    expect(exporter.getFinishedSpans().every((s) => s.status.code !== SpanStatusCode.ERROR)).toBe(
      true,
    );
    expect(lines).toEqual([]);
    expect(count).toHaveBeenCalledWith("antnest.acp.skill_learning.tasks", {
      result: "skipped",
      reason: undefined,
    });
  });

  it("preserves cancellation outcomes and traces the application phase beneath the task", async () => {
    const processor = new InstrumentedLearningTaskProcessor(
      {
        process: async () => {
          await telemetry.span("skill_learning.apply", {}, () => Promise.resolve(undefined));
          return { kind: "paused", reason: "foreground_preempted" };
        },
      },
      telemetry,
    );
    await processor.process(claim, new AbortController().signal);
    const spans = exporter.getFinishedSpans();
    const task = spans.find((s) => s.name === "skill_learning.task")!;
    expect(spans.find((s) => s.name === "skill_learning.apply")?.parentSpanContext?.spanId).toBe(
      task.spanContext().spanId,
    );
    expect(task.status.code).not.toBe(SpanStatusCode.ERROR);
  });
});
