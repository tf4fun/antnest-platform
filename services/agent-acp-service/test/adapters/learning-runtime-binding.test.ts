import { describe, expect, it, vi } from "vitest";

import { DirectoryLearningRuntimeBinding } from "../../src/adapters/learning-runtime-binding.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";

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

describe("Skill learning Runtime binding", () => {
  it("reads the current owner-authorized execution binding", async () => {
    const inspect = vi.fn(() => ({
      agent: {
        accepting_runs: true,
        runtime: {
          runtime_revision: "runtime-revision-1",
          runtime_execution_id: "execution-1",
          mcp_endpoint: "http://runtime.test:8093/mcp",
        },
      },
    }));
    const source = new DirectoryLearningRuntimeBinding({ inspect });
    expect(await source.current(claim)).toEqual({
      executionId: "execution-1",
      mcpEndpoint: "http://runtime.test:8093/mcp",
      acceptingRuns: true,
    });
    expect(
      await source.currentScope({
        organizationId: "org-1",
        agentId: "agent-1",
        ownerId: "owner-1",
      }),
    ).toEqual({
      executionId: "execution-1",
      mcpEndpoint: "http://runtime.test:8093/mcp",
      acceptingRuns: true,
    });
    expect(inspect).toHaveBeenCalledWith({
      organizationId: "org-1",
      principalId: "owner-1",
      agentId: "agent-1",
    });
  });

  it("returns no binding when disabled and propagates access denial", async () => {
    const inspect = vi.fn(() => ({ agent: { runtime: null, accepting_runs: false } }));
    const source = new DirectoryLearningRuntimeBinding({ inspect });
    expect(await source.current(claim)).toBeNull();
    inspect.mockImplementation(() => {
      throw new Error("access_denied");
    });
    await expect(source.current(claim)).rejects.toThrow("access_denied");
  });
});
