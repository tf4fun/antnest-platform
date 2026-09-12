import type { JsonValue } from "../../domain/types.js";
import type { SessionEvent } from "../../ports/acp-application.js";
import type { ToolFileObservation } from "../../domain/tool-presentation.js";
import type { PlanEntry } from "../../domain/plan.js";
import type { ModelToolCall } from "../../ports/model.js";
import type { SessionConfigurationView } from "../../domain/session-configuration.js";

export type StoredSessionEvent = Record<string, unknown> & {
  kind: SessionEvent["kind"];
  rawOutputJson?: string;
  fileJson?: string;
  entriesJson?: string;
  toolCallsJson?: string;
  argumentsJson?: string;
  configurationJson?: string;
};

export function encodeSessionEvent(event: SessionEvent): StoredSessionEvent {
  if (event.kind === "configuration")
    return { kind: event.kind, configurationJson: JSON.stringify(event.configuration) };
  if (event.kind === "plan")
    return { kind: event.kind, entriesJson: JSON.stringify(event.entries) };
  if (event.kind === "agent_message" && event.toolCalls !== undefined) {
    const { toolCalls, ...rest } = event;
    return { ...rest, toolCallsJson: JSON.stringify(toolCalls) };
  }
  if (event.kind !== "tool_call") return event;
  const { rawOutput, file, arguments: arguments_, ...rest } = event;
  // JSON text preserves NUL and lone surrogates that PostgreSQL jsonb cannot represent.
  return {
    ...rest,
    ...(arguments_ === undefined ? {} : { argumentsJson: JSON.stringify(arguments_) }),
    ...(rawOutput === undefined ? {} : { rawOutputJson: JSON.stringify(rawOutput) }),
    ...(file === undefined ? {} : { fileJson: JSON.stringify(file) }),
  };
}

export function decodeSessionEvent(event: StoredSessionEvent): SessionEvent {
  if (event.kind === "configuration" && event.configurationJson !== undefined)
    return {
      kind: event.kind,
      configuration: JSON.parse(event.configurationJson) as SessionConfigurationView,
    };
  if (event.kind === "plan" && event.entriesJson !== undefined) {
    return { kind: "plan", entries: JSON.parse(event.entriesJson) as PlanEntry[] };
  }
  if (event.kind === "agent_message" && event.toolCallsJson !== undefined) {
    const { toolCallsJson, ...rest } = event;
    return { ...rest, toolCalls: JSON.parse(toolCallsJson) as ModelToolCall[] } as SessionEvent;
  }
  if (event.kind !== "tool_call") return event as SessionEvent;
  const { rawOutputJson, fileJson, argumentsJson, ...rest } = event;
  return {
    ...rest,
    ...(argumentsJson === undefined
      ? {}
      : { arguments: JSON.parse(argumentsJson) as Record<string, unknown> }),
    ...(rawOutputJson === undefined ? {} : { rawOutput: JSON.parse(rawOutputJson) as JsonValue }),
    ...(fileJson === undefined ? {} : { file: JSON.parse(fileJson) as ToolFileObservation }),
  } as SessionEvent;
}
