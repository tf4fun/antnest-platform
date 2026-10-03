import type { LearningStatus } from "../protocol/learning-status.ts";
import { projectSkillCommands, type WorkspaceCommand } from "../protocol/available-commands.ts";
import type {
  AgentCapabilities,
  ListSessionsResponse,
  NewSessionResponse,
  ForkSessionResponse,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AcpHttpBridge,
  AgentAccessRevokedError,
  BridgeCapabilityError,
  type AcpBridgeCallbacks,
  type ExecutionObservation,
  type AgentExecutionState,
  type IntentReceipt,
  type LearningChangePage,
} from "../adapters/acp-http.ts";
import { parseDeliveryMark } from "./delivery.ts";
import { ConfigurationConflictError } from "./configuration-token.ts";
import {
  CompactTranscript,
  type TranscriptTurn,
} from "./compact-transcript.ts";
import { OperationCoordinator } from "./operations.ts";
import { PermissionInbox, type PendingPermission } from "./permission-inbox.ts";
import { ReplayCapacityError, ReplayLoadGate } from "./replay-load-gate.ts";
import type { BridgeScope } from "./registry.ts";
import { SessionReplay } from "./session-replay.ts";
import { ViewPager, type ViewContext } from "./view-pager.ts";
import {
  StreamCapacityError,
  StreamJournal,
  type StreamEvent,
} from "./stream-journal.ts";

