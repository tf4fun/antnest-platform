import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, describe, expect, it, vi } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";

import { LearningReviewRunner } from "../../../../services/agent-acp-service/src/application/learning-review-runner.js";
import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { InstrumentedModel } from "../../../../services/agent-acp-service/src/telemetry/instrumented-ports.js";
import { LearningTelemetry } from "../../../../services/agent-acp-service/src/telemetry/learning.js";
import { ServiceTelemetry } from "../../../../services/agent-acp-service/src/telemetry/telemetry.js";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { snapshot } from "../../../../services/agent-acp-service/test/support/fixtures.js";
import type { LearningTaskClaim } from "../../../../services/agent-acp-service/src/domain/learning-scan.js";
import type { ModelPort } from "../../../../services/agent-acp-service/src/ports/model.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
provider.register({ propagator: new core.W3CTraceContextPropagator() });
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("learning review HTTP Trace", () => {
  it.each([1, 2] as const)(
    "identifies validation failure and repair through the production adapter (prompt %i)",
    async (version) => {
      exporter.reset();
      configureBoundaries({ captureRpcContent: false, disabled: false });
      const lines: string[] = [];
      const telemetry = new ServiceTelemetry("learning-http-test", (line) =>
        lines.push(line),
      );
      const requests: { traceparent?: string; maxTokens: number }[] = [];
      const evidenceId = `evidence_${"a".repeat(32)}`;
      const expected =
        version === 1
          ? { decision: "skip", reason: "private-reason" }
          : {
              decision: "propose",
              name: "inspect-files",
              description: "Inspect files",
              instructions: "private-rule",
              rules: [{ text: "Inspect files", evidenceIds: [evidenceId] }],
            };
      const raw =
        version === 1
          ? [
              '{"decision":"propose","name":"inspect-files","description":{},"instructions":"private-rule","rules":[]}',
              '{"decision":"skip","reason":"private-reason"}',
            ]
          : [
              '{"decision":"skip","reason":"private-reason"}',
              JSON.stringify(expected),
            ];
      const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            max_tokens: number;
          };
          const index = requests.length;
          requests.push({
            traceparent: String(request.headers.traceparent),
            maxTokens: body.max_tokens,
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content: raw[index] },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 30 },
            }),
          );
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing fixture address");
        const source = snapshot();
        source.executionSpec.model.baseUrl = `http://127.0.0.1:${address.port}`;
        const transport = new InstrumentedModel(
          new OpenAICompatibleModel(),
          telemetry,
        );
        const claim: LearningTaskClaim = {
          taskId: "learn-http-1",
          claimId: "claim-1",
          generation: 1,
          organizationId: source.organizationId,
          agentId: "agent-1",
          ownerId: "owner-1",
          sourceRunId: "run-http-1",
          frozenPolicy: {},
          reviewPromptVersion: version,
        };
        let nextCall = 0;
        const ledger = {
          settle: vi.fn(() => Promise.resolve()),
          settleReview: vi.fn(() => Promise.resolve()),
          readReview: vi.fn(() => Promise.resolve(null)),
          markUnknown: vi.fn(() => Promise.resolve()),
        };
        const runner = new LearningReviewRunner(
          {
            readAndRecord: () =>
              Promise.resolve({
                sourceRunId: claim.sourceRunId,
                items:
                  version === 1
                    ? []
                    : [
                        {
                          evidenceId,
                          sourceId: "private-user",
                          kind: "authenticated_user" as const,
                          scope: "user_prompt" as const,
                          text: "Inspect files",
                        },
                      ],
                truncated: false,
              }),
          },
          { readSnapshot: () => Promise.resolve(source) },
          { assertCurrent: () => undefined },
          {
            reserve: () =>
              Promise.resolve({
                callIndex: ++nextCall,
                state: "reserved",
                dispatch: true,
              }),
            watch: () => ({
              signal: new AbortController().signal,
              stop: () => Promise.resolve(),
            }),
          },
          ledger,
          {
            acquire: () => ({
              signal: new AbortController().signal,
              release: () => undefined,
              complete: (request: Parameters<ModelPort["complete"]>[0]) =>
                transport.complete({
                  ...request,
                  credential: "fixture-secret",
                }),
            }),
          },
          new LearningTelemetry(telemetry),
        );
        await expect(
          runner.execute({ claim, signal: new AbortController().signal }),
        ).resolves.toEqual(expected);
        expect(requests.map((request) => request.maxTokens)).toEqual([
          3000, 1000,
        ]);
        expect(
          requests.every((request) =>
            /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u.test(
              request.traceparent ?? "",
            ),
          ),
        ).toBe(true);
        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(
          spans.find((span) => span.name === "skill_learning.review")
            ?.attributes,
        ).toMatchObject({
          "antnest.learning.evidence.items": version === 1 ? 0 : 1,
          "antnest.learning.evidence.truncated": false,
          "antnest.learning.debug": version === 2,
        });
        expect(
          new Set(spans.map((span) => span.spanContext().traceId)).size,
        ).toBe(1);
        const validation = spans.filter(
          (span) => span.name === "skill_learning.review.validate",
        );
        expect(validation).toHaveLength(2);
        expect(validation[0]?.attributes).toMatchObject(
          version === 1
            ? {
                "antnest.learning.validation.reason": "invalid_schema",
                "antnest.learning.validation.paths": "description",
              }
            : { "antnest.learning.validation.reason": "debug_skip" },
        );
        expect(
          validation[1]?.attributes["antnest.learning.validation.result"],
        ).toBe("accepted");
        expect(
          spans
            .filter((span) => span.name === "model.complete")
            .every(
              (span) => span.attributes["model.purpose"] === "skill_learning",
            ),
        ).toBe(true);
        expect(ledger.settle).toHaveBeenCalledOnce();
        expect(ledger.settleReview).toHaveBeenCalledOnce();
        expect(
          JSON.stringify({
            lines,
            spans: spans.map((span) => ({
              attributes: span.attributes,
              events: span.events,
            })),
          }),
        ).not.toMatch(/private-|fixture-secret/u);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    },
  );
});
