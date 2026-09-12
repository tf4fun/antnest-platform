import type { ContentBlock } from "./types.js";

type CommandLocale = "en" | "zh";
export type SessionCommand = { name: keyof typeof registry; locale: CommandLocale };

const registry = {
  help: {
    aliases: ["帮助"],
    description: "Show available commands (also /帮助)",
    execute: help,
  },
} as const;

export function availableCommands(): Array<{ name: string; description: string }> {
  return Object.entries(registry).map(([name, { description }]) => ({ name, description }));
}

export function matchCommand(prompt: readonly ContentBlock[]): SessionCommand | undefined {
  const block = prompt.find(
    (item) => item.type === "text" && typeof item.text === "string" && item.text.trim() !== "",
  );
  if (block === undefined || typeof block.text !== "string") return undefined;
  const token = block.text.trimStart().split(/\s/u, 1)[0];
  for (const name of Object.keys(registry) as Array<keyof typeof registry>) {
    if (token === `/${name}`) return { name, locale: "en" };
    if (registry[name].aliases.some((alias) => token === `/${alias}`))
      return { name, locale: "zh" };
  }
  return undefined;
}

export function commandReply(command: SessionCommand): ContentBlock[] {
  return [{ type: "text", text: registry[command.name].execute(command.locale) }];
}

function help(locale: CommandLocale): string {
  const list = availableCommands()
    .map((command) => `/${command.name} - ${command.description}`)
    .join("\n");
  return locale === "zh"
    ? `可用命令：\n${list}\n\n也可使用 /帮助。请直接用自然语言描述任务；帮助命令不会处理附加的任务内容或文件。`
    : `Available commands:\n${list}\n\nDescribe tasks in natural language. Help does not process appended task instructions or attachments.`;
}
