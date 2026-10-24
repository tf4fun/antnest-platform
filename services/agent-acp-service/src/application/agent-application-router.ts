import { AgentOwnershipLostError } from "../domain/agent-ownership.js";
import { DomainError } from "../domain/errors.js";
import type { ConnectionBinding } from "../domain/types.js";
import { RunRecoveryRequiredError, type AcpApplicationPort } from "../ports/acp-application.js";
import type { AccessService } from "./access-service.js";
import type { AgentGeneration, AgentGenerations } from "./agent-generations.js";

type Dependencies = {
  access: Pick<AccessService, "assert">;
  generations: Pick<AgentGenerations<AcpApplicationPort>, "capture" | "closeScope">;
};

/** Routes trusted bindings to a pre-initialized, fixed-authority application graph. */
export class AgentApplicationRouter implements AcpApplicationPort {
  public constructor(private readonly dependencies: Dependencies) {}

  public getSessionConfiguration(
    input: Parameters<AcpApplicationPort["getSessionConfiguration"]>[0],
  ) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.getSessionConfiguration(fixed));
  }
  public setSessionConfiguration(
    input: Parameters<AcpApplicationPort["setSessionConfiguration"]>[0],
  ) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.setSessionConfiguration(fixed));
  }
  public readSessionOutput(input: Parameters<AcpApplicationPort["readSessionOutput"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.readSessionOutput(fixed));
  }
  public assertAccess(input: Parameters<AcpApplicationPort["assertAccess"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.assertAccess(fixed));
  }
  public createSession(input: Parameters<AcpApplicationPort["createSession"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.createSession(fixed));
  }
  public listSessions(input: Parameters<AcpApplicationPort["listSessions"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.listSessions(fixed));
  }
  public deleteSession(input: Parameters<AcpApplicationPort["deleteSession"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.deleteSession(fixed));
  }
  public forkSession(input: Parameters<AcpApplicationPort["forkSession"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.forkSession(fixed));
  }
  public resumeSession(input: Parameters<AcpApplicationPort["resumeSession"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.resumeSession(fixed));
  }
  public closeSession(input: Parameters<AcpApplicationPort["closeSession"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.closeSession(fixed));
  }
  public cancelRun(input: Parameters<AcpApplicationPort["cancelRun"]>[0]) {
    const fixed = structuredClone(input);
    return this.route(fixed.binding, (application) => application.cancelRun(fixed));
  }
  public acceptPrompt(input: Parameters<AcpApplicationPort["acceptPrompt"]>[0]) {
    const { outputChanged, ...data } = input;
    const fixed = { ...structuredClone(data), outputChanged };
    return this.route(fixed.binding, async (application, generation) => {
      const submitted = await application.acceptPrompt(fixed);
      // Admission is still tracked here, including a late receipt after loss.
      // Hand off the original Run before dispatch can finish or reject.
      generation.retainRun(submitted.completion);
      return submitted;
    });
  }

  private async route<T>(
    binding: ConnectionBinding,
    operation: (
      application: AcpApplicationPort,
      generation: AgentGeneration<AcpApplicationPort>,
    ) => Promise<T>,
  ): Promise<T> {
    // Authorization precedes availability inspection to avoid exposing another
    // principal's Agent. Preparing/acquiring is owned by publication/startup.
    await this.dependencies.access.assert(binding);
    let generation: AgentGeneration<AcpApplicationPort>;
    try {
      generation = this.dependencies.generations.capture(binding);
    } catch (error) {
      if (error instanceof AgentOwnershipLostError) throw unavailable();
      throw error;
    }
    const dispatch = { invoked: false };
    try {
      return await generation.dispatch((application) => {
        if (binding.ownerFence !== undefined) {
          const expected = binding.ownerFence;
          const actual = generation.authority.fence;
          if (
            expected.organizationId !== actual.organizationId ||
            expected.agentId !== actual.agentId ||
            expected.ownerInstanceId !== actual.ownerInstanceId ||
            expected.epoch !== actual.epoch
          )
            throw unavailable();
        }
        dispatch.invoked = true;
        return operation(application, generation);
      });
    } catch (error) {
      const loss =
        error instanceof AgentOwnershipLostError
          ? error
          : error instanceof RunRecoveryRequiredError &&
              error.cause instanceof AgentOwnershipLostError
            ? error.cause
            : undefined;
      if (loss === undefined) throw error;
      // The manager retains this original close Promise and reports release
      // failures on drain. Never await closure inside a generation's own task.
      void this.dependencies.generations.closeScope(binding, loss);
      if (!dispatch.invoked) throw unavailable();
      if (error instanceof RunRecoveryRequiredError) throw error;
      throw new RunRecoveryRequiredError("Agent operation requires recovery", error);
    }
  }
}

function unavailable(): DomainError {
  return new DomainError("agent_unavailable", "Agent execution is unavailable");
}
