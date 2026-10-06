import type { ManagedMCPServerWrite, ManagedMCPSecretWrite } from "./types.ts";

export type MCPDraft = { id: string; command: string; args: string[]; env: Array<{ name: string; value: string }>; secret_env?: Array<{ name: string } & ManagedMCPSecretWrite> };
const size = (value: string) => new TextEncoder().encode(value).length;

// Textareas normalize CRLF/CR to LF. Preserve untouched text and its line endings.
export function editMultiline(previous: string, next: string): string {
  const units = previous.match(/\r\n|[\s\S]/g) ?? [];
  const normalized = units.map((unit) => unit === "\r\n" || unit === "\r" ? "\n" : unit).join("");
  let start = 0;
  while (start < normalized.length && start < next.length && normalized[start] === next[start]) start++;
  let end = normalized.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && normalized[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  const newline = previous.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  return units.slice(0, start).join("") + next.slice(start, nextEnd).replaceAll("\n", newline) + units.slice(end).join("");
}

export function managedMCPInput(form: FormData): ManagedMCPServerWrite[] {
  const raw: unknown = JSON.parse(String(form.get("managed_mcp") ?? "[]"));
  if (!Array.isArray(raw) || raw.length > 8) throw new Error("A template can have at most 8 MCP servers.");
  const seen = new Set<string>();
  const servers = (raw as MCPDraft[]).map((draft, index) => {
    const label = `MCP server ${index + 1}`;
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(draft.id)) throw new Error(`${label}: Server ID must use 1-16 lowercase letters, digits or hyphens, starting with a letter.`);
    if (seen.has(draft.id)) throw new Error(`Duplicate server ID: ${draft.id}`);
    seen.add(draft.id);
    bounded(draft.command, 4096, `${label} command`);
    if (!draft.command.trim()) throw new Error(`${label}: Command is required.`);
    if (!Array.isArray(draft.args) || draft.args.length > 64) throw new Error(`${label}: At most 64 arguments are allowed.`);
    draft.args.forEach((argument) => bounded(argument, 8192, `${label} argument`));
    const seenNames = new Set<string>();
    const env = environment(draft.env, label, seenNames);
    const secretEntries = draft.secret_env ?? [];
    if (!Array.isArray(secretEntries) || draft.env.length + secretEntries.length > 64) throw new Error(`${label}: At most 64 environment variables are allowed.`);
    const secret_env = Object.fromEntries(secretEntries.map((item) => {
      environmentName(item.name, label, seenNames);
      if ("keep" in item) {
        if (item.keep !== true || "value" in item) throw new Error(`${label}: Invalid secret action.`);
        return [item.name, { keep: true }];
      }
      bounded(item.value, 8192, `${label} secret value`);
      return [item.name, { value: item.value }];
    })) as Record<string, ManagedMCPSecretWrite>;
    const server = { id: draft.id, command: draft.command, args: draft.args, env, ...(secretEntries.length ? { secret_env } : {}) };
    if (size(JSON.stringify(server)) > 32768) throw new Error(`${label}: Configuration exceeds 32 KiB.`);
    return server;
  });
  if (size(JSON.stringify(servers)) > 65536) throw new Error("MCP configuration exceeds 64 KiB.");
  return servers;
}

function environment(values: MCPDraft["env"], label: string, seen: Set<string>): Record<string, string> {
  if (!Array.isArray(values) || values.length > 64) throw new Error(`${label}: At most 64 environment variables are allowed.`);
  for (const item of values) {
    environmentName(item.name, label, seen);
    bounded(item.value, 8192, `${label} environment value`);
  }
  return Object.fromEntries(values.map(({ name, value }) => [name, value]));
}

function environmentName(name: string, label: string, seen: Set<string>) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error(`${label}: Invalid environment variable name.`);
  if (name === "HOME" || name === "PATH" || name.startsWith("ANTNEST_")) throw new Error(`${label}: ${name} is reserved by Runtime.`);
  if (seen.has(name)) throw new Error(`${label}: Duplicate environment variable ${name}.`);
  seen.add(name);
}

function bounded(value: string, maximum: number, label: string) {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value)) throw new Error(`${label}: Invalid text.`);
  if (value.includes("\0")) throw new Error(`${label}: NUL characters are not allowed.`);
  if (size(value) > maximum) throw new Error(`${label}: Maximum ${maximum} bytes.`);
}
