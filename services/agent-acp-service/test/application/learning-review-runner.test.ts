import { describe, expect, it, vi } from "vitest";

import { LearningReviewRunner } from "../../src/application/learning-review-runner.js";
import {
  ForegroundLearningPreempted,
  LearningForegroundGate,
} from "../../src/application/learning-foreground-gate.js";
import { LearningMaintenanceGuard } from "../../src/application/learning-maintenance-guard.js";
import { LearningPolicyChangedError } from "../../src/domain/learning-maintenance-errors.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";
import type { ModelCallBudget } from "../../src/domain/learning-budget.js";
import type { LearningEvidence } from "../../src/domain/learning-evidence.js";
import type { RunExecutionSnapshot } from "../../src/domain/types.js";
import type { ModelPort } from "../../src/ports/model.js";

const id = `evidence_${"a".repeat(32)}`;
const claim: LearningTaskClaim = {
  taskId: "task-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  sourceRunId: "run-1",
  frozenPolicy: {},
};
const evidence: LearningEvidence = {
  sourceRunId: "run-1",
  truncated: false,
  items: [
    {
      evidenceId: id,
      sourceId: "user-1",
      kind: "authenticated_user",
      scope: "user_prompt",
      text: "Use the checked sequence",
    },
  ],
};
const snapshot: RunExecutionSnapshot = {
  organizationId: "org-1",
  providerConnectionId: "connection-1",
  modelProfileId: "profile-1",
  configurationRevision: 1,
  accessRevision: "access-1",
  deadlineAt: new Date("2026-09-29T00:10:00Z"),
  agentSpecRevision: "spec-1",
  executionRevision: "execution-1",
  runtimeMcpSourceDigest: "a".repeat(64),
  agentExecutionSpecDigest: "b".repeat(64),
  runtime: { revision: "runtime-1", executionId: "execution-1", mcpEndpoint: "http://runtime/mcp" },
  executionSpec: {
    systemPrompt: "Unrelated foreground prompt",
    contextPolicyVersion: "context-v1",
    skillInstructions: [],
    model: {
      baseUrl: "https://model.example/v1",
      model: "test",
      contextWindow: 64000,
      maxOutputTokens: 4096,
      supportsImages: false,
    },
    maxModelRequests: 4,
  },
  clientMcpRevisionId: "mcp-1",
};
const proposal = {
  decision: "propose",
  name: "checked-sequence",
  description: "Checked sequence",
  instructions: "Use the checked sequence",
  rules: [{ text: "Use the checked sequence", evidenceIds: [id] }],
};

function harness(responses: Array<ReturnType<ModelPort["complete"]>>) {
  const model = { complete: vi.fn<ModelPort["complete"]>() };
  for (const response of responses) model.complete.mockImplementationOnce(() => response);
  let callIndex = 0;
  const admission = {
    reserve: vi.fn<
      (
        claim: LearningTaskClaim,
        requestId: string,
        budget: ModelCallBudget,
      ) => Promise<{
        callIndex: number;
        state: "reserved" | "settled" | "unknown";
        dispatch: boolean;
      }>
    >(() => Promise.resolve({ callIndex: ++callIndex, state: "reserved", dispatch: true })),
    watch: vi.fn(() => ({ signal: new AbortController().signal, stop: () => Promise.resolve() })),
  };
  const ledger = {
    settle: vi.fn(() => Promise.resolve()),
    settleReview: vi.fn(() => Promise.resolve()),
    readReview: vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)),
    markUnknown: vi.fn(() => Promise.resolve()),
  };
  const source = { readAndRecord: vi.fn(() => Promise.resolve(evidence)) };
  const snapshots = { readSnapshot: vi.fn(() => Promise.resolve(snapshot)) };
  const handle = { ...model, signal: new AbortController().signal, release: vi.fn() };
  const providers = { acquire: vi.fn(() => handle) };
  const authority = { assertCurrent: vi.fn() };
  return {
    model,
    admission,
    ledger,
    source,
    snapshots,
    handle,
    providers,
    authority,
    runner: new LearningReviewRunner(source, snapshots, authority, admission, ledger, providers),
  };
}

