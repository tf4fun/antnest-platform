import { describe, expect, it, vi } from "vitest";
import {
  AcpApplication,
  type AcpApplicationDependencies,
} from "../../src/application/application.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import type { RunExecutionPort } from "../../src/application/run-executor.js";
import { DomainError } from "../../src/domain/errors.js";
import { binding, snapshot } from "../support/fixtures.js";

function setup() {
  const sessions: AcpApplicationDependencies["sessions"] = {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    forkSession: vi.fn(),
    resumeSession: vi.fn(),
    closeSession: vi.fn(),
    requestCancellation: vi.fn(),
    readOutput: vi.fn(),
    requirePromptSession: vi.fn().mockResolvedValue(undefined),
  };
  const assert = vi.fn().mockResolvedValue(undefined);
  const accept = vi.fn<AcpApplicationDependencies["prompts"]["accept"]>().mockResolvedValue({
    runId: "run-1",
    requestId: "request-1",
    sessionId: "session-1",
    userMessageId: "message-1",
    snapshot: snapshot(),
    outputSequence: 0,
    sessionInfoUpdate: { updatedAt: "2026-09-14T00:00:00Z" },
  });
  const execute = vi.fn<RunExecutionPort["execute"]>().mockResolvedValue({
    terminalClass: "completed",
    executorState: "quiescent",
    toolEffectState: "none",
    stopReason: "end_turn",
  });
  const application = new AcpApplication({
    configuration: { get: vi.fn(), set: vi.fn() },
    access: { assert },
    sessions,
    prompts: { accept },
    runs: new RunSupervisor({ execute }),
  });
  const input = {
    binding: binding(),
    sessionId: "session-1",
    prompt: [{ type: "text", text: "hello" }],
    outputChanged: vi.fn(),
  };
  return { application, sessions, assert, accept, execute, input };
}

describe("AcpApplication prompt ownership", () => {
  it("checks the Session before locally submitting and executing the prompt", async () => {
    const { application, sessions, assert, accept, execute, input } = setup();
    const result = await application.acceptPrompt(input);
    await expect(result.completion).resolves.toMatchObject({ terminalClass: "completed" });
    expect(assert).not.toHaveBeenCalled();
    expect(sessions.requirePromptSession).toHaveBeenCalledWith(input.sessionId, input.binding);
    expect(vi.mocked(sessions.requirePromptSession).mock.invocationCallOrder[0]).toBeLessThan(
      accept.mock.invocationCallOrder[0]!,
    );
    expect(accept).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["session_access_denied", "client_mcp_not_allowed"])(
    "does not accept or execute after Session validation rejects with %s",
    async (code) => {
      const { application, sessions, accept, execute, input } = setup();
      const denied = new DomainError(code, "Session validation rejected");
      vi.mocked(sessions.requirePromptSession).mockRejectedValue(denied);
      await expect(application.acceptPrompt(input)).rejects.toBe(denied);
      expect(accept).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
