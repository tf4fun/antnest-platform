import type { ConnectionBinding } from "../domain/types.js";
import type { SkillCommand } from "../domain/skill-commands.js";

export interface SkillCommandsPort {
  read(
    binding: ConnectionBinding,
    signal: AbortSignal,
  ): Promise<{ executionId: string | null; commands: SkillCommand[] | null }>;
}
