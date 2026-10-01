import { DomainError } from "./errors.js";
import type { RuntimeInformation } from "./runtime-information.js";
import type { ContentBlock } from "./types.js";

export type SkillCommand = { name: string; description: string; input: { hint: string } };
const validName = /^[^\s/:\\\p{Cc}]{1,128}$/u;

export function skillCommands(skills: RuntimeInformation["skills"]): SkillCommand[] {
  const names = skills.map((skill) => `skill:${skill.source}:${skill.name}`);
  return skills.flatMap((skill, index) => {
    const name = names[index]!;
    if (!validName.test(skill.name) || names.indexOf(name) !== names.lastIndexOf(name)) return [];
    return [
      {
        name,
        description: skill.description,
        input: { hint: `Task for this ${skill.source === "system" ? "preset" : "personal"} Skill` },
      },
    ];
  });
}

export function skillInvocation(prompt: readonly ContentBlock[]):
  | {
      source: "system" | "personal";
      name: string;
      task: string;
      textIndex: number;
    }
  | undefined {
  const textIndex = prompt.findIndex(
    (block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
  );
  const block = prompt[textIndex];
  if (
    block?.type !== "text" ||
    typeof block.text !== "string" ||
    !block.text.trimStart().startsWith("/skill:")
  )
    return undefined;
  const match = /^\/skill:(system|personal):([^\s]+)(?:\s+([\s\S]*))?$/u.exec(block.text.trim());
  if (match === null || !validName.test(match[2]!))
    throw new DomainError("invalid_params", "Invalid Skill command");
  const task = match[3]?.trim() ?? "";
  if (task.length === 0)
    throw new DomainError("invalid_params", "Enter a task after the Skill command");
  return { source: match[1] as "system" | "personal", name: match[2]!, task, textIndex };
}
