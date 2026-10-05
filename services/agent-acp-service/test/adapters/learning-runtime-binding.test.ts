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
import type { RuntimeBinding } from "../../src/domain/types.js";

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
      runtimeForCleanup: vi.fn(() => null),
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
        runtimeForCleanup: () => null,
      }).currentScope(scope),
    ).toBeNull();
  });
  it("uses previously installed authority for accepted cleanup even when closure carries no connection ID", async () => {
    const configuration = publicExecutionConfiguration(
      parseExecutionConfiguration(executionConfiguration()),
    );
    const original = resolveExecutionConfiguration(configuration, executionIdentity(), {}).runtime;
    const agent = configuration.agents[0]!;
    agent.accepting_runs = false;
    delete agent.runtime!.connection_id;
    const runtimeForCleanup = vi.fn<
      (scope: { organizationId: string; agentId: string }) => RuntimeBinding | null
    >(() => original);
    const source = new DirectoryLearningRuntimeBinding({
      inspect: () => ({ agent }),
      runtimeForCleanup,
    });
    const claim: LearningTaskClaim = {
      ...scope,
      taskId: "task-1",
      claimId: "claim-1",
      generation: 1,
      sourceRunId: "run-1",
      frozenPolicy: {},
    };
    expect(await source.forCleanup(claim)).toEqual({ ...original, acceptingRuns: false });
    expect(runtimeForCleanup).toHaveBeenCalledExactlyOnceWith({
      organizationId: scope.organizationId,
      agentId: scope.agentId,
    });
    runtimeForCleanup.mockReturnValue(null);
    expect(await source.forCleanup(claim)).toBeNull();
  });
  it("permits only accepted cleanup after principal revocation and keeps foreground reads denied", async () => {
    const configuration = publicExecutionConfiguration(
      parseExecutionConfiguration(executionConfiguration()),
    );
    const original = resolveExecutionConfiguration(configuration, executionIdentity(), {}).runtime;
    const source = new DirectoryLearningRuntimeBinding({
      inspect: () => {
        throw new DomainError("access_denied", "revoked");
      },
      runtimeForCleanup: () => original,
    });
    const claim: LearningTaskClaim = {
      ...scope,
      taskId: "task-1",
      claimId: "claim-1",
      generation: 1,
      sourceRunId: "run-1",
      frozenPolicy: {},
    };
    expect(await source.forCleanup(claim)).toEqual({ ...original, acceptingRuns: false });
    await expect(source.current(claim)).rejects.toMatchObject({ code: "access_denied" });
  });
});
