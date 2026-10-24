import { describe, expect, it, vi } from "vitest";

import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import { ModelCallPolicy } from "../../src/application/model-call-policy.js";
import {
  ModelRequestBudget,
  ModelRequestLimitError,
} from "../../src/application/model-request-budget.js";
import type { ModelSpec, RunExecutionSnapshot } from "../../src/domain/types.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
} from "../../src/ports/model.js";
import type { ModelAttemptPort } from "../../src/ports/model-attempts.js";
import { audio, pdf } from "../fixtures/multimodal.js";
import { snapshot } from "../support/fixtures.js";

type CandidateModel = ModelSpec & { supportsTools?: boolean };
type Candidate = {
  modelProfileId: string;
  providerConnectionId: string;
  model: CandidateModel;
};
type FallbackSnapshot = RunExecutionSnapshot & {
  executionSpec: RunExecutionSnapshot["executionSpec"] & {
    model: CandidateModel;
    modelFailover?: "never" | "before_output";
    fallbackModels?: Candidate[];
  };
};

const wallStart = Date.parse("2026-10-25T00:00:00.000Z");
const image = { type: "image", mimeType: "image/png", data: "AA==" };
const tool = {
  source: "runtime" as const,
  sourceId: "runtime",
  name: "read",
  modelName: "read",
  description: "Read an existing file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

function success(): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: "completed" }],
    usage: { inputTokens: 11, outputTokens: 3 },
    stopReason: "end_turn",
  };
}

function failure(status = 503, retryable = true): ModelError {
  return new ModelError("model_http_error", "private-provider-canary", retryable, status);
}

function setup(options: { retryMax?: number; maxRequests?: number } = {}) {
  let elapsed = 0;
  const advance = (milliseconds: number) => {
    elapsed += milliseconds;
  };
  const clock = {
    now: () => wallStart + elapsed,
    monotonic: () => elapsed,
    random: vi.fn(() => 0.5),
    wait: vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>(
      (milliseconds, signal) => {
        signal.throwIfAborted();
        advance(milliseconds);
        return Promise.resolve();
      },
    ),
  };
  const model = { complete: vi.fn<ModelPort["complete"]>().mockResolvedValue(success()) };
  const attempts = {
    start: vi.fn<ModelAttemptPort["start"]>().mockResolvedValue(undefined),
    finish: vi.fn<ModelAttemptPort["finish"]>().mockResolvedValue(undefined),
  };
  const maximum = options.maxRequests ?? 16;
  const budget = new ModelRequestBudget(maximum);
  const policy = new ModelCallPolicy({ model, budget, attempts, clock });
  const abort = new AbortController();
  const frozen = snapshot() as FallbackSnapshot;
  frozen.modelProfileId = "profile-a";
  frozen.providerConnectionId = "connection-a";
  frozen.deadlineAt = new Date(clock.now() + 60000);
  frozen.executionSpec.maxModelRequests = maximum;
  frozen.executionSpec.model = {
    ...frozen.executionSpec.model,
    baseUrl: "https://a.example.test/v1",
    model: "model-a",
    supportsImages: true,
    supportsAudio: true,
    supportsPdf: true,
    pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
  };
  frozen.executionSpec.modelRetry = { max: options.retryMax ?? 0, baseMs: 1, capMs: 1 };
  frozen.executionSpec.modelFailover = "before_output";
  const candidate = (name: string, overrides: Partial<CandidateModel> = {}): Candidate => ({
    modelProfileId: `profile-${name}`,
    providerConnectionId: `connection-${name}`,
    model: {
      ...structuredClone(frozen.executionSpec.model),
      baseUrl: `https://${name}.example.test/v1`,
      model: `model-${name}`,
      contextWindow: 32000,
      maxOutputTokens: 1024,
      supportsTools: true,
      ...overrides,
    },
  });
  const b = candidate("b", {
    pricing: { currency: "USD", inputPerMillion: 3, outputPerMillion: 4 },
  });
  const c = candidate("c", {
    pricing: { currency: "USD", inputPerMillion: 5, outputPerMillion: 6 },
  });
  frozen.executionSpec.fallbackModels = [b, c];
  const request: ModelRequest & { snapshot: FallbackSnapshot } = {
    snapshot: frozen,
    messages: [{ role: "user", content: [{ type: "text", text: "original request" }] }],
    tools: [],
    signal: abort.signal,
  };
  return {
    model,
    attempts,
    budget,
    abort,
    clock,
    advance,
    request,
    b,
    c,
    spec: frozen.executionSpec,
    call: (input: ModelRequest = request) => policy.complete({ runId: "run-1", request: input }),
  };
}

