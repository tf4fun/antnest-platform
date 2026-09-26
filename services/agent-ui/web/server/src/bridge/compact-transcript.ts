import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionUpdate,
  ToolCallUpdate,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import type { DeliveredBatch } from "./delivery.ts";
import { projectAvailableCommands, type WorkspaceCommand } from "../protocol/available-commands.ts";

export type ProcessItem = {
  id: string;
  kind: "thought" | "tool" | "plan" | "notice";
  summary: string;
  status: "pending" | "running" | "completed" | "failed" | "unknown";
  content: ContentBlock[];
  contentCursor: null;
  toolSections?: { inputIndex?: number; outputIndex?: number; detailStartIndex: number };
};

export type TranscriptTurn = {
  turnId: string;
  outcome: "running" | "completed" | "failed" | "cancelled" | "unknown";
  prompt: ContentBlock[];
  finalResponse: ContentBlock[];
  contentCursor: null;
  processVersion: number;
  processCount: number;
  process: ProcessItem[];
};

export type SessionUsage = {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
};

export type SessionInfo = { title: string | null; updatedAt: string | null };

type ToolFields = Pick<ToolCallUpdate, "rawInput" | "rawOutput" | "content">;
type StoredProcess = Omit<ProcessItem, "content"> & {
  content: ContentBlock[];
  contentBytes: number;
  tool?: ToolFields;
  toolBytes?: Partial<Record<keyof ToolFields, number>>;
  bytes: number;
};

type StoredTurn = {
  turnId: string;
  contentRevision: number;
  outcome: TranscriptTurn["outcome"];
  prompt: ContentBlock[];
  answers: Map<string, ContentBlock[]>;
  process: StoredProcess[];
  processIndex: Map<string, number>;
  processVersion: number;
  processChanges: Array<{ version: number; index: number }>;
  processChangeRevision: number;
};

export class CompactTranscript {
  private usedBytes = 0;
  private turnRevision = 0;
  private readonly order: string[] = [];
  private readonly records = new Map<string, StoredTurn>();
  private currentConfigOptions: SessionConfigOption[] = [];
  private currentCommands: WorkspaceCommand[] = [];
  private configUpdated = false;
  private configSequence = 0;
  private currentUsage: SessionUsage | null = null;
  private currentSessionInfo: SessionInfo = { title: null, updatedAt: null };
  public apply(batch: DeliveredBatch<SessionUpdate>): this {
    for (const update of batch.updates) {
      this.applyUpdate(batch, update);
      if (["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"].includes(update.sessionUpdate))
        this.turnRevision++;
    }
    return this;
  }

  public setOutcome(turnId: string, outcome: TranscriptTurn["outcome"]): void {
    const turn = this.records.get(turnId);
    if (turn !== undefined && turn.outcome !== outcome) {
      this.turnRevision++;
      this.usedBytes += jsonBytes(outcome) - jsonBytes(turn.outcome);
      turn.outcome = outcome;
      if (outcome !== "running" && outcome !== "unknown") {
        this.usedBytes -= turn.processChanges.reduce((sum, change) => sum + jsonBytes(change), 0);
        turn.processChanges.length = 0;
      }
    }
  }

  public setInitialConfigOptions(
    options: SessionConfigOption[] | null | undefined,
  ): void {
    if (this.configUpdated) return;
    const projected = safeConfigOptions(options ?? []);
    this.currentConfigOptions = projected;
  }

  public get configOptions(): SessionConfigOption[] {
    return structuredClone(this.currentConfigOptions);
  }

  public get availableCommands(): WorkspaceCommand[] {
    return structuredClone(this.currentCommands);
  }

  public applyCommandsNotification(commands: readonly AvailableCommand[]): boolean {
    const projected = projectAvailableCommands(commands);
    if (JSON.stringify(projected) === JSON.stringify(this.currentCommands)) return false;
    this.currentCommands = projected;
    return true;
  }

  public get configurationSequence(): number {
    return this.configSequence;
  }

  public applyConfigurationResponse(
    options: SessionConfigOption[],
    startedAt: number,
  ): boolean {
    if (startedAt !== this.configSequence) return false;
    const projected = safeConfigOptions(options);
    this.currentConfigOptions = projected;
    this.configUpdated = true;
    this.configSequence += 1;
    return true;
  }

  public applyConfigurationNotification(options: SessionConfigOption[]): void {
    this.applyConfigurationResponse(options, this.configSequence);
  }

  public applySessionInfoNotification(
    update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
  ): boolean {
    const projected = projectSessionInfo(this.currentSessionInfo, update);
    if (projected.title === this.currentSessionInfo.title && projected.updatedAt === this.currentSessionInfo.updatedAt) return false;
    this.currentSessionInfo = projected;
    return true;
  }

