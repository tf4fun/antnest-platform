import { describe, expect, it, vi } from "vitest";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { RunExecutor, type RunExecutorDependencies } from "../../src/application/run-executor.js";
import type { RunExecutionInput } from "../../src/ports/acp-application.js";
import {
  publicExecutionConfiguration,
  type ExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import type { ModelToolDefinition } from "../../src/domain/types.js";
import type { AuthenticatedModelTransport } from "../../src/ports/model.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import type { ExecutionRepository } from "../../src/ports/execution-repository.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

const now = new Date("2026-09-14T00:00:00Z");
const tool: ModelToolDefinition = {
  source: "runtime",
  sourceId: "runtime-1",
  name: "read",
  modelName: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: {} },
};

function setup() {
  const configuration: ExecutionConfiguration = executionConfiguration();
  configuration.agents[0]!.default_authorization.mode = "auto";
  const complete = vi.fn<AuthenticatedModelTransport["complete"]>().mockResolvedValue({
    kind: "message",
    content: [{ type: "text", text: "done" }],
    usage: { inputTokens: 4, outputTokens: 1 },
    stopReason: "end_turn",
  });
  const providers = new ProviderClients({ complete });
  providers.apply(configuration);
  const call = vi.fn<ToolCatalogPort["call"]>().mockResolvedValue({
    content: [{ type: "text", text: "read result" }],
    isError: false,
    toolEffectState: "settled",
  });
  const tools = { list: vi.fn<ToolCatalogPort["list"]>(), call };
  const build = vi.fn<RunExecutorDependencies["contextBuilder"]["build"]>().mockResolvedValue({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [tool],
    runtimeWorkspace: "/workspace",
  });
  const events: RunEventRepository = {
    appendAgentMessage: vi.fn<RunEventRepository["appendAgentMessage"]>((input) =>
      Promise.resolve({ kind: "agent_message", messageId: input.id, content: input.content }),
    ),
    appendUsage: vi.fn<RunEventRepository["appendUsage"]>((input) =>
      Promise.resolve({ kind: "usage", used: 5, size: input.contextSize }),
    ),
    startToolAttempt: vi.fn<RunEventRepository["startToolAttempt"]>((input) =>
      Promise.resolve({
        kind: "tool_call",
        initial: true,
        title: input.tool.name,
        toolCallId: input.toolCallId,
        status: "in_progress",
      }),
    ),
    finishToolAttempt: vi.fn<RunEventRepository["finishToolAttempt"]>((input) =>
      Promise.resolve({
        kind: "tool_call",
        initial: false,
        toolCallId: input.toolCallId,
        status: input.status,
        content: input.content,
      }),
    ),
    appendPlan: vi.fn(),
    appendAgentThought: vi.fn(),
    appendToolProgress: vi.fn(),
    appendRejectedToolCall: vi.fn(),
    interruptToolAttempts: vi.fn(),
  };
  const finish = vi.fn<ExecutionRepository["finish"]>().mockResolvedValue();
  let sequence = 0;
  const executor = new RunExecutor({
    providers,
    tools,
    contextBuilder: { build },
    events,
    executions: { finish, getState: vi.fn(), listRecoveryWork: vi.fn() },
    ownershipSignal: new AbortController().signal,
    recoveryRequired: vi.fn(),
    now: () => now,
    id: () => `event-${++sequence}`,
  });
  const input: RunExecutionInput = {
    accepted: {
      outputSequence: 0,
      runId: "run-1",
      requestId: "request-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      snapshot: runSnapshot({
        configuration: publicExecutionConfiguration(configuration),
        identity: executionIdentity(),
        overrides: {},
        accessRevision: "access-1",
        clientMcpRevisionId: "mcp-1",
        deadlineAt: new Date(now.getTime() + 60000),
      }),
    },
    publish: vi.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal,
  };
  return { configuration, executor, providers, complete, build, call, finish, input };
}

describe("Run logical Provider client", () => {
  it("uses rotated authentication on the next model request of the same Run", async () => {
    const { configuration, executor, providers, complete, call, input, finish } = setup();
    complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "call-1", name: "read", arguments: {} }],
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    call.mockImplementationOnce(() => {
      const next = structuredClone(configuration);
      next.revision = 2;
      next.providers[0] = {
        ...next.providers[0]!,
        enabled: true,
        credential_revision: "credential-2",
        credential: { method: "api_key", secret: "rotated-test-key" },
      };
      providers.apply(next);
      return Promise.resolve({
        content: [{ type: "text", text: "read result" }],
        isError: false,
        toolEffectState: "settled",
      });
    });
    await expect(executor.execute(input)).resolves.toMatchObject({ terminalClass: "completed" });
    expect(complete.mock.calls.map(([request]) => request.credential)).toEqual([
      "synthetic-provider-key",
      "rotated-test-key",
    ]);
    expect(complete.mock.calls[0]![0].snapshot).toEqual(complete.mock.calls[1]![0].snapshot);
    expect(JSON.stringify(input.accepted)).not.toContain("rotated-test-key");
    expect(JSON.stringify(finish.mock.calls)).not.toContain("rotated-test-key");
  });

  it("retires after an actual holder finishes, without permitting new acquisition", async () => {
    const { configuration, executor, providers, complete, build, input } = setup();
    build.mockImplementationOnce(() => {
      const next = structuredClone(configuration);
      next.revision = 2;
      next.providers[0] = { ...next.providers[0]!, enabled: false };
      providers.apply(next);
      expect(() => providers.acquire("organization-1", "provider-1")).toThrow("unavailable");
      return Promise.resolve({
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        runtimeWorkspace: "/workspace",
      });
    });
    await expect(executor.execute(input)).resolves.toMatchObject({ terminalClass: "completed" });
    expect(complete).toHaveBeenCalledOnce();
    expect(() => providers.acquire("organization-1", "provider-1")).toThrow("unavailable");
  });

  it("fails an accepted Run with no available client before touching Runtime", async () => {
    const { configuration, executor, providers, complete, build, input, finish } = setup();
    configuration.providers[0] = { ...configuration.providers[0]!, enabled: false };
    providers.apply(configuration);
    await expect(executor.execute(input)).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "provider_unavailable",
    });
    expect(build).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", terminalClass: "failed" }),
    );
  });

  it("retains the local execution deadline without acquiring a Provider or Runtime", async () => {
    const { executor, providers, build, complete, input } = setup();
    const acquire = vi.spyOn(providers, "acquire");
    input.accepted.snapshot.deadlineAt = new Date(now.getTime() - 1);
    await expect(executor.execute(input)).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "run_deadline_exceeded",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
