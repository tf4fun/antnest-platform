import { describe, expect, it, vi } from "vitest";

import { AcpApplication } from "../../src/application/application.js";
import type { AccessService } from "../../src/application/access-service.js";
import type { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import type { RunLifecyclePort } from "../../src/application/run-supervisor.js";
import type { SessionService } from "../../src/application/session-service.js";
import type { ConnectionBinding } from "../../src/domain/types.js";
import { DomainError } from "../../src/domain/errors.js";

describe("AcpApplication", () => {
  it("uses acquire-run admission instead of resolving access twice for a prompt", async () => {
    const assert = vi.fn(() => Promise.resolve());
    const accept = vi.fn<PromptCoordinator["accept"]>(() => Promise.resolve({} as never));
    const admit = vi.fn<RunLifecyclePort["admit"]>((_, operation) =>
      operation(new AbortController().signal),
    );
    const requirePromptSession = vi.fn<SessionService["requirePromptSession"]>(() =>
      Promise.resolve(),
    );
    const application = new AcpApplication({
      configuration: { get: vi.fn(), set: vi.fn() },
      access: { assert } as unknown as AccessService,
      sessions: { requirePromptSession } as unknown as SessionService,
      prompts: { accept } as unknown as PromptCoordinator,
      runs: { admit } as unknown as RunLifecyclePort,
    });
    const input = {
      binding: binding(),
      sessionId: "session-1",
      prompt: [{ type: "text" as const, text: "hello" }],
    };

    await application.acceptPrompt(input);

    expect(assert).not.toHaveBeenCalled();
    expect(requirePromptSession).toHaveBeenCalledWith(input.sessionId, input.binding);
    expect(requirePromptSession.mock.invocationCallOrder[0]).toBeLessThan(
      admit.mock.invocationCallOrder[0]!,
    );
    expect(admit).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });

  it.each(["session_access_denied", "client_mcp_not_allowed"])(
    "does not admit a Run when Session validation rejects with %s",
    async (code) => {
      const denied = new DomainError(code, "Session validation rejected");
      const requirePromptSession = vi.fn(() => Promise.reject(denied));
      const admit = vi.fn<RunLifecyclePort["admit"]>();
      const accept = vi.fn<PromptCoordinator["accept"]>();
      const application = new AcpApplication({
        configuration: { get: vi.fn(), set: vi.fn() },
        access: {} as AccessService,
        sessions: { requirePromptSession } as unknown as SessionService,
        prompts: { accept } as unknown as PromptCoordinator,
        runs: { admit } as unknown as RunLifecyclePort,
      });
      await expect(
        application.acceptPrompt({
          binding: binding(),
          sessionId: "foreign-session",
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toBe(denied);
      expect(admit).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
    },
  );
});

function binding(): ConnectionBinding {
  return {
    connectionId: "connection-1",
    agentAccessSubject: "subject-1",
    principalId: "principal-1",
    agentId: "agent-1",
    accessRevision: "access-1",
  };
}
