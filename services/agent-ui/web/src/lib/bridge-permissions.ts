import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PendingPermission } from "./permissions.ts";
import type { BridgeHttpClient } from "./workspace-api-client.ts";

type PermissionApi = Pick<BridgeHttpClient, "decidePermission">;
type Permission = { generation: number; request: RequestPermissionRequest };

export class BridgePermissionStore {
  private readonly agentId: string;
  private readonly api: PermissionApi;
  private readonly entries = new Map<string, Permission>();
  private readonly inFlight = new Map<string, { generation: number; optionId: string; task: Promise<void> }>();
  private readonly decided = new Map<string, number>();

  constructor(agentId: string, api: PermissionApi) {
    this.agentId = agentId;
    this.api = api;
  }

  get pending(): PendingPermission[] {
    return [...this.entries].map(([id, value]) => ({ id, request: structuredClone(value.request) }));
  }

  observe(values: readonly unknown[]): void {
    const next = new Map<string, Permission>();
    for (const raw of values) {
      const parsed = parsePermission(raw);
      if (next.has(parsed.id)) throw new Error("Duplicate Bridge permission ID");
      next.set(parsed.id, { generation: parsed.generation, request: parsed.request });
    }
    this.entries.clear();
    for (const [id, value] of next) this.entries.set(id, value);
    for (const [id, generation] of this.decided)
      if (next.get(id)?.generation !== generation) this.decided.delete(id);
  }

  async decide(id: string, optionId: string, signal?: AbortSignal): Promise<void> {
    const current = this.entries.get(id);
    if (!current) throw new Error("Permission request is no longer current");
    if (!current.request.options.some((option) => option.optionId === optionId))
      throw new Error("Permission option was not offered");
    if (this.decided.get(id) === current.generation)
      throw new Error("Permission was already decided");
    const existing = this.inFlight.get(id);
    if (existing?.generation === current.generation) {
      if (existing.optionId !== optionId)
        throw new Error("Permission decision is already in progress");
      return existing.task;
    }
    const task = (async () => {
      await this.api.decidePermission(this.agentId, id, current.generation, optionId, signal);
      if (this.entries.get(id)?.generation !== current.generation)
        throw new Error("Permission request is no longer current");
      this.decided.set(id, current.generation);
    })();
    this.inFlight.set(id, { generation: current.generation, optionId, task });
    try { await task; }
    finally {
      if (this.inFlight.get(id)?.task === task) this.inFlight.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.decided.clear();
  }
}

function parsePermission(raw: unknown): { id: string; generation: number; request: RequestPermissionRequest } {
  if (!isRecord(raw) || typeof raw.permissionId !== "string" || !raw.permissionId ||
    typeof raw.sessionId !== "string" || !raw.sessionId ||
    !Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0 ||
    !isRecord(raw.toolCall) || typeof raw.toolCall.toolCallId !== "string" ||
    !raw.toolCall.toolCallId || !Array.isArray(raw.options) || raw.options.length === 0)
    throw new Error("Invalid Bridge permission");
  const options = raw.options.map((option) => {
    if (!isRecord(option) || typeof option.optionId !== "string" || !option.optionId ||
      typeof option.name !== "string" || !option.name || !optionKind(option.kind))
      throw new Error("Invalid Bridge permission option");
    return { optionId: option.optionId, name: option.name, kind: option.kind };
  });
  const toolCall = raw.toolCall;
  if ((toolCall.title !== undefined && typeof toolCall.title !== "string") ||
    (toolCall.kind !== undefined && typeof toolCall.kind !== "string"))
    throw new Error("Invalid Bridge permission tool call");
  return {
    id: raw.permissionId,
    generation: raw.generation as number,
    request: {
      sessionId: raw.sessionId,
      toolCall: {
        toolCallId: toolCall.toolCallId as string,
        ...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
        ...(toolKind(toolCall.kind) ? { kind: toolCall.kind } : {}),
        ...(toolCall.rawInput === undefined ? {} : { rawInput: toolCall.rawInput }),
      },
      options,
    },
  };
}

function optionKind(value: unknown): value is "allow_once" | "allow_always" | "reject_once" | "reject_always" {
  return value === "allow_once" || value === "allow_always" ||
    value === "reject_once" || value === "reject_always";
}

function toolKind(value: unknown): value is NonNullable<RequestPermissionRequest["toolCall"]["kind"]> {
  return value === "read" || value === "edit" || value === "delete" ||
    value === "move" || value === "search" || value === "execute" ||
    value === "think" || value === "fetch" || value === "switch_mode" ||
    value === "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
