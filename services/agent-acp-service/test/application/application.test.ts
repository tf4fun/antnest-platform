import { describe, expect, it, vi } from "vitest";

import { AcpApplication } from "../../src/application/application.js";
import type { AccessService } from "../../src/application/access-service.js";
import type { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import type { RunLifecyclePort } from "../../src/application/run-supervisor.js";
import type { SessionService } from "../../src/application/session-service.js";
import type { ConnectionBinding } from "../../src/domain/types.js";

describe("AcpApplication", () => {
  it("uses acquire-run admission instead of resolving access twice for a prompt", async () => {
    const assert = vi.fn(() => Promise.resolve());
    const accept = vi.fn<PromptCoordinator["accept"]>(() => Promise.resolve({} as never));
    const admit = vi.fn<RunLifecyclePort["admit"]>((_, operation) =>
      operation(new AbortController().signal),
    );
    const application = new AcpApplication({
      access: { assert } as unknown as AccessService,
      sessions: {} as SessionService,
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
    expect(admit).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });
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