export type AcpBridgePort = {
  skillCommands?: WorkspaceCommand[];
  closed?: Promise<unknown>;
  capabilities?: Pick<AgentCapabilities, "promptCapabilities" | "sessionCapabilities">;
  list?(cursor?: string): Promise<ListSessionsResponse>;
  createSession?(): Promise<NewSessionResponse>;
  forkSession?(sessionId: string): Promise<ForkSessionResponse>;
  load(sessionId: string): Promise<{
    cut: { sealedWatermark: number; appendVersion: number };
    response?: { configOptions?: SessionConfigOption[] | null };
  }>;
  readExecution(sessionId: string): Promise<ExecutionObservation>;
  readAgentExecutionState?(): Promise<AgentExecutionState>;
  readLearningStatus?(): Promise<LearningStatus>;
  readLearningChanges?(): Promise<LearningChangePage>;
  watchAgentExecutionState?(
    changed: (state: AgentExecutionState) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  readIntent(
    sessionId: string,
    intentId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: "receipt"; receipt: IntentReceipt } | { kind: "unknown" }>;
  prompt(input: Parameters<AcpHttpBridge["prompt"]>[0]): Promise<unknown>;
  cancel(sessionId: string, expectedRunId: string): Promise<void>;
  setConfiguration?(
    sessionId: string,
    configId: string,
    value: string | boolean,
    expectedRevision: string,
  ): Promise<{ configOptions: SessionConfigOption[] }>;
  close(): void;
};

type ConditionReplay = SessionReplay<
  CompactTranscript,
  SessionNotification["update"]
>;

type AuthorizedSession = { appendVersion: number; outputWatermark: number;
  operations: OperationCoordinator; recentReceipts: IntentReceipt[];
  configurationRevision: string | null; upstreamConfigurationRevision: string | null };

const defaultMaxAgentJournals = 32;
const defaultMaxSessionJournals = 32;
const defaultMaxAgentSubscribers = 16;
const sessionOverheadBytes = 16 * 1024;
const maxSystemNotices = 20;

export type LearningSystemNotice = {
  changeId: string;
  sequence: string;
  agentId: string;
  kind: "skill_created" | "skill_updated";
  occurredAt: string;
  skillName: string;
  changeSummary: string;
  sourceSessionId?: string;
  sourceRunId?: string;
};

function learningSystemNotice(
  update: SessionNotification["update"],
  agentId: string,
): LearningSystemNotice | null {
  if (update.sessionUpdate !== "notice" || update.severity !== "info") return null;
  const meta = update._meta?.["antnest.dev/skill-learning"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const fields = meta as Record<string, unknown>;
  if (fields.version !== 1 || fields.agentId !== agentId ||
    (fields.kind !== "skill_created" && fields.kind !== "skill_updated") ||
    typeof fields.changeId !== "string" || fields.changeId.length < 1 || fields.changeId.length > 200 ||
    typeof fields.sequence !== "string" || !/^[1-9][0-9]{0,18}$/.test(fields.sequence) ||
    typeof fields.occurredAt !== "string" || fields.occurredAt.length < 20 || fields.occurredAt.length > 40 ||
    typeof fields.skillName !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.skillName) ||
    fields.skillName.length > 64 ||
    typeof fields.changeSummary !== "string" || fields.changeSummary.length < 1 || fields.changeSummary.length > 2048 ||
    update.title !== fields.changeSummary ||
    typeof update.description !== "string" || update.description.length > 2048 ||
    (fields.sourceSessionId !== undefined &&
      (typeof fields.sourceSessionId !== "string" || fields.sourceSessionId.length < 1 || fields.sourceSessionId.length > 200)) ||
    (fields.sourceRunId !== undefined &&
      (typeof fields.sourceRunId !== "string" || fields.sourceRunId.length < 1 || fields.sourceRunId.length > 200))) return null;
  return {
    changeId: fields.changeId,
    sequence: fields.sequence,
    agentId,
    kind: fields.kind,
    occurredAt: fields.occurredAt,
    skillName: fields.skillName,
    changeSummary: fields.changeSummary,
    ...(typeof fields.sourceSessionId === "string" ? { sourceSessionId: fields.sourceSessionId } : {}),
    ...(typeof fields.sourceRunId === "string" ? { sourceRunId: fields.sourceRunId } : {}),
  };
}

export class AgentBridgeOwner {
  public readonly operations: OperationCoordinator;
  private readonly inbox: PermissionInbox;
  private readonly sessions = new Map<string, ConditionReplay>();
  private readonly recentSystemNotices = new Map<string, LearningSystemNotice>();
  private currentLearningStatus: LearningStatus | null = null;
  private statusSync: Promise<void> | undefined;
  private lastStatusSyncAt = -Infinity;
  private learningSync: Promise<void> | undefined;
  private lastLearningSyncAt = -Infinity;
  private readonly sessionPins = new Map<string, number>();
  private readonly authorizationWorkflows = new Map<string, Promise<AuthorizedSession>>();
  private readonly pagers = new Map<string, { transcript: CompactTranscript; watermark: number;
    epoch: string; incarnation: string; key: Buffer; pager: ViewPager }>();
  private readonly activeRunSessions = new Set<string>();
  private readonly activeRunWork = new Map<string, () => void>();
  private readonly idleSince = new Map<string, number>();
  private readonly incarnations = new Map<string, string>();
  private readonly retainWork: () => () => void;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly newIncarnation: () => string;
  private sweeping: Promise<void> | undefined;
  private readonly replayLoads: ReplayLoadGate;
  private readonly recordColdReplay: (
    durationMs: number,
    outcome: "success" | "error",
  ) => void;
  private readonly recordLocalIntentReuse: (
    outcome: "hit" | "conflict",
  ) => void;
  private readonly closed: (owner: AgentBridgeOwner) => void;
  private readonly maxAgentJournals: number;
  private readonly maxSessionJournals: number;
  private readonly maxAgentSubscribers: number;
  private readonly replayRetryBackoffMs: number;
  private acp: AcpBridgePort | undefined;
  private currentSkillCommands: WorkspaceCommand[] = [];
  private retired = false;
  private draining = false;
  private readonly scope: BridgeScope;
  private readonly streamEpoch: string;
  private readonly streamKey: Buffer;
  private readonly journals = new Map<string, StreamJournal<unknown>>();
  private readonly agentJournals = new Map<string, StreamJournal<unknown>>();
  private readonly viewRevisions = new Map<string, number>();
  private readonly receiptDigests = new Map<string, string>();
  private permissionSessions = new Set<string>();
  private readonly changed: (
    owner: AgentBridgeOwner,
    sessionId: string,
    reconcile: boolean,
  ) => void;
  private readonly evicted: (
    owner: AgentBridgeOwner,
    sessionId: string,
  ) => void;
  private readonly agentChanged: (
    owner: AgentBridgeOwner,
    state: AgentExecutionState,
  ) => void;
  private readonly agentJournalEvicted: (
    owner: AgentBridgeOwner,
    selectedSessionId: string | null,
  ) => void;
  private readonly watchAbort = new AbortController();
  private observedAgentState: AgentExecutionState | undefined;
  private agentStateSequence = 0;
  private agentReadSequence = 0;
  private appliedAgentReadSequence = 0;
  private executionReadSequence = 0;
  private readonly executionObservations = new Map<string, { sequence: number; value: ExecutionObservation }>();
  private accessRevoked = false;

  private constructor(
    scope: BridgeScope,
    retainWork: () => () => void,
    stream: { epoch: string; key: Buffer },
    changed: (owner: AgentBridgeOwner, sessionId: string, reconcile: boolean) => void,
    evicted: (owner: AgentBridgeOwner, sessionId: string) => void,
    agentChanged: (owner: AgentBridgeOwner, state: AgentExecutionState) => void,
    agentJournalEvicted: (
      owner: AgentBridgeOwner,
      selectedSessionId: string | null,
    ) => void,
    maxQueuedLoads: number,
    maxAgentJournals: number,
    maxSessionJournals: number,
    maxAgentSubscribers: number,
    recordColdReplay: (
      durationMs: number,
      outcome: "success" | "error",
    ) => void,
    recordLocalIntentReuse: (outcome: "hit" | "conflict") => void,
    closed: (owner: AgentBridgeOwner) => void,
    lifecycle: { now: () => number; idleMs: number; incarnation: () => string;
      replayRetryBackoffMs: number },
  ) {
    if (!Number.isFinite(lifecycle.idleMs) || lifecycle.idleMs < 0)
      throw new RangeError("Invalid Session idle lifetime");
    this.retainWork = retainWork;
    this.now = lifecycle.now;
    this.idleMs = lifecycle.idleMs;
    if (!Number.isSafeInteger(lifecycle.replayRetryBackoffMs) ||
      lifecycle.replayRetryBackoffMs < 1)
      throw new RangeError("Invalid replay retry backoff");
    this.replayRetryBackoffMs = lifecycle.replayRetryBackoffMs;
    this.newIncarnation = lifecycle.incarnation;
    if (!Number.isSafeInteger(maxAgentJournals) || maxAgentJournals < 1)
      throw new RangeError("Invalid Agent journal capacity");
    if (!Number.isSafeInteger(maxSessionJournals) || maxSessionJournals < 1)
      throw new RangeError("Invalid Session journal capacity");
    if (!Number.isSafeInteger(maxAgentSubscribers) || maxAgentSubscribers < 1)
      throw new RangeError("Invalid Agent subscriber capacity");
    this.scope = scope;
    this.streamEpoch = stream.epoch;
    this.streamKey = stream.key;
    this.changed = changed;
    this.evicted = evicted;
    this.agentChanged = agentChanged;
    this.agentJournalEvicted = agentJournalEvicted;
    this.replayLoads = new ReplayLoadGate(maxQueuedLoads);
    this.recordColdReplay = recordColdReplay;
    this.recordLocalIntentReuse = recordLocalIntentReuse;
    this.closed = closed;
    this.maxAgentJournals = maxAgentJournals;
    this.maxSessionJournals = maxSessionJournals;
    this.maxAgentSubscribers = maxAgentSubscribers;
    this.inbox = new PermissionInbox({
      changed: (items) => this.onPermissionsChanged(items),
      retainWork,
    });
    this.operations = new OperationCoordinator({
      prompt: async (input) => {
        try { return await this.connection().prompt(input); }
        finally { this.notifyChanged(input.sessionId, true); }
      },
      readIntent: (sessionId, intentId, signal) =>
        this.connection().readIntent(sessionId, intentId, signal),
      cancel: (sessionId, runId) => this.connection().cancel(sessionId, runId),
      retainWork,
      changed: (sessionId) => this.notifyChanged(sessionId, true),
      recordLocalIntentReuse: this.recordLocalIntentReuse,
    });
  }

  public static async open(input: {
    scope: BridgeScope;
    retainWork(): () => void;
    stream?: { epoch: string; key: Buffer };
    maxQueuedLoads?: number;
    now?: () => number;
    idleMs?: number;
    replayRetryBackoffMs?: number;
    incarnation?: () => string;
    maxAgentJournals?: number;
    maxSessionJournals?: number;
    maxAgentSubscribers?: number;
    recordColdReplay?(durationMs: number, outcome: "success" | "error"): void;
    recordLocalIntentReuse?(outcome: "hit" | "conflict"): void;
    closed?(owner: AgentBridgeOwner): void;
    changed?(owner: AgentBridgeOwner, sessionId: string, reconcile: boolean): void;
    evicted?(owner: AgentBridgeOwner, sessionId: string): void;
    agentChanged?(owner: AgentBridgeOwner, state: AgentExecutionState): void;
    agentJournalEvicted?(
      owner: AgentBridgeOwner,
      selectedSessionId: string | null,
    ): void;
    connect(
      scope: BridgeScope,
      callbacks: AcpBridgeCallbacks,
    ): Promise<AcpBridgePort>;
  }): Promise<AgentBridgeOwner> {
    const owner = new AgentBridgeOwner(
      input.scope,
      input.retainWork,
      input.stream ?? { epoch: randomUUID(), key: randomBytes(32) },
      input.changed ?? (() => {}),
      input.evicted ?? (() => {}),
      input.agentChanged ?? (() => {}),
      input.agentJournalEvicted ?? (() => {}),
      input.maxQueuedLoads ?? 8,
      input.maxAgentJournals ?? defaultMaxAgentJournals,
      input.maxSessionJournals ?? defaultMaxSessionJournals,
      input.maxAgentSubscribers ?? defaultMaxAgentSubscribers,
      input.recordColdReplay ?? (() => {}),
      input.recordLocalIntentReuse ?? (() => {}),
      input.closed ?? (() => {}),
      { now: input.now ?? Date.now, idleMs: input.idleMs ?? 300_000,
        incarnation: input.incarnation ?? randomUUID,
        replayRetryBackoffMs: input.replayRetryBackoffMs ?? 500 },
    );
    owner.acp = await input.connect(input.scope, {
      update: (params) => owner.onUpdate(params),
      requestPermission: (params, signal) =>
        owner.retired ? Promise.resolve({ outcome: { outcome: "cancelled" as const } })
          : owner.inbox.request(params, signal),
    });
    owner.currentSkillCommands = projectSkillCommands(owner.acp.skillCommands ?? []);
    if (owner.acp.closed !== undefined)
      void owner.acp.closed.then(() => owner.close(), () => owner.close());
    void owner.watchAgentState();
    return owner;
  }

  public get isClosed(): boolean {
    return this.retired;
  }

  public get permissions(): PendingPermission[] {
    return this.inbox.pending;
  }

  public get systemNotices(): LearningSystemNotice[] {
    return [...this.recentSystemNotices.values()].sort((a, b) =>
      BigInt(a.sequence) < BigInt(b.sequence) ? -1 :
        BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0);
  }

  public get learningStatus(): LearningStatus | null {
    return this.retired || this.accessRevoked ? null : this.currentLearningStatus;
  }

  public get skillCommands(): WorkspaceCommand[] {
    return this.retired || this.accessRevoked ? [] : this.currentSkillCommands;
  }

  public async syncLearningStatus(): Promise<void> {
    if (this.retired || this.accessRevoked || this.acp?.readLearningStatus === undefined) return;
    if (this.statusSync !== undefined) return this.statusSync;
    if (this.now() - this.lastStatusSyncAt < 5_000) return;
    this.statusSync = (async () => {
      const before = JSON.stringify(this.currentLearningStatus);
      try {
        const status = await this.connection().readLearningStatus!();
        if (status.agentId !== this.scope.agentId) throw new Error("Foreign learning status");
        if (!this.retired && !this.accessRevoked) this.currentLearningStatus = status;
      } catch (error) {
        this.currentLearningStatus = null;
        throw error;
      } finally {
        this.lastStatusSyncAt = this.now();
        if (!this.retired && !this.accessRevoked && before !== JSON.stringify(this.currentLearningStatus) && this.observedAgentState !== undefined)
          this.agentChanged(this, this.observedAgentState);
      }
    })().finally(() => { this.statusSync = undefined; });
    return this.statusSync;
  }

  public async syncLearningChanges(): Promise<void> {
    if (this.retired || this.accessRevoked || this.acp?.readLearningChanges === undefined) return;
    if (this.learningSync !== undefined) return this.learningSync;
    if (this.now() - this.lastLearningSyncAt < 5_000) return;
    this.learningSync = (async () => {
      const page = await this.connection().readLearningChanges!();
      if (this.retired || this.accessRevoked) return;
      let changed = false;
      for (const item of page.items) {
        if (item.agentId !== this.scope.agentId ||
          (item.kind !== "skill_created" && item.kind !== "skill_updated")) continue;
        changed = this.rememberSystemNotice({
          changeId: item.changeId,
          sequence: item.sequence,
          agentId: item.agentId,
          kind: item.kind,
          occurredAt: item.occurredAt,
          skillName: item.skillName,
          changeSummary: item.changeSummary,
          ...(item.sourceSessionId === undefined ? {} : { sourceSessionId: item.sourceSessionId }),
          ...(item.sourceRunId === undefined ? {} : { sourceRunId: item.sourceRunId }),
        }) || changed;
      }
      this.lastLearningSyncAt = this.now();
      if (changed && this.observedAgentState !== undefined)
        this.agentChanged(this, this.observedAgentState);
    })().finally(() => { this.learningSync = undefined; });
    return this.learningSync;
  }

  public get promptCapabilities(): {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  } {
    const capabilities = this.connection().capabilities?.promptCapabilities;
    return {
      ...(typeof capabilities?.image === "boolean"
        ? { image: capabilities.image }
        : {}),
      ...(typeof capabilities?.audio === "boolean"
        ? { audio: capabilities.audio }
        : {}),
      ...(typeof capabilities?.embeddedContext === "boolean"
        ? { embeddedContext: capabilities.embeddedContext }
        : {}),
    };
  }

  public async listSessions(cursor?: string): Promise<ListSessionsResponse> {
    if (this.accessRevoked) throw new AgentAccessRevokedError();
    const acp = this.connection();
    if (acp.list === undefined)
      throw new Error("ACP Session list is unavailable");
    return acp.list(cursor);
  }

  public async createSession(): Promise<NewSessionResponse> {
    if (this.accessRevoked) throw new AgentAccessRevokedError();
    const acp = this.connection();
    if (acp.createSession === undefined)
      throw new Error("ACP Session create is unavailable");
    return acp.createSession();
  }

  public get supportsFork(): boolean {
    const acp = this.connection();
    return Boolean(acp.capabilities?.sessionCapabilities?.fork && acp.forkSession);
  }

  public async forkSession(sessionId: string): Promise<ForkSessionResponse> {
    if (this.accessRevoked) throw new AgentAccessRevokedError();
    const acp = this.connection();
    if (!this.supportsFork || !acp.forkSession) throw new BridgeCapabilityError("ACP Session fork is unavailable");
    await this.authorizeSession(sessionId);
    return acp.forkSession(sessionId);
  }

  public get cachedSessionCount(): number {
    return this.sessions.size;
  }

  public get estimatedCachedHistoryBytes(): number {
    let bytes = this.currentSkillCommands.length ? Buffer.byteLength(JSON.stringify(this.currentSkillCommands)) : 0;
    for (const replay of this.sessions.values())
      bytes += sessionOverheadBytes + replay.estimatedRetainedBytes;
    return bytes;
  }

  public streamMetrics(): {
    subscribers: number;
    queuedBytes: number;
    retainedBytes: number;
  } {
    const result = { subscribers: 0, queuedBytes: 0, retainedBytes: 0 };
    for (const journal of [
      ...this.journals.values(),
      ...this.agentJournals.values(),
    ]) {
      const snapshot = journal.snapshotMetrics();
      result.subscribers += snapshot.subscribers;
      result.queuedBytes += snapshot.queuedBytes;
      result.retainedBytes += snapshot.retainedBytes;
    }
    return result;
  }

  public replayMetrics(): { active: number; queued: number } {
    return this.replayLoads.snapshotMetrics();
  }

  public operationMetrics(): {
    uncertainOperations: number;
    oldestUncertainMs: number;
  } {
    return this.operations.snapshotMetrics();
  }

  public get trackedSessionCount(): number {
    return new Set([...this.receiptDigests.keys(), ...this.activeRunSessions])
      .size;
  }

  public trackedOperationSessionIds(): string[] {
    return this.operations.trackedSessionIds();
  }

  public async readAgentExecutionState(): Promise<AgentExecutionState> {
    if (this.accessRevoked) throw new AgentAccessRevokedError();
    const read = this.connection().readAgentExecutionState;
    if (read === undefined)
      throw new Error("ACP Agent execution state is unavailable");
    const generation = this.agentStateSequence;
    const sequence = ++this.agentReadSequence;
    const state = await read.call(this.connection());
    if (this.retired) throw new Error("Bridge owner is retired");
    if (generation === this.agentStateSequence && sequence > this.appliedAgentReadSequence) {
      this.observedAgentState = state;
      this.appliedAgentReadSequence = sequence;
    }
    return this.observedAgentState ?? state;
  }

  public cachedAgentState(): AgentExecutionState {
    if (this.observedAgentState === undefined) throw new Error("Agent state has not been authorized");
    return this.observedAgentState;
  }

  public cachedReceipts(sessionId: string): IntentReceipt[] {
    return this.executionObservations.get(sessionId)?.value.recentReceipts ?? [];
  }

  public cachedSession(sessionId: string): {
    session: Awaited<ReturnType<AgentBridgeOwner["authorizeSession"]>>; blocked: boolean;
  } {
    const replay = this.sessions.get(sessionId);
    const snapshot = replay?.snapshot();
    const execution = this.executionObservations.get(sessionId)?.value;
    if (!replay || !snapshot || snapshot.appendVersion === null || !execution)
      throw new Error("Session has not been authorized");
    const watermark = Math.max(execution.outputWatermark,
      ...this.operations.snapshot(sessionId, execution.recentReceipts).map((item) => item.outputWatermark ?? 0));
    const blocked = snapshot.needsReconcile || !replay.hasCompleteOutput(watermark) ||
      snapshot.appendVersion !== execution.appendVersion;
    return { blocked, session: { appendVersion: snapshot.appendVersion, outputWatermark: watermark,
      recentReceipts: execution.recentReceipts, operations: this.operations,
      configurationRevision: blocked ? null : this.configurationRevision(sessionId, execution.configurationRevision),
      upstreamConfigurationRevision: blocked ? null : execution.configurationRevision } };
  }

  public agentJournal(sessionId: string | null): StreamJournal<unknown> {
    if (this.retired || this.draining)
      throw new Error("Bridge owner is draining or retired");
    const selection = sessionId ?? "";
    let journal = this.agentJournals.get(selection);
    if (journal === undefined) {
      if (this.agentJournals.size >= this.maxAgentJournals) {
        const cold = [...this.agentJournals].find(
          ([, candidate]) => candidate.subscriberCount === 0,
        );
        if (cold === undefined) throw new StreamCapacityError();
        cold[1].close();
        this.agentJournals.delete(cold[0]);
        this.agentJournalEvicted(this, cold[0] || null);
      }
      journal = new StreamJournal({
        scope: this.scope,
        sessionId: selection,
        epoch: this.streamEpoch,
        projectionId: randomUUID(),
        key: this.streamKey,
        observersChanged: () => this.refreshIdle(sessionId ?? ""),
      });
      this.agentJournals.set(selection, journal);
    } else {
      this.agentJournals.delete(selection);
      this.agentJournals.set(selection, journal);
    }
    return journal;
  }

  public subscribeAgentJournal(
    sessionId: string | null,
    cursor: string | null,
    makeView: (cursor: string) => unknown,
  ): AsyncIterableIterator<StreamEvent<unknown>> {
    const subscribers = [...this.agentJournals.values()].reduce(
      (total, journal) => total + journal.subscriberCount,
      0,
    );
    if (subscribers >= this.maxAgentSubscribers)
      throw new StreamCapacityError();
    return this.agentJournal(sessionId).subscribe(cursor, makeView);
  }

  public agentJournalSelections(): Array<string | null> {
    return [...this.agentJournals.keys()].map((selection) => selection || null);
  }

  public decidePermission(
    permissionId: string,
    generation: number,
    optionId: string,
  ): void {
    this.inbox.decide(permissionId, generation, optionId);
  }

  public async setConfiguration(
    sessionId: string,
    configId: string,
    value: string | boolean,
    expectedRevision: string,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(expectedRevision))
      throw new ConfigurationConflictError(
        "Producer configuration revision is unavailable",
      );
    const releasePin = this.pinSession(sessionId);
    try {
      const transcript = this.readyTranscript(sessionId).view;
      const option = transcript.configOptions.find(
        (item) => item.id === configId,
      );
      if (option === undefined || !advertises(option, value))
        throw new ConfigurationConflictError(
          "Configuration value is not advertised",
        );
      const startedAt = transcript.configurationSequence;
      const set = this.connection().setConfiguration;
      if (set === undefined)
        throw new Error("ACP configuration method is unavailable");
      const response = await set.call(
        this.connection(),
        sessionId,
        configId,
        value,
        expectedRevision,
      );
      if (this.retired || this.sessions.get(sessionId)?.snapshot().view !== transcript)
        throw new Error("Session materialization is stale or retired");
      if (transcript.applyConfigurationResponse(response.configOptions, startedAt))
        this.notifyChanged(sessionId);
    } finally {
      releasePin();
    }
  }

  public authorizeSession(sessionId: string): Promise<AuthorizedSession> {
    const existing = this.authorizationWorkflows.get(sessionId);
    if (existing) return existing;
    const work = this.authorizeSessionOwned(sessionId);
    this.authorizationWorkflows.set(sessionId, work);
    const clear = () => {
      if (this.authorizationWorkflows.get(sessionId) === work)
        this.authorizationWorkflows.delete(sessionId);
    };
    void work.then(clear, clear);
    return work;
  }

  private async authorizeSessionOwned(sessionId: string): Promise<AuthorizedSession> {
    if (this.retired) throw new Error("Bridge owner is retired");
    const releaseWork = this.retainWork();
    const releasePin = this.pinSession(sessionId);
    try {
      let replay = this.sessions.get(sessionId);
      const created = replay === undefined;
      if (replay === undefined) {
        replay = new SessionReplay({
          empty: () => new CompactTranscript(),
          apply: (view, batch) => view.apply(batch),
          estimate: (view) => view.estimatedRetainedBytes,
        });
        this.sessions.set(sessionId, replay);
        this.incarnations.set(sessionId, this.newIncarnation());
      }
      const before = replay.snapshot();
      const coldReplay = replay.snapshot().appendVersion === null;
      if (coldReplay || replay.snapshot().needsReconcile) {
        const startedAt = coldReplay ? performance.now() : 0;
        let outcome: "success" | "error" = "error";
        try {
          await this.loadReplay(sessionId, replay);
          outcome = "success";
        } catch (error) {
          if (
            created &&
            this.sessions.get(sessionId) === replay &&
            replay.snapshot().appendVersion === null
          ) {
            this.sessions.delete(sessionId);
            this.incarnations.delete(sessionId);
          }
          throw error;
        } finally {
          if (coldReplay)
            this.recordColdReplay(performance.now() - startedAt, outcome);
        }
      }
      const execution = await this.authorizeExecution(sessionId);
      this.assertCurrentSession(sessionId, replay);
      const retainedVersion = replay.snapshot().appendVersion;
      if (!coldReplay && !replay.snapshot().needsReconcile && retainedVersion !== null &&
        (retainedVersion !== execution.appendVersion ||
          this.operations.knowsLocalVersion(sessionId, retainedVersion)) &&
        this.operations.knowsAppendTransition(sessionId, retainedVersion, execution.appendVersion))
        await replay.advanceLiveVersion(execution.appendVersion, execution.outputWatermark);
      if (
        !replay.hasCompleteOutput(execution.outputWatermark) ||
        replay.snapshot().appendVersion !== execution.appendVersion
      ) {
        await this.loadReplay(sessionId, replay);
        this.applyKnownOutcomes(sessionId, execution.recentReceipts);
        if (!replay.hasCompleteOutput(execution.outputWatermark))
          throw new Error("ACP replay is behind the durable output watermark");
        if (replay.snapshot().appendVersion !== execution.appendVersion)
          throw new Error("ACP replay is behind the current append version");
      }
      this.assertCurrentSession(sessionId, replay);
      const after = replay.snapshot();
      if (
        this.hasStreamJournal(sessionId) &&
        (before.needsReconcile ||
          before.watermark !== after.watermark ||
          before.appendVersion !== after.appendVersion)
      )
        this.notifyChanged(sessionId);
      this.touchSession(sessionId, replay);
      return {
        appendVersion: execution.appendVersion,
        outputWatermark: execution.outputWatermark,
        operations: this.operations,
        recentReceipts: execution.recentReceipts,
        configurationRevision: this.configurationRevision(
          sessionId,
          execution.configurationRevision,
        ),
        upstreamConfigurationRevision: execution.configurationRevision,
      };
    } finally {
      releasePin();
      releaseWork();
    }
  }

  private async loadReplay(sessionId: string, replay: ConditionReplay): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      this.assertCurrentSession(sessionId, replay);
      try {
        await replay.load((candidate) => this.replayLoads.run(async () => {
          const loaded = await this.connection().load(sessionId);
          this.assertCurrentSession(sessionId, replay);
          candidate.setInitialConfigOptions(loaded.response?.configOptions);
          return loaded.cut;
        }));
        return;
      } catch (error) {
        if (this.retired) throw new Error("Bridge owner is retired");
        if (attempt === 3 || error instanceof BridgeCapabilityError ||
          error instanceof ReplayCapacityError || error instanceof RangeError) throw error;
        await this.waitReplayRetry(this.replayRetryBackoffMs * 2 ** attempt);
      }
    }
  }

  private waitReplayRetry(delayMs: number): Promise<void> {
    const signal = this.watchAbort.signal;
    if (signal.aborted) return Promise.reject(new Error("Bridge owner is retired"));
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new Error("Bridge owner is retired"));
      };
      const timer = setTimeout(finish, delayMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  public readTurns(sessionId: string): TranscriptTurn[] {
    const view = this.readyTranscript(sessionId).view;
    return view.turns();
  }

  public viewMetadata(
    sessionId: string,
    allowStale = false,
  ): {
    configOptions: SessionConfigOption[];
    availableCommands: CompactTranscript["availableCommands"];
    usage: CompactTranscript["usage"];
    sessionInfo: CompactTranscript["sessionInfo"];
  } {
    const transcript = this.readyTranscript(sessionId, allowStale).view;
    return { configOptions: transcript.configOptions, availableCommands: transcript.availableCommands,
      usage: transcript.usage,
      sessionInfo: transcript.sessionInfo };
  }

  public retainedSession(
    sessionId: string,
  ): { appendVersion: number; watermark: number } | null {
    const snapshot = this.sessions.get(sessionId)?.snapshot();
    if (
      snapshot?.appendVersion === null ||
      snapshot === undefined ||
      snapshot.loading
    )
      return null;
    return {
      appendVersion: snapshot.appendVersion,
      watermark: snapshot.watermark,
    };
  }

  private configurationRevision(
    sessionId: string,
    upstreamRevision: string | null,
  ): string {
    const view = this.readyTranscript(sessionId).view;
    return createHash("sha256")
      .update(
        JSON.stringify([
          upstreamRevision,
          view.configurationSequence,
          view.configOptions,
        ]),
      )
      .digest("hex");
  }

  public viewPager(
    sessionId: string,
    context: Omit<ViewContext, "watermark"> & {
      watermark?: number;
    },
    key: Buffer,
    allowStale = false,
  ): ViewPager {
    const ready = this.readyTranscript(sessionId, allowStale);
    if (
      context.sessionId !== sessionId ||
      (context.watermark !== undefined &&
        context.watermark !== ready.watermark) ||
      context.organizationId !== this.scope.organizationId ||
      context.principalId !== this.scope.principalId ||
      context.agentId !== this.scope.agentId
    )
      throw new Error("View pager scope or watermark mismatch");
    const cached = this.pagers.get(sessionId);
    if (cached?.transcript === ready.view && cached.watermark === ready.watermark &&
      cached.epoch === context.epoch && cached.incarnation === context.incarnation && cached.key.equals(key))
      return cached.pager;
    const sameScope = cached?.transcript === ready.view && cached.epoch === context.epoch &&
      cached.incarnation === context.incarnation && cached.key.equals(key);
    const pager = new ViewPager({ transcript: ready.view,
      context: { ...context, watermark: ready.watermark }, key,
      now: this.now,
      ...(sameScope ? { turnContentCache: cached.pager.sharedTurnContentCache() } : {}) });
    this.pagers.set(sessionId, { transcript: ready.view, watermark: ready.watermark,
      epoch: context.epoch, incarnation: context.incarnation, key: Buffer.from(key), pager });
    return pager;
  }

  public streamJournal(sessionId: string): StreamJournal<unknown> {
    if (this.retired || this.draining)
      throw new Error("Bridge owner is draining or retired");
    let journal = this.journals.get(sessionId);
    if (journal === undefined) {
      if (this.journals.size >= this.maxSessionJournals) {
        const cold = [...this.journals].find(
          ([, candidate]) => candidate.subscriberCount === 0,
        );
        if (cold === undefined) throw new StreamCapacityError();
        cold[1].close();
        this.journals.delete(cold[0]);
      }
      journal = new StreamJournal({
        scope: this.scope,
        sessionId,
        epoch: this.streamEpoch,
        projectionId: randomUUID(),
        key: this.streamKey,
        observersChanged: () => this.refreshIdle(sessionId ?? ""),
      });
      this.journals.set(sessionId, journal);
    } else {
      this.journals.delete(sessionId);
      this.journals.set(sessionId, journal);
    }
    return journal;
  }

  public hasStreamJournal(sessionId: string): boolean {
    return this.journals.has(sessionId);
  }

  public viewRevision(sessionId: string): number {
    return this.viewRevisions.get(sessionId) ?? 0;
  }

  private pinSession(sessionId: string): () => void {
    this.sessionPins.set(sessionId, (this.sessionPins.get(sessionId) ?? 0) + 1);
    this.idleSince.delete(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.sessionPins.get(sessionId) ?? 1) - 1;
      if (remaining === 0) this.sessionPins.delete(sessionId);
      else this.sessionPins.set(sessionId, remaining);
      this.refreshIdle(sessionId);
    };
  }

  public sessionIncarnation(sessionId: string): string {
    const incarnation = this.incarnations.get(sessionId);
    if (incarnation === undefined) throw new Error("Session history is not ready");
    return incarnation;
  }

  public sweep(): Promise<void> {
    if (this.retired || this.draining) return Promise.resolve();
    this.sweeping ??= this.sweepSessions().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async sweepSessions(): Promise<void> {
    for (const { pager } of this.pagers.values()) pager.releaseIdleContentCaches();
    // Recovered Runs must be observed even with no browser subscriber.
    for (const sessionId of new Set([...this.activeRunSessions, ...this.operations.trackedSessionIds()])) {
      if (this.retired || this.draining) return;
      try { await this.authorizeExecution(sessionId); } catch { /* Keep work pinned until a trustworthy observation. */ }
    }
    for (const [sessionId, replay] of this.sessions) {
      this.refreshIdle(sessionId);
      const idleSince = this.idleSince.get(sessionId);
      if (idleSince !== undefined && this.now() - idleSince >= this.idleMs && this.canEvict(sessionId, replay))
        this.evictSession(sessionId);
    }
  }

  private refreshIdle(sessionId: string): void {
    const replay = this.sessions.get(sessionId);
    if (replay === undefined || this.retired) return;
    if (!this.canEvict(sessionId, replay)) this.idleSince.delete(sessionId);
    else if (!this.idleSince.has(sessionId)) this.idleSince.set(sessionId, this.now());
  }

  private assertCurrentSession(sessionId: string, replay: ConditionReplay): void {
    if (this.retired || this.sessions.get(sessionId) !== replay)
      throw new Error("Session materialization is stale or retired");
  }

  private canEvict(
    sessionId: string,
    replay: ConditionReplay,
  ): boolean {
    return (
      !replay.snapshot().loading &&
      (this.sessionPins.get(sessionId) ?? 0) === 0 &&
      (this.journals.get(sessionId)?.subscriberCount ?? 0) === 0 &&
      (this.agentJournals.get(sessionId)?.subscriberCount ?? 0) === 0 &&
      !this.inbox.pending.some((item) => item.sessionId === sessionId) &&
      !this.activeRunSessions.has(sessionId) &&
      !this.operations.hasInFlight(sessionId)
    );
  }

  private evictSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.pagers.delete(sessionId);
    this.idleSince.delete(sessionId);
    this.incarnations.delete(sessionId);
    this.journals.get(sessionId)?.close();
    this.journals.delete(sessionId);
    this.agentJournals.get(sessionId)?.close();
    this.agentJournals.delete(sessionId);
    this.viewRevisions.delete(sessionId);
    this.receiptDigests.delete(sessionId);
    this.executionObservations.delete(sessionId);
    this.activeRunSessions.delete(sessionId);
    this.evicted(this, sessionId);
  }

  private touchSession(sessionId: string, replay: ConditionReplay): void {
    if (this.sessions.get(sessionId) !== replay) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, replay);
  }

  private readyTranscript(
    sessionId: string,
    allowStale = false,
  ): {
    view: CompactTranscript;
    watermark: number;
  } {
    const replay = this.sessions.get(sessionId);
    const snapshot = replay?.snapshot();
    if (
      snapshot === undefined ||
      snapshot.appendVersion === null ||
      snapshot.loading ||
      (!allowStale && snapshot.needsReconcile)
    )
      throw new Error("Session history is not ready");
    return { view: snapshot.view, watermark: snapshot.watermark };
  }

  public async authorizeExecution(
    sessionId: string,
    options?: { reconcileMissing?: boolean },
  ): Promise<{
    appendVersion: number;
    outputWatermark: number;
    operations: OperationCoordinator;
    recentReceipts: IntentReceipt[];
    configurationRevision: string | null;
    upstreamConfigurationRevision: string | null;
  }> {
    const sequence = ++this.executionReadSequence;
    let execution = await this.connection().readExecution(sessionId);
    if (this.retired) throw new Error("Bridge owner is retired");
    if (execution.sessionId !== sessionId)
      throw new Error("ACP execution scope mismatch");
    for (const receipt of execution.recentReceipts) {
      if (receipt.sessionId !== sessionId)
        throw new Error("ACP receipt scope mismatch");
    }
    const newerObservation = () => {
      const current = this.executionObservations.get(sessionId);
      return current !== undefined && current.sequence > sequence ? current : undefined;
    };
    execution = newerObservation()?.value ?? execution;
    this.operations.observeReceipts(sessionId, execution.recentReceipts);
    if (options?.reconcileMissing !== false)
      await this.operations.reconcileMissing(
        sessionId,
        execution.recentReceipts,
      );
    if (this.retired) throw new Error("Bridge owner is retired");
    const newer = newerObservation();
    if (newer !== undefined) {
      execution = newer.value;
      this.operations.observeReceipts(sessionId, execution.recentReceipts);
    } else if (this.sessions.has(sessionId) || execution.activeRunId !== null || this.operations.trackedSessionIds().includes(sessionId))
      this.executionObservations.set(sessionId, { sequence, value: execution });
    else this.executionObservations.delete(sessionId);
    this.applyKnownOutcomes(sessionId, execution.recentReceipts);
    const transcript = this.sessions.get(sessionId)?.snapshot().view;
    const requiredOutputWatermark = Math.max(
      execution.outputWatermark,
      ...this.operations
        .snapshot(sessionId, execution.recentReceipts)
        .map((operation) => operation.outputWatermark ?? 0),
    );
    if (transcript !== undefined || this.journals.has(sessionId)) {
      const digest = JSON.stringify(execution.recentReceipts);
      const previousDigest = this.receiptDigests.get(sessionId);
      this.receiptDigests.set(sessionId, digest);
      if (previousDigest !== undefined && previousDigest !== digest)
        this.notifyChanged(sessionId);
    }
    if (execution.activeRunId !== null) {
      if (!this.activeRunWork.has(sessionId)) this.activeRunWork.set(sessionId, this.retainWork());
      this.activeRunSessions.add(sessionId);
    } else {
      this.activeRunSessions.delete(sessionId);
      this.activeRunWork.get(sessionId)?.();
      this.activeRunWork.delete(sessionId);
    }
    this.refreshIdle(sessionId);
    return {
      appendVersion: execution.appendVersion,
      outputWatermark: requiredOutputWatermark,
      operations: this.operations,
      recentReceipts: execution.recentReceipts,
      configurationRevision: execution.configurationRevision,
      upstreamConfigurationRevision: execution.configurationRevision,
    };
  }

  private applyKnownOutcomes(
    sessionId: string,
    receipts: IntentReceipt[],
  ): void {
    const transcript = this.sessions.get(sessionId)?.snapshot().view;
    if (transcript === undefined) return;
    for (const operation of this.operations.snapshot(sessionId, receipts)) {
      if (operation.acceptance !== "acp" || operation.runId === undefined)
        continue;
      const outcome =
        operation.phase === "completed" ||
        operation.phase === "failed" ||
        operation.phase === "cancelled"
          ? operation.phase
          : operation.phase === "uncertain"
            ? "unknown"
            : "running";
      transcript.setOutcome(operation.runId, outcome);
    }
  }

  public close(): void {
    if (this.retired) return;
    this.beginDrain();
    this.retired = true;
    this.currentSkillCommands = [];
    this.watchAbort.abort();
    this.inbox.clear();
    this.acp?.close();
    for (const journal of this.journals.values()) journal.close();
    this.journals.clear();
    for (const journal of this.agentJournals.values()) journal.close();
    this.agentJournals.clear();
    for (const replay of this.sessions.values()) replay.invalidate(new Error("Bridge owner is retired"));
    this.sessions.clear();
    this.pagers.clear();
    this.idleSince.clear();
    this.incarnations.clear();
    for (const release of this.activeRunWork.values()) release();
    this.activeRunWork.clear();
    this.activeRunSessions.clear();
    this.viewRevisions.clear();
    this.receiptDigests.clear();
    this.executionObservations.clear();
    this.recentSystemNotices.clear();
    this.closed(this);
  }

  public beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.watchAbort.abort();
    for (const journal of this.journals.values()) journal.close();
    this.journals.clear();
    for (const journal of this.agentJournals.values()) journal.close();
    this.agentJournals.clear();
  }

  private connection(): AcpBridgePort {
    if (this.retired || this.acp === undefined)
      throw new Error("ACP Bridge connection is unavailable");
    return this.acp;
  }

  private async watchAgentState(): Promise<void> {
    const watch = this.acp?.watchAgentExecutionState;
    if (watch === undefined) return;
    let retryMs = 1_000;
    while (!this.watchAbort.signal.aborted && !this.retired) {
      try {
        await watch.call(
          this.acp,
          (state) => {
            if (this.retired || this.draining) return;
            const encoded = JSON.stringify(state);
            const changed = encoded !== JSON.stringify(this.observedAgentState);
            this.observedAgentState = state;
            // Even an equal fresh watch result invalidates older HTTP reads.
            this.agentStateSequence++;
            if (changed) this.agentChanged(this, state);
          },
          this.watchAbort.signal,
        );
        retryMs = 1_000;
      } catch (error) {
        if (error instanceof AgentAccessRevokedError) {
          this.accessRevoked = true;
          for (const journal of this.agentJournals.values()) journal.close();
          for (const journal of this.journals.values()) journal.close();
          return;
        }
      }
      if (this.watchAbort.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.watchAbort.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, retryMs);
        timer.unref();
        this.watchAbort.signal.addEventListener("abort", done, { once: true });
      });
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }

  private onUpdate(params: SessionNotification): void {
    if (this.retired) return;
    if (params.update.sessionUpdate === "available_commands_update") {
      const skills = projectSkillCommands(params.update.availableCommands);
      if (JSON.stringify(skills) !== JSON.stringify(this.currentSkillCommands)) {
        this.currentSkillCommands = skills;
        if (this.observedAgentState !== undefined) this.agentChanged(this, this.observedAgentState);
      }
    }
    const notice = learningSystemNotice(params.update, this.scope.agentId);
    if (notice !== null) {
      if (this.rememberSystemNotice(notice) && this.observedAgentState !== undefined)
        this.agentChanged(this, this.observedAgentState);
      return;
    }
    const replay = this.sessions.get(params.sessionId);
    if (replay === undefined) return;
    const mark = parseDeliveryMark(params._meta?.["antnest.dev/delivery"]);
    if (mark === null) {
      const update = params.update;
      if (update.sessionUpdate !== "config_option_update" &&
        update.sessionUpdate !== "available_commands_update" &&
        update.sessionUpdate !== "session_info_update") return;
      let changed = false;
      replay.applySideband((view) => {
        if (update.sessionUpdate === "config_option_update")
          { view.applyConfigurationNotification(update.configOptions); changed = true; }
        else if (update.sessionUpdate === "available_commands_update")
          changed = view.applyCommandsNotification(update.availableCommands);
        else changed = view.applySessionInfoNotification(update);
      });
      if (changed) this.notifyChanged(params.sessionId);
      return;
    }
    const before = replay.snapshot();
    try {
      replay.receive(mark, params.update);
      // ACP carries its current catalog on replay checkpoints as well as sideband
      // updates. Keep the checkpoint's delivery semantics and project its metadata.
      let commandsChanged = false;
      const update = params.update;
      if (mark.kind === "checkpoint" && update.sessionUpdate === "available_commands_update")
        replay.applySideband((view) => {
          commandsChanged = view.applyCommandsNotification(update.availableCommands);
        });
      const after = replay.snapshot();
      if (!after.loading && (after.watermark > before.watermark || commandsChanged))
        this.notifyChanged(params.sessionId);
    } catch (error) {
      replay.invalidate(error);
      this.notifyChanged(params.sessionId);
      throw error;
    }
  }

  private rememberSystemNotice(notice: LearningSystemNotice): boolean {
    if (this.recentSystemNotices.has(notice.changeId)) return false;
    this.recentSystemNotices.set(notice.changeId, notice);
    if (this.recentSystemNotices.size > maxSystemNotices) {
      let oldest: LearningSystemNotice | undefined;
      for (const item of this.recentSystemNotices.values())
        if (oldest === undefined || BigInt(item.sequence) < BigInt(oldest.sequence)) oldest = item;
      if (oldest !== undefined) this.recentSystemNotices.delete(oldest.changeId);
      if (oldest?.changeId === notice.changeId) return false;
    }
    return true;
  }

  private onPermissionsChanged(items: PendingPermission[]): void {
    const current = new Set(items.map((item) => item.sessionId));
    const previous = this.permissionSessions;
    const changed = new Set([...current, ...previous]);
    this.permissionSessions = current;
    for (const sessionId of changed) this.notifyChanged(sessionId);
    for (const sessionId of previous) {
      if (
        !current.has(sessionId) &&
        !this.sessions.has(sessionId) &&
        !this.journals.has(sessionId) &&
        !this.agentJournals.has(sessionId) &&
        !this.activeRunSessions.has(sessionId) &&
        !this.operations.trackedSessionIds().includes(sessionId)
      )
        this.viewRevisions.delete(sessionId);
    }
  }

  private notifyChanged(sessionId: string, reconcile = false): void {
    if (this.retired) return;
    this.refreshIdle(sessionId);
    const revision = this.viewRevision(sessionId);
    if (revision >= Number.MAX_SAFE_INTEGER) return;
    this.viewRevisions.set(sessionId, revision + 1);
    this.changed(this, sessionId, reconcile);
  }
}

function advertises(
  option: SessionConfigOption,
  value: string | boolean,
): boolean {
  if (option.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  return option.options.some((entry) =>
    "value" in entry
      ? entry.value === value
      : entry.options.some((choice) => choice.value === value),
  );
}

export function connectAcpHttp(baseUrl: URL, fetchImpl: typeof fetch) {
  return (
    scope: BridgeScope,
    callbacks: AcpBridgeCallbacks,
  ): Promise<AcpHttpBridge> =>
    AcpHttpBridge.open({ baseUrl, scope, callbacks, fetchImpl });
}
