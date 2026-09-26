import type { ListSessionsResponse } from "@agentclientprotocol/sdk";
import type { AgentView } from "../protocol/agent-view-delta.ts";
import { controlCatalogue, isReservedControlName, parseControlCommand,
  type ControlRequest, type ControlResult } from "../protocol/workspace-commands.ts";

export type ControlPort = {
  view(sessionId: string | null): Promise<AgentView>;
  sessions(cursor?: string): Promise<ListSessionsResponse>;
  configure(sessionId: string, configId: string, value: string, token: string): Promise<unknown>;
  cancel(sessionId: string, operationId: string, runId: string): Promise<unknown>;
  fork(sessionId: string): Promise<{ sessionId: string }>;
  forkSupported: boolean;
};
export class ControlError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 422) { super(message); this.code = code; this.status = status; }
}

export async function executeControlCommand(input: ControlRequest, port: ControlPort): Promise<ControlResult> {
  const command = parseControlCommand(input.text);
  if (!command) throw new ControlError("unknown_command", "Unknown workspace command. Use /help.");
  const { name, argument } = command;
  if (/[\r\n]/u.test(argument)) throw new ControlError("invalid_command", "Commands accept a single line of arguments.");
  if (argument && ["new", "status", "usage", "fork", "stop"].includes(name))
    throw new ControlError("invalid_command", `/${name} does not accept arguments.`);
  const view = await port.view(input.sessionId);
  const selected = view.selectedView;
  const catalogue = controlCatalogue(view, port.forkSupported);
  const native = (selected?.availableCommands ?? []).filter((item) => !isReservedControlName(item.name));
  const result = (text: string, extra: Omit<Partial<ControlResult>, "command" | "text"> = {}): ControlResult =>
    ({ command: name, text: text.length > 65536 ? `${text.slice(0, 65480)}\n… More results omitted.` : text, ...extra });
  if (name === "help") {
    const list = [...catalogue, ...native].filter((item) => !argument || item.name === argument.replace(/^\//u, ""));
    if (!list.length) throw new ControlError("command_unavailable", "Command is not available in this conversation.");
    return result(list.map((item) => `/${item.name}${item.input ? ` ${item.input.hint}` : ""} — ${item.description}`).join("\n"));
  }
  if (name === "new") return result("New conversation. Send a message to begin.", { selection: { sessionId: null } });
  if (name === "status") {
    const settings = selectOptions(view).map((option) => `${option.name}: ${option.currentValue}`);
    return result([`Workspace: ${view.availability}`, `Conversation: ${selected?.title ?? input.sessionId ?? "New conversation"}`,
      ...(input.sessionId ? [`Session: ${input.sessionId}`] : []),
      `Active session: ${view.activeSessionId ?? "None"}`, ...settings].join("\n"));
  }
  if (name === "sessions" || name === "resume" && !argument) {
    const page = await port.sessions(argument || undefined);
    return result([page.sessions.length ? "Conversations:" : "No conversations on this page.",
      ...page.sessions.map((item) => `${item.title || "Untitled"}\n/resume ${item.sessionId}`),
      ...(page.nextCursor ? [`Next page: /sessions ${page.nextCursor}`] : [])].join("\n"));
  }
  if (name === "resume") {
    if (argument.length > 200 || /[\s/\\\x00-\x1f\x7f]/u.test(argument))
      throw new ControlError("invalid_command", "Use /resume with an exact Session ID.");
    await port.view(argument);
    return result("Conversation opened.", { selection: { sessionId: argument } });
  }
  if (!input.sessionId || !selected)
    throw new ControlError("session_required", "Open a conversation before using this command.");
  if (name === "usage") {
    const usage = selected.usage;
    const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const cost = record(usage?.cost) ? usage.cost : null;
    return result([selected.historyState === "ready" ? "Reported usage:" : "Last known usage (history unavailable):",
      finite(usage?.used) && finite(usage?.size) ? `Context: ${usage!.used} / ${usage!.size} tokens` : "Context: Not reported",
      finite(cost?.amount) && typeof cost?.currency === "string" && /^[A-Z]{3}$/u.test(cost.currency)
        ? `Cost: ${cost.currency} ${cost.amount}` : "Cost: Not reported"].join("\n"));
  }
  if (name === "stop") {
    const operation = view.operations.find((item) => item.sessionId === input.sessionId &&
      item.operationId === input.operationId && item.runId === input.expectedRunId &&
      !["completed", "failed", "cancelled"].includes(item.phase));
    if (!operation || !input.operationId || !input.expectedRunId)
      throw new ControlError("operation_conflict", "The observed operation is no longer available. Refresh before stopping.", 409);
    await port.cancel(input.sessionId, input.operationId, input.expectedRunId);
    return result("Stop requested. Waiting for the operation to finish.");
  }
  if (name === "fork") {
    if (!port.forkSupported || selected.historyState !== "ready")
      throw new ControlError("command_unavailable", "Conversation branching is unavailable.");
    if (view.activeSessionId === input.sessionId || view.operations.some((item) => item.sessionId === input.sessionId &&
      !["completed", "failed", "cancelled"].includes(item.phase)))
      throw new ControlError("session_busy", "Wait for the running operation before branching.", 409);
    const fork = await port.fork(input.sessionId);
    return result("Conversation branched.", { selection: { sessionId: fork.sessionId } });
  }
  const category = { model: "model", mode: "mode", thinking: "thought_level" }[name];
  const option = selected.historyState === "ready" ? selectOptions(view).find((item) => item.category === category) : undefined;
  if (!option) throw new ControlError("command_unavailable", `/${name} is not available for this conversation.`);
  const choices = option.options;
  if (!argument) return result([`${option.name}: ${option.currentValue}`,
    ...choices.map((choice) => `/${name} ${choice.value} — ${choice.name}`)].join("\n"));
  const exactValue = choices.find((choice) => choice.value === argument);
  const matchingNames = choices.filter((choice) => choice.name === argument);
  const value = exactValue?.value ?? (matchingNames.length === 1 ? matchingNames[0]!.value : undefined);
  if (!value) throw new ControlError("invalid_command_value", `Use /${name} to list exact choices.`);
  if (!input.expectedConfigurationToken)
    throw new ControlError("configuration_conflict", "Refresh the configuration before changing it.", 409);
  await port.configure(input.sessionId, option.id, value, input.expectedConfigurationToken);
  return result(`${option.name} updated. New settings apply to subsequent messages.`, { configurationChanged: true });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function selectOptions(view: AgentView) {
  return (view.selectedView?.configOptions ?? []).flatMap((option) => {
    if (option.type !== "select" || typeof option.id !== "string" || typeof option.name !== "string" ||
      typeof option.currentValue !== "string" || !Array.isArray(option.options)) return [];
    const options = option.options.flatMap((item: unknown) => record(item) && Array.isArray(item.options) ? item.options : [item])
      .filter((item: unknown): item is { name: string; value: string } =>
        record(item) && typeof item.name === "string" && typeof item.value === "string");
    return [{ id: option.id, name: option.name, currentValue: option.currentValue, category: option.category, options }];
  });
}
