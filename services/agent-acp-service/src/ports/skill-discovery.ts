import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import type {
  SkillFindInput,
  SkillLoadInput,
  SkillSearchResult,
} from "../domain/skill-discovery.js";
import type { ToolCallInput } from "./tools.js";

export interface SkillDiscoveryAuthority {
  authorize(input: ToolCallInput): Promise<ExecutionIdentity>;
}

export type SkillDiscoveryScope = { organization_id: string; actor_id: string };
export type SkillDiscoverySearchInput = SkillDiscoveryScope &
  SkillFindInput & { requesting_agent_id: string };
export type LoadedSkillText = {
  artifact?: Buffer;
  skillText: string;
  artifactDigest: string;
  contentDigest: string;
  requiresRuntimeDelivery: boolean;
};

export interface SkillDiscoveryPort {
  search(input: SkillDiscoverySearchInput, signal: AbortSignal): Promise<SkillSearchResult>;
  load(input: SkillDiscoveryScope & SkillLoadInput, signal: AbortSignal): Promise<LoadedSkillText>;
}
