import {
  SkillDiscoveryError,
  skillFindInputSchema,
  skillLoadInputSchema,
  withSkillDiscoveryTools,
} from "../domain/skill-discovery.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../ports/telemetry.js";
import type { SkillDiscoveryAuthority, SkillDiscoveryPort } from "../ports/skill-discovery.js";
import type { ToolCallInput, ToolCallResult, ToolCatalogPort } from "../ports/tools.js";
import type { ToolEffectState } from "../domain/types.js";
import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import { TemporarySkillFailure } from "../domain/temporary-skills.js";
import type { TemporarySkills } from "./temporary-skills.js";

export class SkillDiscoveryTools implements ToolCatalogPort {
  public constructor(
    private readonly dependencies: {
      runtime: ToolCatalogPort;
      registry: SkillDiscoveryPort;
      authority: SkillDiscoveryAuthority;
      telemetry?: TelemetryPort;
      temporary?: Pick<TemporarySkills, "install">;
    },
  ) {}

  public async list(snapshot: ToolCallInput["snapshot"], signal: AbortSignal) {
    return withSkillDiscoveryTools(await this.dependencies.runtime.list(snapshot, signal));
  }

  public async call(input: ToolCallInput): Promise<ToolCallResult> {
    if (input.tool.source === "runtime" && !["find_skill", "load_skill"].includes(input.tool.name))
      return this.dependencies.runtime.call(input);
    let effectState: ToolEffectState = "none";
    let runtimeCallStopped = true;
    try {
      input.signal.throwIfAborted();
      if (
        input.tool.source !== "agent" ||
        input.tool.sourceId !== "skill_registry" ||
        input.tool.modelName !== input.tool.name
      )
        throw new SkillDiscoveryError("invalid_request");
      const action = input.tool.name;
      const parsed =
        action === "find_skill"
          ? skillFindInputSchema.safeParse(input.arguments)
          : action === "load_skill"
            ? skillLoadInputSchema.safeParse(input.arguments)
            : null;
      if (!parsed?.success) throw new SkillDiscoveryError("invalid_request");
      const authority = await this.dependencies.authority.authorize(input);
      input.signal.throwIfAborted();
      const scope = { organization_id: authority.organizationId, actor_id: authority.principalId };
      const telemetry = this.dependencies.telemetry ?? NOOP_TELEMETRY;
      return await telemetry.span(
        action === "find_skill" ? "skill.discovery.search" : "skill.discovery.load",
        {
          "run.id": input.runId,
          "organization.id": scope.organization_id,
          ...(action === "load_skill"
            ? sourceAttributes(skillLoadInputSchema.parse(input.arguments))
            : {}),
        },
        async () => {
          const result =
            action === "find_skill"
              ? await this.dependencies.registry.search(
                  {
                    ...scope,
                    ...skillFindInputSchema.parse(input.arguments),
                    query: skillFindInputSchema.parse(input.arguments).query.trim(),
                    requesting_agent_id: authority.agentId,
                  },
                  input.signal,
                )
              : await this.load(input, scope, authority, () => {
                  effectState = "settled";
                  runtimeCallStopped = true;
                });
          input.signal.throwIfAborted();
          const current = await this.dependencies.authority.authorize(input);
          if (
            current.organizationId !== authority.organizationId ||
            current.principalId !== authority.principalId ||
            current.agentId !== authority.agentId
          )
            throw new SkillDiscoveryError("not_found");
          return reply(result, false, effectState, runtimeCallStopped);
        },
      );
    } catch (error) {
      if (error instanceof TemporarySkillFailure) {
        effectState = error.effectState;
        runtimeCallStopped = error.runtimeCallStopped;
      }
      if (input.signal.aborted)
        throw Object.assign(new Error("Skill discovery call cancelled"), {
          effectState,
          runtimeCallStopped,
        });
      if (error instanceof TemporarySkillFailure)
        return reply(
          { error: { code: error.code, message: error.message } },
          true,
          effectState,
          runtimeCallStopped,
        );
      const code =
        error instanceof SkillDiscoveryError
          ? error.code
          : errorCode(error) === "access_denied"
            ? "not_found"
            : "source_unavailable";
      const failure = new SkillDiscoveryError(code);
      return reply(
        { error: { code: failure.code, message: failure.message } },
        true,
        effectState,
        runtimeCallStopped,
      );
    }
  }

  private async load(
    input: ToolCallInput,
    scope: { organization_id: string; actor_id: string },
    authority: ExecutionIdentity,
    installed: () => void,
  ) {
    const selected = skillLoadInputSchema.parse(input.arguments);
    const loaded = await this.dependencies.registry.load({ ...scope, ...selected }, input.signal);
    if (loaded.contentDigest !== selected.expected_digest)
      throw new SkillDiscoveryError("source_invalid");
    let files = null;
    if (loaded.requiresRuntimeDelivery) {
      input.signal.throwIfAborted();
      const current = await this.dependencies.authority.authorize(input);
      if (
        current.organizationId !== authority.organizationId ||
        current.principalId !== authority.principalId ||
        current.agentId !== authority.agentId
      )
        throw new SkillDiscoveryError("not_found");
      if (!this.dependencies.temporary) throw new TemporarySkillFailure("none", true);
      files = await this.dependencies.temporary.install(input, loaded);
      installed();
    }
    return {
      skill_ref: selected.skill_ref,
      content_digest: loaded.contentDigest,
      artifact_digest: loaded.artifactDigest,
      skill_text: loaded.skillText,
      temporary_files: files,
      requires_runtime_delivery: loaded.requiresRuntimeDelivery,
    };
  }
}

function reply(
  value: unknown,
  isError: boolean,
  effectState: ToolEffectState = "none",
  runtimeCallStopped = true,
): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
    toolEffectState: effectState,
    runtimeCallStopped,
  };
}
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : null;
}
function sourceAttributes(input: ReturnType<typeof skillLoadInputSchema.parse>) {
  const ref = input.skill_ref;
  return {
    "skill.content_digest": input.expected_digest,
    "skill.source.kind": ref.kind,
    ...(ref.kind === "agent"
      ? {
          "skill.source.agent_id": ref.agent_id,
          "skill.source.name": ref.name,
          "skill.source.sequence": ref.sequence,
        }
      : { "skill.id": ref.skill_id, "skill.version": ref.version }),
  };
}