  public get usage(): SessionUsage | null {
    return this.currentUsage === null
      ? null
      : structuredClone(this.currentUsage);
  }

  public get sessionInfo(): SessionInfo {
    return { ...this.currentSessionInfo };
  }

  public get conversationRevision(): number { return this.turnRevision; }

  public get turnCount(): number {
    return this.order.length;
  }

  public get estimatedRetainedBytes(): number {
    return (
      this.usedBytes +
      metadataBytes(this.currentConfigOptions, this.currentUsage, this.currentSessionInfo,
        this.currentCommands)
    );
  }

  public pageBefore(
    before: number,
    limit = 20,
    includeProcess = true,
    cloneContent = true,
  ): {
    items: TranscriptTurn[];
    nextBefore: number | null;
  } {
    if (
      !Number.isSafeInteger(before) ||
      before < 0 ||
      before > this.order.length ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new RangeError("Invalid turn page boundary");
    const start = Math.max(0, before - limit);
    return {
      items: this.order
        .slice(start, before)
        .map((id) => this.materialize(this.records.get(id)!, includeProcess, cloneContent)),
      nextBefore: start === 0 ? null : start,
    };
  }

  public pageAfter(
    after: number,
    limit = 20,
    includeProcess = true,
    cloneContent = true,
  ): {
    items: TranscriptTurn[];
    nextAfter: number | null;
  } {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > this.order.length ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new RangeError("Invalid turn page boundary");
    const end = Math.min(this.order.length, after + limit);
    return {
      items: this.order
        .slice(after, end)
        .map((id) => this.materialize(this.records.get(id)!, includeProcess, cloneContent)),
      nextAfter: end === this.order.length ? null : end,
    };
  }

  public turns(): TranscriptTurn[] {
    return this.order.map((id) => this.materialize(this.records.get(id)!));
  }

  public turnById(turnId: string, includeProcess = true, cloneContent = true): TranscriptTurn | null {
    const turn = this.records.get(turnId);
    return turn === undefined ? null : this.materialize(turn, includeProcess, cloneContent);
  }

  public processInfo(
    turnId: string,
  ): { version: number; count: number } | null {
    const turn = this.records.get(turnId);
    return turn === undefined
      ? null
      : { version: turn.processVersion, count: turn.process.length };
  }

  public processChanges(turnId: string): { fromVersion: number; indices: number[] } | null {
    const turn = this.records.get(turnId);
    if (turn === undefined) return null;
    const first = turn.processChanges[0];
    return { fromVersion: first === undefined ? turn.processVersion : first.version - 1,
      indices: [...new Set(turn.processChanges.map((change) => change.index))].sort((a, b) => a - b) };
  }

  public processChangedInLatestRevision(turnId: string): boolean {
    return this.records.get(turnId)?.processChangeRevision === this.turnRevision;
  }

  public turnContentRevision(turnId: string): number | null {
    return this.records.get(turnId)?.contentRevision ?? null;
  }

  public processItem(
    turnId: string,
    index: number,
  ): Readonly<ProcessItem> | null {
    const item = this.records.get(turnId)?.process[index];
    return item === undefined ? null : materializeProcess(item);
  }

  // The pager may borrow content synchronously, then clone only the public window.
  // Default readers retain independent snapshots; borrowed blocks must never escape.
  private materialize(turn: StoredTurn, includeProcess = true, cloneContent = true): TranscriptTurn {
    const answers = [...turn.answers.values()].flat();
    return {
      turnId: turn.turnId,
      outcome: turn.outcome,
      prompt: cloneContent ? structuredClone(turn.prompt) : turn.prompt,
      finalResponse: cloneContent ? structuredClone(answers) : answers,
      contentCursor: null,
      processVersion: turn.processVersion,
      processCount: turn.process.length,
      process: includeProcess ? turn.process.map(materializeProcess) : [],
    };
  }

  private applyUpdate(
    batch: DeliveredBatch<SessionUpdate>,
    update: SessionUpdate,
  ): void {
    switch (update.sessionUpdate) {
      case "available_commands_update": {
        this.applyCommandsNotification(update.availableCommands);
        return;
      }
      case "usage_update": {
        this.currentUsage = projectUsage(this.currentUsage, update);
        return;
      }
      case "config_option_update": {
        this.currentConfigOptions = safeConfigOptions(update.configOptions);
        this.configUpdated = true;
        this.configSequence += 1;
        return;
      }
      case "session_info_update": {
        this.currentSessionInfo = projectSessionInfo(this.currentSessionInfo, update);
        return;
      }
      case "user_message_chunk": {
        const turn = this.turn(batch.runId ?? update.messageId ?? batch.messageId);
        turn.prompt.push(structuredClone(update.content));
        turn.contentRevision += 1;
        this.usedBytes += jsonBytes(update.content);
        return;
      }
      case "agent_message_chunk": {
        const turn = this.turn(
          batch.runId ?? update.messageId ?? batch.messageId,
        );
        const id = update.messageId ?? batch.messageId;
        if (!turn.answers.has(id)) this.usedBytes += jsonBytes(id);
        const content = turn.answers.get(id) ?? [];
        content.push(structuredClone(update.content));
        turn.answers.set(id, content);
        turn.contentRevision += 1;
        this.usedBytes += jsonBytes(update.content);
        return;
      }
      case "agent_thought_chunk": {
        const turn = this.turn(
          batch.runId ?? update.messageId ?? batch.messageId,
        );
        const id = `thought-${update.messageId ?? batch.messageId}`;
        this.upsertProcess(
          turn,
          id,
          "thought",
          "Thought",
          "completed",
          update.content,
        );
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const turn = this.turn(batch.runId ?? batch.messageId);
        if (update.sessionUpdate === "tool_call") this.moveInterimAnswers(turn);
        this.updateTool(turn, update);
        return;
      }
      case "plan": {
        const turn = this.turn(batch.runId ?? batch.messageId);
        this.upsertProcess(
          turn,
          "plan",
          "plan",
          "Plan",
          "completed",
          { type: "text", text: JSON.stringify(update.entries) },
          false,
        );
        return;
      }
      default:
        return;
    }
  }

  private turn(id: string): StoredTurn {
    let turn = this.records.get(id);
    if (turn === undefined) {
      turn = {
        turnId: id,
        contentRevision: 0,
        outcome: "unknown",
        prompt: [],
        answers: new Map(),
        process: [],
        processIndex: new Map(),
        processVersion: 0,
        processChanges: [],
        processChangeRevision: -1,
      };
      this.usedBytes += jsonBytes(id) + jsonBytes(turn.outcome);
      this.records.set(id, turn);
      this.order.push(id);
    }
    return turn;
  }

  private moveInterimAnswers(turn: StoredTurn): void {
    if (turn.answers.size > 0) turn.contentRevision += 1;
    for (const [messageId, content] of turn.answers) {
      this.usedBytes -= jsonBytes(messageId) + content.reduce((bytes, block) => bytes + jsonBytes(block), 0);
      this.upsertProcess(
        turn,
        `interim-${messageId}`,
        "notice",
        "Intermediate response",
        "completed",
        content,
      );
    }
    turn.answers.clear();
  }

  private updateTool(
    turn: StoredTurn,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  ): void {
    const id = `tool-${update.toolCallId}`;
    const index = turn.processIndex.get(id);
    const previous = index === undefined ? undefined : turn.process[index];
    const tool = { ...previous?.tool };
    const toolBytes = { ...previous?.toolBytes };
    for (const field of ["rawInput", "rawOutput", "content"] as const) {
      const value = update[field];
      if (value === undefined || value === null) continue;
      Object.assign(tool, { [field]: structuredClone(value) });
      toolBytes[field] = jsonBytes(value);
    }
    const item: StoredProcess = {
      id, kind: "tool", summary: update.title ?? previous?.summary ?? "Tool",
      status: update.status == null ? previous?.status ?? "unknown" : toolStatus(update.status),
      content: [], contentCursor: null, contentBytes: 0, tool, toolBytes, bytes: 0,
    };
    item.bytes = processMetadataBytes(item) + Object.values(toolBytes).reduce((sum, bytes) => sum + bytes, 0);
    this.storeProcess(turn, item);
  }

  private upsertProcess(
    turn: StoredTurn,
    id: string,
    kind: ProcessItem["kind"],
    summary: string,
    status: ProcessItem["status"],
    content?: ContentBlock | ContentBlock[],
    append = true,
  ): void {
    const index = turn.processIndex.get(id);
    const previous = index === undefined ? undefined : turn.process[index];
    const blocks = content === undefined ? [] : Array.isArray(content) ? content : [content];
    const next = append ? previous?.content ?? [] : [];
    for (const block of blocks) next.push(structuredClone(block));
    const contentBytes = (append ? previous?.contentBytes ?? 0 : 0) +
      blocks.reduce((bytes, block) => bytes + jsonBytes(block), 0);
    const item: StoredProcess = {
      id, kind, summary, status, content: next, contentBytes, contentCursor: null, bytes: 0,
    };
    item.bytes = processMetadataBytes(item) + contentBytes;
    this.storeProcess(turn, item);
  }

  private storeProcess(turn: StoredTurn, item: StoredProcess): void {
    const index = turn.processIndex.get(item.id);
    this.usedBytes += item.bytes - (index === undefined ? 0 : turn.process[index]!.bytes);
    if (index === undefined) {
      turn.processIndex.set(item.id, turn.process.length);
      turn.process.push(item);
    } else turn.process[index] = item;
    turn.processVersion += 1;
    turn.processChangeRevision = this.turnRevision + 1;
    if (turn.outcome === "running" || turn.outcome === "unknown") {
      const changedIndex = index ?? turn.process.length - 1;
      const firstChange = turn.processChanges[0];
      // Only one changing item is coalesced, so an older large tool is not
      // rematerialized on every unrelated small update.
      if (firstChange?.index !== changedIndex ||
        turn.processVersion - firstChange.version >= 8) {
        for (const change of turn.processChanges) this.usedBytes -= jsonBytes(change);
        const change = { version: turn.processVersion, index: changedIndex };
        turn.processChanges = [change];
        this.usedBytes += jsonBytes(change);
      }
    }
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function processMetadataBytes(item: StoredProcess): number {
  return jsonBytes({ id: item.id, kind: item.kind, summary: item.summary, status: item.status });
}

function materializeProcess(item: StoredProcess): ProcessItem {
  const hasInput = item.tool?.rawInput !== undefined;
  const hasOutput = item.tool?.rawOutput !== undefined;
  const content: ContentBlock[] = item.tool === undefined ? item.content : [
    ...(hasInput ? [{ type: "text" as const, text: `Input: ${JSON.stringify(item.tool.rawInput)}` }] : []),
    ...(hasOutput ? [{ type: "text" as const, text: `Output: ${JSON.stringify(item.tool.rawOutput)}` }] : []),
    ...(item.tool.content ?? []).flatMap((entry): ContentBlock[] => entry.type === "content"
      ? [entry.content] : [{ type: "text", text: JSON.stringify(entry) }]),
  ];
  return { id: item.id, kind: item.kind, summary: item.summary, status: item.status,
    content: structuredClone(content), contentCursor: null,
    ...(item.tool === undefined ? {} : { toolSections: {
      ...(hasInput ? { inputIndex: 0 } : {}),
      ...(hasOutput ? { outputIndex: hasInput ? 1 : 0 } : {}),
      detailStartIndex: Number(hasInput) + Number(hasOutput),
    } }) };
}

function metadataBytes(
  options: SessionConfigOption[],
  usage: SessionUsage | null,
  info: SessionInfo,
  commands: WorkspaceCommand[],
): number {
  return (
    Buffer.byteLength(JSON.stringify(options)) +
    Buffer.byteLength(JSON.stringify(usage)) +
    Buffer.byteLength(JSON.stringify(info)) +
    Buffer.byteLength(JSON.stringify(commands))
  );
}

function projectSessionInfo(
  previous: SessionInfo,
  update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
): SessionInfo {
  return {
    title: update.title === undefined ? previous.title
      : update.title === null ? null : update.title.slice(0, 512),
    updatedAt: update.updatedAt === undefined ? previous.updatedAt
      : update.updatedAt === null ? null : update.updatedAt.slice(0, 64),
  };
}

function safeConfigOptions(
  options: SessionConfigOption[],
): SessionConfigOption[] {
  return options.map((option): SessionConfigOption => {
    const common = {
      id: option.id,
      name: option.name,
      ...(option.description === undefined
        ? {}
        : { description: option.description }),
      ...(option.category === undefined ? {} : { category: option.category }),
    };
    if (option.type === "boolean")
      return { ...common, type: "boolean", currentValue: option.currentValue };
    const options =
      option.options.length === 0 || "value" in option.options[0]!
        ? (option.options as SessionConfigSelectOption[]).map((entry) => ({
            value: entry.value,
            name: entry.name,
            ...(entry.description === undefined
              ? {}
              : { description: entry.description }),
          }))
        : (option.options as SessionConfigSelectGroup[]).map((entry) => ({
            group: entry.group,
            name: entry.name,
            options: entry.options.map((item) => ({
              value: item.value,
              name: item.name,
              ...(item.description === undefined
                ? {}
                : { description: item.description }),
            })),
          }));
    return {
      ...common,
      type: "select",
      currentValue: option.currentValue,
      options,
    };
  });
}

function projectUsage(
  current: SessionUsage | null,
  update: UsageUpdate,
): SessionUsage | null {
  if (
    !Number.isSafeInteger(update.used) ||
    update.used < 0 ||
    !Number.isSafeInteger(update.size) ||
    update.size < 0
  )
    return current;
  const cost = sessionCost(update.cost) ?? current?.cost;
  return {
    used: update.used,
    size: update.size,
    ...(cost === undefined ? {} : { cost }),
  };
}

function sessionCost(value: unknown): SessionUsage["cost"] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { amount, currency } = value as Record<string, unknown>;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency)
  )
    return undefined;
  return { amount, currency };
}

function toolStatus(value: string | null | undefined): ProcessItem["status"] {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}
