import { z } from "zod";
import type { WorkspaceCommand } from "./available-commands.ts";

const definitions = {
  help: { description: "Show available commands", hint: "[command]", aliases: ["帮助"] },
  status: { description: "Show workspace and conversation status" },
  usage: { description: "Show reported context usage and cost", session: true },
  new: { description: "Open a new conversation draft" },
  sessions: { description: "List conversations", hint: "[cursor]" },
  resume: { description: "Open an existing conversation", hint: "[sessionId]" },
  fork: { description: "Branch this conversation", session: true },
  model: { description: "Show or change the conversation model", hint: "[value]", category: "model" },
  mode: { description: "Show or change the conversation mode", hint: "[value]", category: "mode" },
  thinking: { description: "Show or change reasoning effort", hint: "[value]", category: "thought_level" },
  stop: { description: "Stop this conversation's current operation", session: true },
} as const;
export type ControlName = keyof typeof definitions;
type Definition = { description: string; hint?: string; aliases?: readonly string[]; session?: boolean; category?: string };
const entries = Object.entries(definitions) as [ControlName, Definition][];
const names = new Map(entries.flatMap(([name, definition]) =>
  [name, ...(definition.aliases ?? [])].map((alias) => [alias, name] as const)));

export function parseControlCommand(text: string): { name: ControlName; argument: string } | null {
  const match = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text);
  const name = match ? names.get(match[1]!) : undefined;
  return name ? { name, argument: match?.[2]?.trim() ?? "" } : null;
}

export function isReservedControlName(name: string): boolean { return names.has(name); }

export function controlCatalogue(view: { selectedView?: { historyState: string;
  configOptions?: readonly { category?: unknown; type?: unknown }[] } | null } | null, forkSupported: boolean): WorkspaceCommand[] {
  const selected = view?.selectedView;
  return entries.flatMap(([name, definition]) => {
    if (definition.session && !selected) return [];
    if (name === "fork" && (!forkSupported || selected?.historyState !== "ready")) return [];
    if (definition.category && (selected?.historyState !== "ready" ||
      !selected.configOptions?.some((option) => option.category === definition.category && option.type === "select"))) return [];
    return [{ name, description: definition.description,
      ...(definition.hint ? { input: { hint: definition.hint } } : {}) }];
  });
}

const id = z.string().min(1).max(200).regex(/^[^/\\\x00-\x1f\x7f]+$/u);
export const controlRequestSchema = z.strictObject({
  text: z.string().min(1).max(8192), sessionId: id.nullable(),
  expectedConfigurationToken: z.string().min(1).max(4096).optional(),
  expectedRunId: id.optional(), operationId: id.optional(),
});
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export const controlResultSchema = z.strictObject({
  command: z.enum(Object.keys(definitions) as [ControlName, ...ControlName[]]),
  text: z.string().max(65536), selection: z.strictObject({ sessionId: id.nullable() }).optional(),
  configurationChanged: z.literal(true).optional(),
});
export type ControlResult = z.infer<typeof controlResultSchema>;
