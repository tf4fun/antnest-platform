import type {
  ContentBlock,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionUpdate,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import type { DeliveredBatch } from "./delivery.ts";

const defaultMaxBytes = 64 * 1024 * 1024;

export type ProcessItem = {
  id: string;
  kind: "thought" | "tool" | "plan" | "notice";
  summary: string;
  status: "pending" | "running" | "completed" | "failed" | "unknown";
  content: ContentBlock[];
  contentCursor: null;
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

type StoredTurn = {
  turnId: string;
  outcome: TranscriptTurn["outcome"];
  prompt: ContentBlock[];
  answers: Map<string, ContentBlock[]>;
  process: ProcessItem[];
  processIndex: Map<string, number>;
  processVersion: number;
};

export class HistoryCapacityError extends Error {
  public constructor() {
    super("History capacity exceeded");
    this.name = "HistoryCapacityError";
  }
}

export class CompactTranscript {
  private readonly maxBytes: number;
  private usedBytes = 0;
  private readonly order: string[] = [];
  private readonly records = new Map<string, StoredTurn>();
  private currentConfigOptions: SessionConfigOption[] = [];
  private configUpdated = false;
  private configSequence = 0;
  private currentUsage: SessionUsage | null = null;
  private currentSessionInfo: SessionInfo = { title: null, updatedAt: null };
  private liveLimitEnabled = false;
  private limited = false;
  private previewText = "";

  public constructor(maxBytes = defaultMaxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("History budget must be a positive safe integer");
    this.maxBytes = maxBytes;
  }

  public apply(batch: DeliveredBatch<SessionUpdate>): this {
    if (this.limited) {
      this.captureLimited(batch);
      return this;
    }
    const encoded = JSON.stringify(batch.updates);
    let nextConfig = this.currentConfigOptions;
    let nextUsage = this.currentUsage;
    let nextInfo = this.currentSessionInfo;
    for (const update of batch.updates) {
      if (update.sessionUpdate === "config_option_update")
        nextConfig = safeConfigOptions(update.configOptions);
      else if (update.sessionUpdate === "usage_update")
        nextUsage = projectUsage(nextUsage, update);
      else if (update.sessionUpdate === "session_info_update")
        nextInfo = projectSessionInfo(nextInfo, update);
    }
    if (
      encoded === undefined ||
      this.usedBytes +
        Buffer.byteLength(encoded) +
        metadataBytes(nextConfig, nextUsage, nextInfo) >
        this.maxBytes
    ) {
      if (this.liveLimitEnabled) {
        this.enterLimited();
        this.captureLimited(batch);
        return this;
      }
      throw new HistoryCapacityError();
    }
    this.usedBytes += Buffer.byteLength(encoded);
    for (const update of batch.updates) this.applyUpdate(batch, update);
    return this;
  }

  public enableLiveLimit(): void {
    this.liveLimitEnabled = true;
  }

  public limitLive(): boolean {
    if (!this.liveLimitEnabled) return false;
    if (!this.limited) this.enterLimited();
    return true;
  }

  public get isLimited(): boolean {
    return this.limited;
  }

  public get limitedPreview(): { text: string; truncated: true } {
    return { text: this.previewText, truncated: true };
  }

  private enterLimited(): void {
    this.limited = true;
    this.order.length = 0;
    this.records.clear();
    this.usedBytes = 0;
    if (Buffer.byteLength(JSON.stringify(this.currentConfigOptions)) > 16_384) {
      this.currentConfigOptions = [];
      this.configSequence += 1;
    }
  }

  private captureLimited(batch: DeliveredBatch<SessionUpdate>): void {
    for (const update of batch.updates) {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      )
        this.previewText = (this.previewText + update.content.text).slice(
          -4096,
        );
      else if (update.sessionUpdate === "usage_update")
        this.currentUsage = projectUsage(this.currentUsage, update);
      else if (update.sessionUpdate === "session_info_update")
        this.currentSessionInfo = projectSessionInfo(this.currentSessionInfo, update);
      else if (update.sessionUpdate === "config_option_update") {
        const bounded =
          Buffer.byteLength(JSON.stringify(update.configOptions)) <= 16_384;
        this.currentConfigOptions = bounded
          ? safeConfigOptions(update.configOptions)
          : [];
        this.configUpdated = true;
        this.configSequence += 1;
      }
    }
  }

  public setOutcome(turnId: string, outcome: TranscriptTurn["outcome"]): void {
    const turn = this.records.get(turnId);
    if (turn !== undefined) turn.outcome = outcome;
  }

  public setInitialConfigOptions(
    options: SessionConfigOption[] | null | undefined,
  ): void {
    if (this.configUpdated) return;
    const projected = safeConfigOptions(options ?? []);
    if (
      metadataBytes(projected, this.currentUsage, this.currentSessionInfo) + this.usedBytes >
      this.maxBytes
    )
      throw new HistoryCapacityError();
    this.currentConfigOptions = projected;
  }

  public get configOptions(): SessionConfigOption[] {
    return structuredClone(this.currentConfigOptions);
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
    if (
      metadataBytes(projected, this.currentUsage, this.currentSessionInfo) + this.usedBytes >
      this.maxBytes
    )
      throw new HistoryCapacityError();
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
  ): void {
    const projected = projectSessionInfo(this.currentSessionInfo, update);
    if (!this.limited && this.usedBytes +
      metadataBytes(this.currentConfigOptions, this.currentUsage, projected) > this.maxBytes)
      throw new HistoryCapacityError();
    this.currentSessionInfo = projected;
  }

  public get usage(): SessionUsage | null {
    return this.currentUsage === null
      ? null
      : structuredClone(this.currentUsage);
  }

  public get sessionInfo(): SessionInfo {
    return { ...this.currentSessionInfo };
  }

  public get turnCount(): number {
    return this.order.length;
  }

  public get estimatedRetainedBytes(): number {
    return (
      this.usedBytes +
      metadataBytes(this.currentConfigOptions, this.currentUsage, this.currentSessionInfo) +
      Buffer.byteLength(this.previewText)
    );
  }

  public pageBefore(
    before: number,
    limit = 20,
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
        .map((id) => this.materialize(this.records.get(id)!)),
      nextBefore: start === 0 ? null : start,
    };
  }

  public pageAfter(
    after: number,
    limit = 20,
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
        .map((id) => this.materialize(this.records.get(id)!)),
      nextAfter: end === this.order.length ? null : end,
    };
  }

  public turns(): TranscriptTurn[] {
    return this.order.map((id) => this.materialize(this.records.get(id)!));
  }

  public turnById(turnId: string): TranscriptTurn | null {
    const turn = this.records.get(turnId);
    return turn === undefined ? null : this.materialize(turn);
  }

  public processInfo(
    turnId: string,
  ): { version: number; count: number } | null {
    const turn = this.records.get(turnId);
    return turn === undefined
      ? null
      : { version: turn.processVersion, count: turn.process.length };
  }

  public processItem(
    turnId: string,
    index: number,
  ): Readonly<ProcessItem> | null {
    const item = this.records.get(turnId)?.process[index];
    return item ?? null;
  }

  private materialize(turn: StoredTurn): TranscriptTurn {
    return {
      turnId: turn.turnId,
      outcome: turn.outcome,
      prompt: structuredClone(turn.prompt),
      finalResponse: structuredClone([...turn.answers.values()].flat()),
      contentCursor: null,
      processVersion: turn.processVersion,
      processCount: turn.process.length,
      process: structuredClone(turn.process),
    };
  }

  private applyUpdate(
    batch: DeliveredBatch<SessionUpdate>,
    update: SessionUpdate,
  ): void {
    switch (update.sessionUpdate) {
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
        this.turn(
          batch.runId ?? update.messageId ?? batch.messageId,
        ).prompt.push(structuredClone(update.content));
        return;
      }
      case "agent_message_chunk": {
        const turn = this.turn(
          batch.runId ?? update.messageId ?? batch.messageId,
        );
        const id = update.messageId ?? batch.messageId;
        const content = turn.answers.get(id) ?? [];
        content.push(structuredClone(update.content));
        turn.answers.set(id, content);
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
        this.moveInterimAnswers(turn);
        const id = `tool-${update.toolCallId}`;
        const existing = turn.process[turn.processIndex.get(id) ?? -1];
        const content: ContentBlock[] = [
          ...(update.rawInput === undefined
            ? []
            : [
                {
                  type: "text" as const,
                  text: `Input: ${JSON.stringify(update.rawInput)}`,
                },
              ]),
          ...(update.rawOutput === undefined
            ? []
            : [
                {
                  type: "text" as const,
                  text: `Output: ${JSON.stringify(update.rawOutput)}`,
                },
              ]),
          ...(update.content ?? []).flatMap((entry): ContentBlock[] =>
            entry.type === "content"
              ? [structuredClone(entry.content)]
              : [{ type: "text", text: JSON.stringify(entry) }],
          ),
        ];
        this.upsertProcess(
          turn,
          id,
          "tool",
          update.title ?? existing?.summary ?? "Tool",
          toolStatus(update.status),
          content,
        );
        return;
      }
      case "plan": {
        const turn = this.turn(batch.runId ?? batch.messageId);
        this.upsertProcess(
          turn,
          `plan-${batch.messageId}`,
          "plan",
          "Plan",
          "completed",
          { type: "text", text: JSON.stringify(update.entries) },
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
        outcome: "unknown",
        prompt: [],
        answers: new Map(),
        process: [],
        processIndex: new Map(),
        processVersion: 0,
      };
      this.records.set(id, turn);
      this.order.push(id);
    }
    return turn;
  }

  private moveInterimAnswers(turn: StoredTurn): void {
    for (const [messageId, content] of turn.answers) {
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

  private upsertProcess(
    turn: StoredTurn,
    id: string,
    kind: ProcessItem["kind"],
    summary: string,
    status: ProcessItem["status"],
    content?: ContentBlock | ContentBlock[],
  ): void {
    const index = turn.processIndex.get(id);
    const previous = index === undefined ? undefined : turn.process[index];
    const item: ProcessItem = {
      id,
      kind,
      summary,
      status,
      content: [
        ...(previous?.content ?? []),
        ...(content === undefined
          ? []
          : (Array.isArray(content) ? content : [content]).map((block) =>
              structuredClone(block),
            )),
      ],
      contentCursor: null,
    };
    if (index === undefined) {
      turn.processIndex.set(id, turn.process.length);
      turn.process.push(item);
    } else turn.process[index] = item;
    turn.processVersion += 1;
  }
}

function metadataBytes(
  options: SessionConfigOption[],
  usage: SessionUsage | null,
  info: SessionInfo,
): number {
  return (
    Buffer.byteLength(JSON.stringify(options)) +
    Buffer.byteLength(JSON.stringify(usage)) +
    Buffer.byteLength(JSON.stringify(info))
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