function calls(f: ReturnType<typeof setup>, profiles: string[]) {
  const requests = f.model.complete.mock.calls.map(([request]) => request);
  expect(requests.map((request) => request.snapshot.modelProfileId)).toEqual(profiles);
  expect(
    f.attempts.start.mock.calls.map(([runId, fact]) => [
      runId,
      fact.ordinal,
      fact.modelProfileId,
      fact.providerConnectionId,
      fact.model,
    ]),
  ).toEqual(
    requests.map((request, index) => [
      "run-1",
      index + 1,
      request.snapshot.modelProfileId,
      request.snapshot.providerConnectionId,
      request.snapshot.executionSpec.model.model,
    ]),
  );
  expect(f.attempts.finish.mock.calls.map(([runId, fact]) => [runId, fact.ordinal])).toEqual(
    requests.map((_request, index) => ["run-1", index + 1]),
  );
  for (const request of requests) {
    expect(request.snapshot.deadlineAt).toEqual(f.request.snapshot.deadlineAt);
  }
  return requests;
}

function toolHistory(request: ModelRequest) {
  request.messages.push(
    {
      role: "assistant",
      content: [],
      toolCalls: [{ id: "tool-1", name: "read", arguments: { path: "notes.txt" } }],
    },
    {
      role: "tool",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "original Tool result" }],
    },
  );
}

