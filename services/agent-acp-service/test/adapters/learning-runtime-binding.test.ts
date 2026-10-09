import { describe, expect, it, vi } from "vitest";
import { DirectoryLearningRuntimeBinding } from "../../src/adapters/learning-runtime-binding.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import { DomainError } from "../../src/domain/errors.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";

describe("learning Runtime connection reference", () => {
  const scope = { organizationId: "organization-1", agentId: "agent-1", ownerId: "principal-1" };
  it("uses all public connection fields from the current authorized Agent without carrying credentials", async () => {
    const configuration = publicExecutionConfiguration(
      parseExecutionConfiguration(executionConfiguration()),
    );
    const agent = configuration.agents[0]!;
    const inspect = vi.fn(() => ({ agent }));
    const source = new DirectoryLearningRuntimeBinding({
      inspect,
    });
    const reference = await source.currentScope(scope);
    expect(reference).toEqual({
      ...resolveExecutionConfiguration(configuration, executionIdentity(), {}).runtime,
      acceptingRuns: true,
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(executionIdentity());
    expect(reference).not.toHaveProperty("credential");
  });
  it("does not invent an executable connection from a closed fence without its ID", async () => {
    const configuration = publicExecutionConfiguration(
      parseExecutionConfiguration(executionConfiguration()),
    );
    const agent = configuration.agents[0]!;
    agent.accepting_runs = false;
    delete agent.runtime!.connection_id;
    expect(
      await new DirectoryLearningRuntimeBinding({
        inspect: () => ({ agent }),
      }).currentScope(scope),
    ).toBeNull();
  });
  it("denies a learning Runtime read after principal revocation", async () => {
    const source = new DirectoryLearningRuntimeBinding({
      inspect: () => {
        throw new DomainError("access_denied", "revoked");
      },
    });
    const claim: LearningTaskClaim = {
      ...scope,
      taskId: "task-1",
      claimId: "claim-1",
      generation: 1,
      sourceRunId: "run-1",
      frozenPolicy: {},
    };
    await expect(source.current(claim)).rejects.toMatchObject({ code: "access_denied" });
  });
});
