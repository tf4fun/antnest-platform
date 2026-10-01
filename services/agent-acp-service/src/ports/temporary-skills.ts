import type { RunExecutionSnapshot } from "../domain/types.js";
import type { LoadedSkillText } from "./skill-discovery.js";

export type TemporaryAgentScope = { organizationId: string; agentId: string };
export type TemporarySkillScope = TemporaryAgentScope & {
  runId: string;
  executionId: string;
  mcpEndpoint: string;
};
export type TemporaryInstallInput = {
  runId: string;
  snapshot: RunExecutionSnapshot;
  signal: AbortSignal;
};
export type TemporarySkillFiles = { path: string; unpacked_size: number };
export interface TemporarySkillStore {
  reserve(input: TemporaryInstallInput): Promise<TemporarySkillScope>;
  forRun(runId: string, signal: AbortSignal): Promise<TemporarySkillScope | null>;
  forAgent(scope: TemporaryAgentScope, signal: AbortSignal): Promise<TemporarySkillScope[]>;
  next(after: string | null, signal: AbortSignal): Promise<TemporarySkillScope | null>;
  released(scope: TemporarySkillScope): Promise<void>;
}
export interface TemporarySkillRuntime {
  install(
    scope: TemporarySkillScope,
    loaded: LoadedSkillText,
    signal: AbortSignal,
  ): Promise<TemporarySkillFiles>;
  cleanup(scope: TemporarySkillScope, signal: AbortSignal): Promise<void>;
}
