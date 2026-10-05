import { DomainError } from "../domain/errors.js";
import {
  SkillSourceError,
  type SkillSourceArtifact,
  type SkillSourceInspect,
  type SkillSourceKey,
  type SkillSourceRecord,
  type SkillProjection,
} from "../domain/skill-source.js";
import type { ExecutionIdentity, AgentConfiguration } from "../domain/execution-configuration.js";
import type { RuntimeBinding } from "../domain/types.js";

type Binding = NonNullable<AgentConfiguration["runtime"]>;
type Dependencies = {
  directory: {
    inspect(identity: ExecutionIdentity): {
      agent: { accepting_runs: boolean; runtime: Binding | null };
    };
  };
  repository: {
    read(organizationId: string, key: SkillSourceKey): Promise<SkillSourceRecord | null>;
    remove(projection: SkillProjection): Promise<void>;
  };
  runtime: {
    verify(
      record: SkillSourceRecord,
      binding: RuntimeBinding,
      signal: AbortSignal,
    ): Promise<"current" | "changed" | "unknown">;
  };
  gate: {
    begin(
      scope: { organizationId: string; agentId: string },
      signal: AbortSignal,
    ): { signal: AbortSignal; finish(quiescent: boolean): void };
  };
};

export class SkillSources {
  public constructor(private readonly dependencies: Dependencies) {}

  public async inspect(
    input: SkillSourceInspect,
    signal: AbortSignal,
  ): Promise<{ items: SkillProjection[] }> {
    const items: SkillProjection[] = [];
    for (const key of input.sources) {
      try {
        items.push(
          (await this.current(input.organization_id, input.actor_id, key, signal)).projection,
        );
      } catch (error) {
        if (
          error instanceof SkillSourceError &&
          ["not_found", "content_changed"].includes(error.code)
        )
          continue;
        throw error;
      }
    }
    return { items };
  }

  public async artifact(
    input: SkillSourceArtifact,
    signal: AbortSignal,
  ): Promise<SkillSourceRecord> {
    return this.current(input.organization_id, input.actor_id, input.skill_ref, signal, {
      sequence: input.skill_ref.sequence,
      digest: input.expected_digest,
    });
  }

  private async current(
    organizationId: string,
    actorId: string,
    key: SkillSourceKey,
    signal: AbortSignal,
    expected?: { sequence: number; digest: string },
  ): Promise<SkillSourceRecord> {
    signal.throwIfAborted();
    const identity = { organizationId, principalId: actorId, agentId: key.agent_id };
    try {
      const before = this.dependencies.directory.inspect(identity).agent;
      const record = await this.dependencies.repository.read(organizationId, key);
      if (record === null || !record.projection.active || record.projection.owner_id !== actorId)
        throw new SkillSourceError("not_found");
      if (
        expected &&
        (record.projection.sequence !== expected.sequence ||
          record.projection.content_digest !== expected.digest)
      )
        throw new SkillSourceError("content_changed");
      if (
        !before.accepting_runs ||
        before.runtime === null ||
        before.runtime.connection_id === undefined
      )
        throw new SkillSourceError("source_unavailable");
      const slot = this.dependencies.gate.begin({ organizationId, agentId: key.agent_id }, signal);
      try {
        slot.signal.throwIfAborted();
        // Once dispatched, finish this bounded read before yielding to a new Run.
        // A foreground preemption cancels delivery, not the observation acknowledgement.
        const outcome = await this.dependencies.runtime.verify(
          record,
          {
            revision: before.runtime.runtime_revision,
            executionId: before.runtime.runtime_execution_id,
            mcpEndpoint: before.runtime.mcp_endpoint,
            connectionId: before.runtime.connection_id,
          },
          signal,
        );
        slot.signal.throwIfAborted();
        if (outcome === "unknown") throw new SkillSourceError("source_unavailable");
        if (outcome === "changed") {
          await this.dependencies.repository.remove(record.projection);
          throw new SkillSourceError("content_changed");
        }
        const latest = await this.dependencies.repository.read(organizationId, key);
        if (latest === null || !latest.projection.active || latest.projection.owner_id !== actorId)
          throw new SkillSourceError("not_found");
        if (
          latest.projection.sequence !== record.projection.sequence ||
          latest.projection.content_digest !== record.projection.content_digest
        )
          throw new SkillSourceError("content_changed");
        const after = this.dependencies.directory.inspect(identity).agent;
        if (
          !after.accepting_runs ||
          after.runtime?.runtime_revision !== before.runtime.runtime_revision ||
          after.runtime.connection_id !== before.runtime.connection_id ||
          after.runtime.runtime_execution_id !== before.runtime.runtime_execution_id ||
          after.runtime.mcp_endpoint !== before.runtime.mcp_endpoint
        )
          throw new SkillSourceError("source_unavailable");
        return record;
      } finally {
        // Observe is read-only; it never creates a learning effect or unknown-write fence.
        slot.finish(true);
      }
    } catch (error) {
      if (error instanceof SkillSourceError) throw error;
      if (error instanceof DomainError && error.code === "access_denied")
        throw new SkillSourceError("not_found");
      throw new SkillSourceError("source_unavailable");
    }
  }
}
