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
import type { AgentOwnershipFence } from "../domain/agent-ownership.js";

export type SourceReadAuthority = Readonly<{
  fence: AgentOwnershipFence;
  signal: AbortSignal;
  assertCurrent(): void;
}>;

type Binding = NonNullable<AgentConfiguration["runtime"]>;
type Dependencies = {
  directory: {
    inspect(identity: ExecutionIdentity): {
      agent: { accepting_runs: boolean; runtime: Binding | null };
    };
  };
  repository: {
    read(organizationId: string, key: SkillSourceKey): Promise<SkillSourceRecord | null>;
    remove(
      projection: SkillProjection,
      fence?: AgentOwnershipFence,
      assertCurrent?: () => void,
    ): Promise<void>;
  };
  runtime: {
    verify(
      record: SkillSourceRecord,
      binding: RuntimeBinding,
      signal: AbortSignal,
    ): Promise<"current" | "changed" | "unknown">;
  };
  gate: {
    beginSourceRead(
      scope: { organizationId: string; agentId: string; ownerFence?: AgentOwnershipFence },
      signal: AbortSignal,
    ): Promise<{ signal: AbortSignal; finish(): void }>;
  };
};

export class SkillSources {
  public constructor(private readonly dependencies: Dependencies) {}

  public async inspect(
    input: SkillSourceInspect,
    signal: AbortSignal,
    authority?: SourceReadAuthority,
  ): Promise<{ items: SkillProjection[] }> {
    const items: SkillProjection[] = [];
    for (const key of input.sources) {
      try {
        items.push(
          (
            await this.current(
              input.organization_id,
              input.actor_id,
              key,
              signal,
              undefined,
              authority,
            )
          ).projection,
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
    authority?: SourceReadAuthority,
  ): Promise<SkillSourceRecord> {
    return this.current(
      input.organization_id,
      input.actor_id,
      input.skill_ref,
      signal,
      {
        sequence: input.skill_ref.sequence,
        digest: input.expected_digest,
      },
      authority,
    );
  }

  private async current(
    organizationId: string,
    actorId: string,
    key: SkillSourceKey,
    signal: AbortSignal,
    expected?: { sequence: number; digest: string },
    authority?: SourceReadAuthority,
  ): Promise<SkillSourceRecord> {
    if (authority !== undefined) signal = AbortSignal.any([signal, authority.signal]);
    const identity = { organizationId, principalId: actorId, agentId: key.agent_id };
    const currentAuthority = () => {
      signal.throwIfAborted();
      authority?.assertCurrent();
      if (
        authority !== undefined &&
        (authority.fence.organizationId !== organizationId ||
          authority.fence.agentId !== key.agent_id)
      )
        throw new SkillSourceError("source_unavailable");
    };
    try {
      currentAuthority();
      const before = this.dependencies.directory.inspect(identity).agent;
      let record = await this.dependencies.repository.read(organizationId, key);
      currentAuthority();
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
      const slot = await this.dependencies.gate.beginSourceRead(
        {
          organizationId,
          agentId: key.agent_id,
          ...(authority === undefined ? {} : { ownerFence: authority.fence }),
        },
        signal,
      );
      try {
        slot.signal.throwIfAborted();
        currentAuthority();
        // Admission may have waited for another read. Never dispatch against an
        // authorization, source selection or Runtime binding captured before it.
        const admitted = await this.dependencies.repository.read(organizationId, key);
        slot.signal.throwIfAborted();
        currentAuthority();
        if (
          admitted === null ||
          !admitted.projection.active ||
          admitted.projection.owner_id !== actorId
        )
          throw new SkillSourceError("not_found");
        if (
          admitted.projection.sequence !== record.projection.sequence ||
          admitted.projection.content_digest !== record.projection.content_digest
        )
          throw new SkillSourceError("content_changed");
        const current = this.dependencies.directory.inspect(identity).agent;
        if (
          !current.accepting_runs ||
          current.runtime?.runtime_revision !== before.runtime.runtime_revision ||
          current.runtime.connection_id !== before.runtime.connection_id ||
          current.runtime.runtime_execution_id !== before.runtime.runtime_execution_id ||
          current.runtime.mcp_endpoint !== before.runtime.mcp_endpoint
        )
          throw new SkillSourceError("source_unavailable");
        record = admitted;
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
        currentAuthority();
        if (outcome === "unknown") throw new SkillSourceError("source_unavailable");
        if (outcome === "changed") {
          if (authority === undefined) await this.dependencies.repository.remove(record.projection);
          else
            await this.dependencies.repository.remove(
              record.projection,
              authority.fence,
              currentAuthority,
            );
          throw new SkillSourceError("content_changed");
        }
        const latest = await this.dependencies.repository.read(organizationId, key);
        slot.signal.throwIfAborted();
        currentAuthority();
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
        slot.finish();
      }
    } catch (error) {
      if (error instanceof SkillSourceError) throw error;
      if (error instanceof DomainError && error.code === "access_denied")
        throw new SkillSourceError("not_found");
      throw new SkillSourceError("source_unavailable", { cause: error });
    }
  }
}