describe("learning review runner", () => {
  it("rejects debug skip, repairs once, and settles only an actual proposal", async () => {
    const response = (text: string) =>
      Promise.resolve({
        kind: "message" as const,
        stopReason: "end_turn" as const,
        content: [{ type: "text" as const, text }],
        usage: { inputTokens: 10, outputTokens: 20 },
      });
    const app = harness([
      response('{"decision":"skip","reason":"Already covered"}'),
      response(JSON.stringify(proposal)),
    ]);
    const debugClaim = { ...claim, reviewPromptVersion: 2 as const };
    expect(
      await app.runner.execute({ claim: debugClaim, signal: new AbortController().signal }),
    ).toEqual(proposal);
    expect(app.model.complete).toHaveBeenCalledTimes(2);
    const first = app.model.complete.mock.calls[0]![0];
    expect(first.messages[0]!.content[0]).toHaveProperty(
      "text",
      expect.stringContaining("development debug"),
    );
    expect(app.model.complete.mock.calls[1]![0].messages.at(-1)!.content[0]).toHaveProperty(
      "text",
      expect.stringContaining('"decision":"propose"'),
    );
    expect(app.ledger.settle).toHaveBeenCalledOnce();
    expect(app.ledger.settleReview).toHaveBeenCalledOnce();
    expect(app.ledger.settleReview.mock.calls[0]).toContainEqual(proposal);
  });

  it("does not treat two debug skips as learning success or exceed the repair budget", async () => {
    const response = () =>
      Promise.resolve({
        kind: "message" as const,
        stopReason: "end_turn" as const,
        content: [
          { type: "text" as const, text: '{"decision":"skip","reason":"No new experience"}' },
        ],
        usage: { inputTokens: 10, outputTokens: 20 },
      });
    const app = harness([response(), response()]);
    expect(
      await app.runner.execute({
        claim: { ...claim, reviewPromptVersion: 2 },
        signal: new AbortController().signal,
      }),
    ).toBeNull();
    expect(app.model.complete).toHaveBeenCalledTimes(2);
    expect(app.ledger.settle).toHaveBeenCalledTimes(2);
    expect(app.ledger.settleReview).not.toHaveBeenCalled();
  });

  it("calls the model without tools and atomically settles the parsed decision with usage", async () => {
    const app = harness([
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: JSON.stringify(proposal) }],
        stopReason: "end_turn",
        usage: { inputTokens: 150, outputTokens: 40 },
      }),
    ]);
    expect(
      await app.runner.execute({
        claim,
        signal: new AbortController().signal,
        existingSkills: [{ name: "checked-sequence", description: "Old procedure" }],
      }),
    ).toMatchObject(proposal);
    expect(app.model.complete).toHaveBeenCalledTimes(1);
    expect(app.providers.acquire).toHaveBeenCalledWith("org-1", "connection-1");
    expect(app.handle.release).toHaveBeenCalledTimes(1);
    expect(app.snapshots.readSnapshot).toHaveBeenCalledWith(claim);
    expect(app.authority.assertCurrent).toHaveBeenCalledWith(claim, snapshot);
    expect(app.model.complete.mock.calls[0]?.[0].tools).toEqual([]);
    expect(app.model.complete.mock.calls[0]?.[0].purpose).toBe("skill_learning");
    expect(app.model.complete.mock.calls[0]?.[0].messages[1]?.content[0]?.text).toContain(
      '"name":"checked-sequence"',
    );
    expect(app.model.complete.mock.calls[0]?.[0].snapshot.executionSpec.model.maxOutputTokens).toBe(
      3000,
    );
    expect(app.ledger.settleReview).toHaveBeenCalledWith(
      claim,
      expect.any(String),
      expect.objectContaining({ inputTokens: 150, outputTokens: 40 }),
      expect.objectContaining(proposal),
    );
  });

  it("settles malformed output and uses only one bounded repair call", async () => {
    const app = harness([
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "not JSON" }],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: '{"decision":"skip","reason":"No reusable rule"}' }],
        stopReason: "end_turn",
        usage: { inputTokens: 80, outputTokens: 12 },
      }),
    ]);
    expect(await app.runner.execute({ claim, signal: new AbortController().signal })).toEqual({
      decision: "skip",
      reason: "No reusable rule",
    });
    expect(app.model.complete).toHaveBeenCalledTimes(2);
    expect(app.model.complete.mock.calls[1]?.[0].snapshot.executionSpec.model.maxOutputTokens).toBe(
      1000,
    );
    expect(app.ledger.settle).toHaveBeenCalledTimes(1);
    expect(app.ledger.settleReview).toHaveBeenCalledTimes(1);
  });

  it("keeps a call unknown if provider usage is unavailable and never repairs it", async () => {
    const app = harness([
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "not JSON" }],
        stopReason: "end_turn",
        usage: {},
      }),
    ]);
    await expect(
      app.runner.execute({ claim, signal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(app.ledger.markUnknown).toHaveBeenCalledTimes(1);
    expect(app.ledger.settle).not.toHaveBeenCalled();
    expect(app.model.complete).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending model call when the learning policy changes", async () => {
    const app = harness([]);
    const policyChange = new AbortController();
    const stop = vi.fn(() => Promise.resolve());
    app.admission.watch.mockReturnValue({ signal: policyChange.signal, stop });
    app.model.complete.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(signal.reason instanceof Error ? signal.reason : new Error("Model aborted")),
            { once: true },
          );
        }),
    );
    const result = app.runner.execute({ claim, signal: new AbortController().signal });
    await vi.waitFor(() => expect(app.model.complete).toHaveBeenCalledOnce());
    policyChange.abort(new LearningPolicyChangedError());
    await expect(result).rejects.toBeInstanceOf(LearningPolicyChangedError);
    expect(stop).toHaveBeenCalledOnce();
    expect(app.ledger.markUnknown).toHaveBeenCalledOnce();
    expect(app.ledger.settleReview).not.toHaveBeenCalled();
    expect(app.handle.release).toHaveBeenCalledOnce();
  });

  it("returns an already settled review without dispatching the model again", async () => {
    const app = harness([]);
    app.admission.reserve.mockResolvedValue({
      callIndex: 1,
      state: "settled",
      dispatch: false,
    });
    app.ledger.readReview.mockResolvedValue(proposal);
    expect(await app.runner.execute({ claim, signal: new AbortController().signal })).toMatchObject(
      proposal,
    );
    expect(app.model.complete).not.toHaveBeenCalled();
    expect(app.ledger.settleReview).not.toHaveBeenCalled();
  });

  it("releases foreground admission during ignored inference cancellation without waiting for the provider", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ModelPort["complete"]>>>();
    const app = harness([pending.promise]);
    const gate = new LearningForegroundGate(() => false, 250);
    const intents = { unresolved: vi.fn(() => Promise.resolve([])) };
    const guard = new LearningMaintenanceGuard(gate, intents);
    const result = guard
      .run(claim, new AbortController().signal, (signal) => app.runner.execute({ claim, signal }))
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(app.model.complete).toHaveBeenCalledOnce());
      await expect(
        gate.preempt(
          { organizationId: claim.organizationId, agentId: claim.agentId },
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined();
      expect(await result).toBeInstanceOf(ForegroundLearningPreempted);
      expect(intents.unresolved).toHaveBeenCalledWith(claim);
      expect(app.ledger.markUnknown).toHaveBeenCalledOnce();
      expect(app.ledger.settleReview).not.toHaveBeenCalled();
    } finally {
      pending.reject(new Error("Provider eventually stopped"));
      await result;
    }
  });

  it.each(["response", "rejection"])(
    "stops a tool-free review promptly when cancellation is ignored and discards its late %s",
    async (late) => {
      const pending = Promise.withResolvers<Awaited<ReturnType<ModelPort["complete"]>>>();
      const app = harness([pending.promise]);
      const controller = new AbortController();
      const cancelled = new Error("New foreground turn");
      const stop = vi.fn(() => Promise.resolve());
      app.admission.watch.mockReturnValue({ signal: new AbortController().signal, stop });
      const result = app.runner.execute({ claim, signal: controller.signal });
      const settled = result.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(app.model.complete).toHaveBeenCalledOnce());
        controller.abort(cancelled);
        await vi.waitFor(() => expect(app.ledger.markUnknown).toHaveBeenCalledOnce(), {
          timeout: 250,
          interval: 5,
        });
        expect(await settled).toBe(cancelled);
        expect(stop).toHaveBeenCalledOnce();
        expect(app.handle.release).toHaveBeenCalledOnce();
        expect(app.ledger.settleReview).not.toHaveBeenCalled();
        expect(app.ledger.settle).not.toHaveBeenCalled();
      } finally {
        if (late === "response")
          pending.resolve({
            kind: "message",
            content: [{ type: "text", text: JSON.stringify(proposal) }],
            stopReason: "end_turn",
            usage: { inputTokens: 150, outputTokens: 40 },
          });
        else pending.reject(new Error("Late provider failure"));
        await settled;
      }
      await Promise.resolve();
      expect(app.ledger.settleReview).not.toHaveBeenCalled();
      expect(app.model.complete).toHaveBeenCalledOnce();
    },
  );

  it("does not read evidence or reserve a call when the source snapshot is unavailable", async () => {
    const app = harness([]);
    app.snapshots.readSnapshot.mockRejectedValue(new Error("Source snapshot unavailable"));
    await expect(
      app.runner.execute({ claim, signal: new AbortController().signal }),
    ).rejects.toThrow("Source snapshot unavailable");
    expect(app.source.readAndRecord).not.toHaveBeenCalled();
    expect(app.admission.reserve).not.toHaveBeenCalled();
    expect(app.providers.acquire).not.toHaveBeenCalled();
  });

  it("does not reserve a call when current Provider credentials are unavailable", async () => {
    const app = harness([]);
    app.providers.acquire.mockImplementation(() => {
      throw new Error("Provider unavailable");
    });
    await expect(
      app.runner.execute({ claim, signal: new AbortController().signal }),
    ).rejects.toThrow("Provider unavailable");
    expect(app.admission.reserve).not.toHaveBeenCalled();
  });

  it("rechecks model authority before a format repair and does not reserve a second call after revocation", async () => {
    const app = harness([
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "invalid JSON" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 3 },
      }),
    ]);
    app.authority.assertCurrent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("Model authorization revoked");
      });
    await expect(
      app.runner.execute({ claim, signal: new AbortController().signal }),
    ).rejects.toThrow("Model authorization revoked");
    expect(app.admission.reserve).toHaveBeenCalledTimes(1);
    expect(app.model.complete).toHaveBeenCalledTimes(1);
    expect(app.handle.release).toHaveBeenCalledTimes(1);
  });

  it("settles known usage but does not persist a proposal if model authority changes during dispatch", async () => {
    const app = harness([
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: JSON.stringify(proposal) }],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 9 },
      }),
    ]);
    app.authority.assertCurrent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("Model authorization revoked");
      });
    await expect(
      app.runner.execute({ claim, signal: new AbortController().signal }),
    ).rejects.toThrow("Model authorization revoked");
    expect(app.ledger.settle).toHaveBeenCalledTimes(1);
    expect(app.ledger.settleReview).not.toHaveBeenCalled();
  });
});