describe("frozen same-Run model fallback", () => {
  it("exhausts A and B retries in configured order before C under one physical ordinal chain", async () => {
    const f = setup({ retryMax: 1 });
    const original = structuredClone(f.request.snapshot);
    f.model.complete.mockImplementation((request) => {
      if (request.snapshot.modelProfileId !== "profile-c") return Promise.reject(failure());
      return Promise.resolve(success());
    });
    await expect(f.call()).resolves.toEqual(success());
    const requests = calls(f, ["profile-a", "profile-a", "profile-b", "profile-b", "profile-c"]);
    expect(requests.map((request) => request.snapshot.providerConnectionId)).toEqual([
      "connection-a",
      "connection-a",
      "connection-b",
      "connection-b",
      "connection-c",
    ]);
    expect(requests.map((request) => request.snapshot.executionSpec.model.model)).toEqual([
      "model-a",
      "model-a",
      "model-b",
      "model-b",
      "model-c",
    ]);
    for (const request of requests) {
      expect(request.signal).toBe(requests[0]!.signal);
      expect(request.messages).toStrictEqual(f.request.messages);
      expect(request.tools).toStrictEqual(f.request.tools);
    }
    expect(f.request.snapshot).toStrictEqual(original);
    expect(f.attempts.finish.mock.calls.map(([, fact]) => fact.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "completed",
    ]);
    expect(JSON.stringify(f.attempts.finish.mock.calls)).not.toContain("private-provider-canary");
  });

  it("stops at the shared physical request limit before dispatching C", async () => {
    const f = setup({ retryMax: 1, maxRequests: 4 });
    f.model.complete.mockRejectedValue(failure());
    await expect(f.call()).rejects.toBeInstanceOf(ModelRequestLimitError);
    calls(f, ["profile-a", "profile-a", "profile-b", "profile-b"]);
  });

  it.each(["never", "omitted"] as const)("keeps runtime fallback disabled for %s", async (mode) => {
    const f = setup({ retryMax: 1 });
    if (mode === "never") f.spec.modelFailover = "never";
    else delete f.spec.modelFailover;
    const error = failure();
    f.model.complete.mockRejectedValue(error);
    await expect(f.call()).rejects.toBe(error);
    calls(f, ["profile-a", "profile-a"]);
  });

  it.each(["user-image", "tool-image", "audio", "pdf"] as const)(
    "skips an incapable candidate without trimming actual %s input",
    async (kind) => {
      const f = setup();
      if (kind === "user-image") {
        f.request.messages[0]!.content.push(structuredClone(image));
        f.b.model.supportsImages = false;
      } else if (kind === "tool-image") {
        toolHistory(f.request);
        f.request.messages.at(-1)!.content.push(structuredClone(image));
        f.b.model.supportsImages = false;
      } else if (kind === "audio") {
        f.request.messages[0]!.content.push(structuredClone(audio));
        delete f.b.model.supportsAudio;
      } else {
        f.request.messages[0]!.content.push(structuredClone(pdf));
        f.b.model.supportsPdf = false;
      }
      const messages = structuredClone(f.request.messages);
      f.model.complete.mockRejectedValueOnce(failure()).mockResolvedValue(success());
      await expect(f.call()).resolves.toEqual(success());
      const requests = calls(f, ["profile-a", "profile-c"]);
      for (const request of requests) {
        expect(request.messages).toStrictEqual(messages);
        expect(request.tools).toStrictEqual(f.request.tools);
      }
      expect(requests[1]!.snapshot.executionSpec.model).toStrictEqual(f.c.model);
    },
  );

  it("does not mistake an embedded text resource for a PDF requirement", async () => {
    const f = setup();
    f.request.messages[0]!.content.push({
      type: "resource",
      resource: { uri: "attachment:///notes.txt", mimeType: "text/plain", text: "original notes" },
    });
    delete f.b.model.supportsPdf;
    f.model.complete.mockRejectedValueOnce(failure()).mockResolvedValue(success());
    await expect(f.call()).resolves.toEqual(success());
    calls(f, ["profile-a", "profile-b"]);
  });

  it.each([
    { input: "definitions", capability: undefined },
    { input: "definitions", capability: false },
    { input: "history", capability: undefined },
    { input: "history", capability: false },
  ] as const)(
    "requires explicit Tool support for $input with capability $capability",
    async ({ input, capability }) => {
      const f = setup();
      if (capability === undefined) delete f.b.model.supportsTools;
      else f.b.model.supportsTools = capability;
      if (input === "definitions") f.request.tools.push(structuredClone(tool));
      else toolHistory(f.request);
      const original = structuredClone({ messages: f.request.messages, tools: f.request.tools });
      f.model.complete.mockRejectedValueOnce(failure()).mockResolvedValue(success());
      await expect(f.call()).resolves.toEqual(success());
      const requests = calls(f, ["profile-a", "profile-c"]);
      for (const request of requests) {
        expect(request.messages).toStrictEqual(original.messages);
        expect(request.tools).toStrictEqual(original.tools);
      }
      expect(requests[0]!.snapshot.executionSpec.model.supportsTools).toBeUndefined();
      expect(requests[1]!.snapshot.executionSpec.model.supportsTools).toBe(true);
    },
  );

  it.each([undefined, "off", "low"] as const)(
    "does not drop or change original high thinking to %s",
    async (effort) => {
      const f = setup();
      f.spec.model.model = "deepseek-v4-flash";
      f.spec.model.thinking = { protocol: "deepseek", effort: "high" };
      f.c.model.model = "deepseek-v4-pro";
      f.c.model.thinking = { protocol: "deepseek", effort: "high" };
      if (effort === undefined) delete f.b.model.thinking;
      else f.b.model.thinking = { protocol: "deepseek", effort };
      f.model.complete.mockRejectedValueOnce(failure()).mockResolvedValue(success());
      await expect(f.call()).resolves.toEqual(success());
      const requests = calls(f, ["profile-a", "profile-c"]);
      expect(requests[1]!.snapshot.executionSpec.model.thinking).toEqual(f.spec.model.thinking);
    },
  );

  it("skips a candidate whose context cannot hold the same input and output reservation", async () => {
    const f = setup();
    f.request.messages[0]!.content = [{ type: "text", text: "x".repeat(6000) }];
    f.b.model.contextWindow = 1000;
    f.b.model.maxOutputTokens = 256;
    const original = structuredClone(f.request.messages);
    f.model.complete.mockRejectedValueOnce(failure()).mockResolvedValue(success());
    await expect(f.call()).resolves.toEqual(success());
    const requests = calls(f, ["profile-a", "profile-c"]);
    expect(requests[1]!.messages).toStrictEqual(original);
    expect(requests[1]!.snapshot.executionSpec.model).toStrictEqual(f.c.model);
  });

  it("uses the candidate's complete frozen context, output and pricing instead of minimum primary values", async () => {
    const f = setup();
    f.spec.model.maxOutputTokens = 256;
    f.b.model.maxOutputTokens = 2048;
    f.b.model.contextWindow = 48000;
    f.b.model.temperature = 0.8;
    f.model.complete.mockRejectedValueOnce(failure()).mockResolvedValue(success());
    await expect(f.call()).resolves.toEqual(success());
    const requests = calls(f, ["profile-a", "profile-b"]);
    expect(requests[1]!.snapshot.executionSpec.model).toStrictEqual(f.b.model);
    expect(requests[1]!.snapshot.executionSpec.model.maxOutputTokens).toBe(2048);
    expect(f.spec.model.maxOutputTokens).toBe(256);
  });

  it("freezes the candidate list, nested model parameters and original input before the first await", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalB = structuredClone(f.b);
    const originalInput = structuredClone({ messages: f.request.messages, tools: f.request.tools });
    f.model.complete.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw failure();
    });
    const original = f.call();
    const joined = original.catch(() => undefined);
    try {
      await Promise.race([entered.promise, original]);
      f.b.modelProfileId = "changed-profile";
      f.b.providerConnectionId = "changed-connection";
      f.b.model.model = "changed-model";
      f.b.model.baseUrl = "https://changed.example.test/v1";
      f.b.model.maxOutputTokens = 1;
      f.b.model.contextWindow = 2;
      if (f.b.model.pricing !== undefined) f.b.model.pricing.inputPerMillion = 999;
      f.spec.fallbackModels = [f.c];
      f.request.messages[0]!.content = [{ type: "text", text: "changed request" }];
      f.request.tools.push(structuredClone(tool));
      const callerState = structuredClone(f.request.snapshot);
      release.resolve();
      await expect(original).resolves.toEqual(success());
      const requests = calls(f, ["profile-a", "profile-b"]);
      expect(requests[1]!.snapshot.providerConnectionId).toBe(originalB.providerConnectionId);
      expect(requests[1]!.snapshot.executionSpec.model).toStrictEqual(originalB.model);
      expect(requests[1]!.messages).toStrictEqual(originalInput.messages);
      expect(requests[1]!.tools).toStrictEqual(originalInput.tools);
      expect(f.request.snapshot).toStrictEqual(callerState);
    } finally {
      release.resolve();
      await joined;
    }
  });

  it("applies the judge bound to every candidate and leaves the final shared slot for foreground", async () => {
    const f = setup({ maxRequests: 4 });
    f.request.purpose = "permission_judge";
    f.spec.model.maxOutputTokens = 1024;
    f.spec.model.temperature = 0.8;
    f.b.model.maxOutputTokens = 192;
    f.b.model.temperature = 0.7;
    f.c.model.maxOutputTokens = 2048;
    f.c.model.temperature = 0.6;
    f.model.complete
      .mockRejectedValueOnce(failure())
      .mockRejectedValueOnce(failure())
      .mockResolvedValue(success());
    await expect(f.call()).resolves.toEqual(success());
    const requests = calls(f, ["profile-a", "profile-b", "profile-c"]);
    expect(requests.map((request) => request.snapshot.executionSpec.model.maxOutputTokens)).toEqual(
      [256, 192, 256],
    );
    expect(requests.map((request) => request.snapshot.executionSpec.model.temperature)).toEqual([
      0, 0, 0,
    ]);
    expect(f.attempts.start.mock.calls.map(([, fact]) => fact.purpose)).toEqual([
      "permission_judge",
      "permission_judge",
      "permission_judge",
    ]);
    const foreground = { ...f.request };
    delete foreground.purpose;
    await expect(f.call(foreground)).resolves.toEqual(success());
    calls(f, ["profile-a", "profile-b", "profile-c", "profile-a"]);
    await expect(f.call(foreground)).rejects.toBeInstanceOf(ModelRequestLimitError);
    expect(f.model.complete).toHaveBeenCalledTimes(4);
  });

  it("retains one ten-second judge cutoff across candidates and joins late failure without C", async () => {
    const f = setup();
    f.request.purpose = "permission_judge";
    f.model.complete.mockImplementation(() => {
      f.advance(6000);
      return Promise.reject(failure());
    });
    await expect(f.call()).rejects.toMatchObject({ code: "model_unavailable", retryable: false });
    calls(f, ["profile-a", "profile-b"]);
    expect(f.attempts.finish.mock.calls[1]![1]).toMatchObject({ outcome: "cancelled" });
  });

  it.each([400, 401])(
    "does not switch after HTTP %i even if its retryable flag is true",
    async (status) => {
      const f = setup();
      const error = failure(status);
      f.model.complete.mockRejectedValue(error);
      await expect(f.call()).rejects.toBe(error);
      calls(f, ["profile-a"]);
    },
  );

  it.each(["message", "thought", "tool"] as const)(
    "never switches after first nonempty %s output",
    async (kind) => {
      const f = setup();
      const error = failure();
      f.request.onDelta = vi.fn().mockResolvedValue(undefined);
      f.model.complete.mockImplementation(async (request) => {
        if (kind === "tool") error.outputStarted = true;
        else await request.onDelta?.({ kind, text: "visible output" });
        throw error;
      });
      await expect(f.call()).rejects.toBe(error);
      calls(f, ["profile-a"]);
      expect(f.attempts.finish.mock.calls[0]![1].outputStarted).toBe(true);
    },
  );

  it("does not switch after cancellation even when the original Provider rejects as retryable", async () => {
    const f = setup();
    const reason = new Error("original Run cancelled");
    f.model.complete.mockImplementationOnce(() => {
      f.abort.abort(reason);
      return Promise.reject(
        new ModelError("model_unavailable", "cancelled request", true, undefined, {
          cause: reason,
        }),
      );
    });
    await expect(f.call()).rejects.toBeInstanceOf(Error);
    calls(f, ["profile-a"]);
    expect(f.attempts.finish.mock.calls[0]![1].outcome).toBe("cancelled");
  });

  it.each(["cleanup", "unknown", "finish-persistence"] as const)(
    "does not switch after an independent %s failure",
    async (kind) => {
      const f = setup();
      const sentinel = new Error("original independent failure");
      const error =
        kind === "cleanup"
          ? new ModelTransportCleanupError(sentinel, { inputTokens: 7 })
          : sentinel;
      if (kind === "finish-persistence") {
        f.model.complete.mockRejectedValue(failure());
        f.attempts.finish.mockRejectedValueOnce(sentinel);
      } else f.model.complete.mockRejectedValue(error);
      const actual: unknown = await f.call().catch((failure: unknown) => failure);
      if (kind === "finish-persistence") expect(actual).toBeInstanceOf(RunEventPersistenceError);
      else expect(actual).toBe(error);
      calls(f, ["profile-a"]);
    },
  );

  it("does not dispatch any candidate after its original start receipt fails", async () => {
    const f = setup();
    const sentinel = new Error("original start persistence failed");
    f.attempts.start.mockRejectedValueOnce(sentinel);
    const actual: unknown = await f.call().catch((error: unknown) => error);
    expect(actual).toBeInstanceOf(RunEventPersistenceError);
    expect(f.attempts.start).toHaveBeenCalledOnce();
    expect(f.attempts.finish).not.toHaveBeenCalled();
    expect(f.model.complete).not.toHaveBeenCalled();
  });

  it("does not start B before the original Provider task and its finish receipt have both joined", async () => {
    const f = setup();
    const modelEntered = Promise.withResolvers<void>();
    const releaseModel = Promise.withResolvers<void>();
    const finishEntered = Promise.withResolvers<void>();
    const releaseFinish = Promise.withResolvers<void>();
    let modelJoined = false;
    f.model.complete.mockImplementationOnce(async () => {
      try {
        modelEntered.resolve();
        await releaseModel.promise;
        throw failure();
      } finally {
        modelJoined = true;
      }
    });
    f.attempts.finish.mockImplementationOnce(async () => {
      finishEntered.resolve();
      await releaseFinish.promise;
    });
    let completed = false;
    const original = f.call().finally(() => {
      completed = true;
    });
    const joined = original.catch(() => undefined);
    try {
      await Promise.race([modelEntered.promise, original]);
      expect(f.model.complete).toHaveBeenCalledOnce();
      expect(f.attempts.finish).not.toHaveBeenCalled();
      expect(modelJoined).toBe(false);
      releaseModel.resolve();
      await Promise.race([finishEntered.promise, original]);
      expect(modelJoined).toBe(true);
      expect(completed).toBe(false);
      expect(f.model.complete).toHaveBeenCalledOnce();
      expect(f.attempts.start).toHaveBeenCalledOnce();
      releaseFinish.resolve();
      await expect(original).resolves.toEqual(success());
      calls(f, ["profile-a", "profile-b"]);
    } finally {
      releaseModel.resolve();
      releaseFinish.resolve();
      await joined;
    }
  });
});
