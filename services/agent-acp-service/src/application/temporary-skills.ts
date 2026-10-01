import { DomainError } from "../domain/errors.js";
import type { LoadedSkillText } from "../ports/skill-discovery.js";
import type {
  TemporaryAgentScope,
  TemporaryInstallInput,
  TemporarySkillScope,
  TemporarySkillStore,
  TemporarySkillRuntime,
} from "../ports/temporary-skills.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../ports/telemetry.js";

/** Durable scope records contain binding metadata, never package bytes. */
export class TemporarySkills {
  public constructor(
    private readonly store: TemporarySkillStore,
    private readonly runtime: TemporarySkillRuntime,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
  ) {}
  public async install(input: TemporaryInstallInput, loaded: LoadedSkillText) {
    input.signal.throwIfAborted();
    const scope = await this.store.reserve(input);
    input.signal.throwIfAborted();
    return this.telemetry.span(
      "skill.temporary.install",
      {
        ...attributes(scope),
        "antnest.skill.content_digest": loaded.contentDigest,
        "antnest.skill.artifact_digest": loaded.artifactDigest,
      },
      () => this.runtime.install(scope, loaded, input.signal),
    );
  }
  public async releaseRun(runId: string, signal: AbortSignal): Promise<void> {
    const scope = await this.store.forRun(runId, signal);
    if (scope !== null) await this.release(scope, signal);
  }
  public async releaseAgent(scope: TemporaryAgentScope, signal: AbortSignal): Promise<void> {
    for (const pending of await this.store.forAgent(scope, signal))
      await this.release(pending, signal);
  }
  public async assertClearAgent(scope: TemporaryAgentScope, signal: AbortSignal): Promise<void> {
    if ((await this.store.forAgent(scope, signal)).length > 0)
      throw new DomainError("runtime_barrier_required", "Temporary Skill cleanup is pending");
  }
  public next(after: string | null, signal: AbortSignal) {
    return this.store.next(after, signal);
  }
  public async release(scope: TemporarySkillScope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.telemetry.span("skill.temporary.release", attributes(scope), async () => {
      await this.runtime.cleanup(scope, signal);
      signal.throwIfAborted();
      await this.store.released(scope);
    });
  }
}
function attributes(scope: TemporarySkillScope) {
  return {
    "antnest.organization_id": scope.organizationId,
    "antnest.agent_id": scope.agentId,
    "antnest.run_id": scope.runId,
    "antnest.runtime_execution_id": scope.executionId,
  };
}
