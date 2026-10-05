import type { AgentConfiguration } from "../domain/execution-configuration.js";
import type { RuntimeInformation } from "../domain/runtime-information.js";
import { skillCommands } from "../domain/skill-commands.js";
import type { ConnectionBinding, RuntimeBinding } from "../domain/types.js";
import type { SkillCommandsPort } from "../ports/skill-commands.js";

export class RuntimeSkillCommands implements SkillCommandsPort {
  public constructor(
    private readonly dependencies: {
      directory: {
        inspect(binding: ConnectionBinding): {
          agent: Pick<AgentConfiguration, "runtime" | "accepting_runs">;
        };
      };
      busy(binding: ConnectionBinding): boolean;
      gate?: {
        begin(
          scope: { organizationId: string; agentId: string },
          signal: AbortSignal,
        ): {
          signal: AbortSignal;
          finish(quiescent: boolean): void;
        };
      };
      runtime: {
        readBinding(binding: RuntimeBinding, signal: AbortSignal): Promise<RuntimeInformation>;
      };
    },
  ) {}

  public async read(binding: ConnectionBinding, signal: AbortSignal) {
    const { agent } = this.dependencies.directory.inspect(binding);
    if (
      !agent.accepting_runs ||
      agent.runtime === null ||
      agent.runtime.connection_id === undefined
    )
      return { executionId: null, commands: [] };
    const executionId = agent.runtime.runtime_execution_id;
    if (this.dependencies.busy(binding)) return { executionId, commands: null };
    let lease: { signal: AbortSignal; finish(quiescent: boolean): void } | undefined;
    try {
      lease = this.dependencies.gate?.begin(binding, signal);
    } catch {
      return { executionId, commands: null };
    }
    let information: RuntimeInformation | undefined;
    try {
      information = await this.dependencies.runtime.readBinding(
        {
          executionId,
          mcpEndpoint: agent.runtime.mcp_endpoint,
          revision: agent.runtime.runtime_revision,
          connectionId: agent.runtime.connection_id,
        },
        // Finish an already dispatched read before foreground handoff. Catalog
        // refreshes must not occupy Runtime during a maintenance write.
        AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      );
      lease?.signal.throwIfAborted();
    } catch {
      information = undefined;
      // Catalog discovery must not delay or preempt foreground/maintenance work.
      // Skill invocation is independently validated during Run preparation.
    } finally {
      lease?.finish(true);
    }
    const current = this.dependencies.directory.inspect(binding).agent;
    if (!current.accepting_runs || current.runtime?.runtime_execution_id !== executionId)
      return { executionId: null, commands: [] };
    return {
      executionId,
      commands: information === undefined ? null : skillCommands(information.skills),
    };
  }
}
