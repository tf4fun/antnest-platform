import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { z } from "zod";

const commandName = /^[^\s/]+$/u;
export const availableCommandsSchema = z.array(z.strictObject({
  name: z.string().min(1).regex(commandName),
  description: z.string(),
  input: z.strictObject({ hint: z.string() }).optional(),
})).refine((commands) => new Set(commands.map(({ name }) => name)).size === commands.length);

export type WorkspaceCommand = z.infer<typeof availableCommandsSchema>[number];

export function projectSkillCommands(commands: readonly AvailableCommand[]): WorkspaceCommand[] {
  return projectAvailableCommands(commands).filter((command) => /^skill:(system|personal):[^\s/:\\\p{Cc}]{1,128}$/u.test(command.name));
}

export function initialSkillCommands(meta: Record<string, unknown> | null | undefined): WorkspaceCommand[] {
  const value = meta?.["antnest.dev/skill-commands"];
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("version" in value) || value.version !== 1 || !("commands" in value)) return [];
  const parsed = availableCommandsSchema.safeParse(value.commands);
  return parsed.success ? projectSkillCommands(parsed.data) : [];
}

// Project public presentation fields only. ACP extension metadata stays server-side.
export function projectAvailableCommands(commands: readonly AvailableCommand[]): WorkspaceCommand[] {
  const names = new Set<string>();
  return commands.flatMap((command) => {
    if (!commandName.test(command.name) || names.has(command.name)) return [];
    names.add(command.name);
    return [{ name: command.name, description: command.description,
      ...(command.input ? { input: { hint: command.input.hint } } : {}) }];
  });
}
