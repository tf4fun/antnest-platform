import { describe, expect, it, vi } from "vitest";

import { AccessService } from "../../src/application/access-service.js";
import type { AgentControllerPort } from "../../src/ports/agent-controller.js";
import { binding } from "../support/fixtures.js";

describe("AccessService", () => {
  it("accepts an unchanged Agent-scoped access binding", async () => {
    const resolveAgentAccess = vi.fn<AgentControllerPort["resolveAgentAccess"]>(() =>
      Promise.resolve({
        principalId: "principal-1",
        agentId: "agent-1",
        accessRevision: "access-1",
        promptCapabilities: { image: true, embeddedContext: true },
      }),
    );
    const service = new AccessService({
      agentController: { resolveAgentAccess },
      id: () => "request-1",
    });

    await expect(service.assert(binding())).resolves.toBeUndefined();
    expect(resolveAgentAccess).toHaveBeenCalledWith({
      requestId: "request-1",
      agentAccessSubject: "subject-1",
    });
  });

  it("forces reconnect when access or Agent capabilities change", async () => {
    const service = new AccessService({
      agentController: {
        resolveAgentAccess: vi.fn(() =>
          Promise.resolve({
            principalId: "principal-1",
            agentId: "agent-1",
            accessRevision: "access-2",
            promptCapabilities: { image: false, embeddedContext: true },
          }),
        ),
      },
      id: () => "request-1",
    });

    await expect(service.assert(binding())).rejects.toMatchObject({
      code: "connection_binding_stale",
    });
  });
});
