import type {
  AgentCapabilities,
  ListSessionsResponse,
  NewSessionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AcpHttpBridge,
  AgentAccessRevokedError,
  type AcpBridgeCallbacks,
  type ExecutionObservation,
  type AgentExecutionState,
  type IntentReceipt,
} from "../adapters/acp-http.ts";
import { parseDeliveryMark } from "./delivery.ts";
import { ConfigurationConflictError } from "./configuration-token.ts";
import {
  CompactTranscript,
  HistoryCapacityError,
  type TranscriptTurn,
} from "./compact-transcript.ts";
import { OperationCoordinator } from "./operations.ts";
import { PermissionInbox, type PendingPermission } from "./permission-inbox.ts";
import { ReplayLoadGate } from "./replay-load-gate.ts";
import type { BridgeScope } from "./registry.ts";
import { SessionReplay } from "./session-replay.ts";
import { ViewPager, type ViewContext } from "./view-pager.ts";
import {
  StreamCapacityError,
  StreamJournal,
  type StreamEvent,
} from "./stream-journal.ts";

export type AcpBridgePort = {
  closed?: Promise<unknown>;
  capabilities?: Pick<AgentCapabilities, "promptCapabilities">;
  list?(cursor?: string): Promise<ListSessionsResponse>;
  createSession?(): Promise<NewSessionResponse>;
  load(sessionId: string): Promise<{
    cut: { sealedWatermark: number; appendVersion: number };
    response?: { configOptions?: SessionConfigOption[] | null };
  }>;
  readExecution(sessionId: string): Promise<ExecutionObservation>;
  readAgentExecutionState?(): Promise<AgentExecutionState>;
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

const defaultSessionHistoryBytes = 64 * 1024 * 1024;
const defaultCachedHistoryBytes = 256 * 1024 * 1024;
const defaultMaxAgentJournals = 32;
const defaultMaxSessionJournals = 32;
const defaultMaxAgentSubscribers = 16;
const sessionOverheadBytes = 16 * 1024;

export class AgentBridgeOwner {
  public readonly operations: OperationCoordinator;
  private readonly inbox: PermissionInbox;
  private readonly sessions = new Map<string, ConditionReplay>();
  private readonly sessionPins = new Map<string, number>();
  private readonly activeRunSessions = new Set<string>();
  private readonly replayLoads: ReplayLoadGate;
  private readonly maxSessionHistoryBytes: number;
  private readonly maxCachedHistoryBytes: number;
  private readonly reserveHistory: (
    owner: AgentBridgeOwner,
    bytes: number,
  ) => () => void;
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
  private acp: AcpBridgePort | undefined;
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
  private lastAgentState: string | undefined;
  private accessRevoked = false;

  private constructor(
    scope: BridgeScope,
    retainWork: () => () => void,
    stream: { epoch: string; key: Buffer },
    changed: (owner: AgentBridgeOwner, sessionId: string) => void,
    evicted: (owner: AgentBridgeOwner, sessionId: string) => void,
    agentChanged: (owner: AgentBridgeOwner, state: AgentExecutionState) => void,
    agentJournalEvicted: (
      owner: AgentBridgeOwner,
      selectedSessionId: string | null,
    ) => void,
    maxQueuedLoads: number,
    maxSessionHistoryBytes: number,
    maxCachedHistoryBytes: number,
    maxAgentJournals: number,
    maxSessionJournals: number,
    maxAgentSubscribers: number,
    reserveHistory: (owner: AgentBridgeOwner, bytes: number) => () => void,
    recordColdReplay: (
      durationMs: number,
      outcome: "success" | "error",
    ) => void,
    recordLocalIntentReuse: (outcome: "hit" | "conflict") => void,
    closed: (owner: AgentBridgeOwner) => void,
  ) {
    if (
      !Number.isSafeInteger(maxSessionHistoryBytes) ||
      maxSessionHistoryBytes < 1 ||
      !Number.isSafeInteger(maxCachedHistoryBytes) ||
      maxCachedHistoryBytes < maxSessionHistoryBytes + sessionOverheadBytes
    )
      throw new RangeError("Invalid Bridge history cache budget");
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
    this.maxSessionHistoryBytes = maxSessionHistoryBytes;
    this.maxCachedHistoryBytes = maxCachedHistoryBytes;
    this.reserveHistory = reserveHistory;
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
      prompt: (input) => this.connection().prompt(input),
      readIntent: (sessionId, intentId, signal) =>
        this.connection().readIntent(sessionId, intentId, signal),
      cancel: (sessionId, runId) => this.connection().cancel(sessionId, runId),
      retainWork,
      changed: (sessionId) => this.notifyChanged(sessionId),
      recordLocalIntentReuse: this.recordLocalIntentReuse,
    });
  }

  public static async open(input: {
    scope: BridgeScope;
    retainWork(): () => void;
    stream?: { epoch: string; key: Buffer };
    maxQueuedLoads?: number;
    maxSessionHistoryBytes?: number;
    maxCachedHistoryBytes?: number;
    maxAgentJournals?: number;
    maxSessionJournals?: number;
    maxAgentSubscribers?: number;
    reserveHistory?(owner: AgentBridgeOwner, bytes: number): () => void;
    recordColdReplay?(durationMs: number, outcome: "success" | "error"): void;
    recordLocalIntentReuse?(outcome: "hit" | "conflict"): void;
    closed?(owner: AgentBridgeOwner): void;
    changed?(owner: AgentBridgeOwner, sessionId: string): void;
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
      input.maxSessionHistoryBytes ?? defaultSessionHistoryBytes,
      input.maxCachedHistoryBytes ?? defaultCachedHistoryBytes,
      input.maxAgentJournals ?? defaultMaxAgentJournals,
      input.maxSessionJournals ?? defaultMaxSessionJournals,
      input.maxAgentSubscribers ?? defaultMaxAgentSubscribers,
      input.reserveHistory ?? (() => () => {}),
      input.recordColdReplay ?? (() => {}),
      input.recordLocalIntentReuse ?? (() => {}),
      input.closed ?? (() => {}),
    );
    owner.acp = await input.connect(input.scope, {
      update: (params) => owner.onUpdate(params),
      requestPermission: (params, signal) =>
        owner.inbox.request(params, signal),
    });
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

  public get cachedSessionCount(): number {
    return this.sessions.size;
  }

  public get estimatedCachedHistoryBytes(): number {
    let bytes = 0;
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
    return read.call(this.connection());
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
      const releaseBudget = this.reserveHistory(
        this,
        Buffer.byteLength(JSON.stringify(response.configOptions)) + 4096,
      );
      try {
        if (
          transcript.applyConfigurationResponse(
            response.configOptions,
            startedAt,
          )
        )
          this.notifyChanged(sessionId);
      } finally {
        releaseBudget();
      }
    } finally {
      releasePin();
    }
  }

  public async authorizeSession(sessionId: string): Promise<{
    appendVersion: number;
    outputWatermark: number;
    operations: OperationCoordinator;
    recentReceipts: IntentReceipt[];
    configurationRevision: string | null;
    upstreamConfigurationRevision: string | null;
  }> {
    if (this.retired) throw new Error("Bridge owner is retired");
    const releasePin = this.pinSession(sessionId);
    try {
      let replay = this.sessions.get(sessionId);
      const created = replay === undefined;
      if (replay === undefined) {
        replay = new SessionReplay({
          empty: () => new CompactTranscript(this.maxSessionHistoryBytes),
          apply: (view, batch) => view.apply(batch),
          estimate: (view) => view.estimatedRetainedBytes,
          seal: (view) => view.enableLiveLimit(),
          prepareReplacement: (view) => view.enableLiveLimit(),
          limit: (view) => view.limitLive(),
          isLimited: (view) => view.isLimited,
          summarize: summarizeLimitedUpdate,
        });
        this.sessions.set(sessionId, replay);
      }
      const before = replay.snapshot();
      const coldReplay = replay.snapshot().appendVersion === null;
      if (coldReplay || replay.snapshot().needsReconcile) {
        const startedAt = coldReplay ? performance.now() : 0;
        let outcome: "success" | "error" = "error";
        try {
          const releaseBudget = this.reserveForLoad(sessionId);
          try {
            await replay.load((candidate) =>
              this.replayLoads.run(async () => {
                const loaded = await this.connection().load(sessionId);
                candidate.setInitialConfigOptions(
                  loaded.response?.configOptions,
                );
                return loaded.cut;
              }),
            );
          } finally {
            releaseBudget();
          }
          outcome = "success";
        } catch (error) {
          if (
            created &&
            this.sessions.get(sessionId) === replay &&
            replay.snapshot().appendVersion === null
          )
            this.sessions.delete(sessionId);
          throw error;
        } finally {
          if (coldReplay)
            this.recordColdReplay(performance.now() - startedAt, outcome);
        }
      }
      const execution = await this.authorizeExecution(sessionId);
      if (
        !replay.snapshot().view.isLimited &&
        (!replay.hasCompleteOutput(execution.outputWatermark) ||
          replay.snapshot().appendVersion !== execution.appendVersion)
      ) {
        const releaseBudget = this.reserveForLoad(sessionId);
        try {
          await replay.load((candidate) =>
            this.replayLoads.run(async () => {
              const loaded = await this.connection().load(sessionId);
              candidate.setInitialConfigOptions(loaded.response?.configOptions);
              return loaded.cut;
            }),
          );
        } finally {
          releaseBudget();
        }
        this.applyKnownOutcomes(sessionId, execution.recentReceipts);
        if (!replay.hasCompleteOutput(execution.outputWatermark))
          throw new Error("ACP replay is behind the durable output watermark");
        if (replay.snapshot().appendVersion !== execution.appendVersion)
          throw new Error("ACP replay is behind the current append version");
      }
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
    }
  }

  public readTurns(sessionId: string): TranscriptTurn[] {
    const view = this.readyTranscript(sessionId).view;
    if (view.isLimited) throw new HistoryCapacityError();
    return view.turns();
  }

  public viewMetadata(
    sessionId: string,
    allowStale = false,
  ): {
    configOptions: SessionConfigOption[];
    usage: CompactTranscript["usage"];
    sessionInfo: CompactTranscript["sessionInfo"];
  } {
    const transcript = this.readyTranscript(sessionId, allowStale).view;
    return { configOptions: transcript.configOptions, usage: transcript.usage,
      sessionInfo: transcript.sessionInfo };
  }

  public retainedSession(
    sessionId: string,
  ): { appendVersion: number; watermark: number } | null {
    const snapshot = this.sessions.get(sessionId)?.snapshot();
    if (
      snapshot?.appendVersion === null ||
      snapshot === undefined ||
      snapshot.loading ||
      snapshot.view.isLimited
    )
      return null;
    return {
      appendVersion: snapshot.appendVersion,
      watermark: snapshot.watermark,
    };
  }

  public viewLimit(sessionId: string): {
    watermark: number;
    preview: { text: string; truncated: true };
  } | null {
    const ready = this.readyTranscript(sessionId);
    return ready.view.isLimited
      ? { watermark: ready.watermark, preview: ready.view.limitedPreview }
      : null;
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
    if (ready.view.isLimited) throw new HistoryCapacityError();
    if (
      context.sessionId !== sessionId ||
      (context.watermark !== undefined &&
        context.watermark !== ready.watermark) ||
      context.organizationId !== this.scope.organizationId ||
      context.principalId !== this.scope.principalId ||
      context.agentId !== this.scope.agentId
    )
      throw new Error("View pager scope or watermark mismatch");
    return new ViewPager({
      transcript: ready.view,
      context: { ...context, watermark: ready.watermark },
      key,
    });
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
    return () => {
      const remaining = (this.sessionPins.get(sessionId) ?? 1) - 1;
      if (remaining === 0) this.sessionPins.delete(sessionId);
      else this.sessionPins.set(sessionId, remaining);
    };
  }

  private reserveForLoad(sessionId: string): () => void {
    if (!this.evictColdUntil(this.maxSessionHistoryBytes, sessionId))
      throw new HistoryCapacityError();
    return this.reserveHistory(this, this.maxSessionHistoryBytes);
  }

  private evictColdUntil(
    reserveBytes: number,
    protectedSessionId: string,
  ): boolean {
    while (
      this.estimatedCachedHistoryBytes + reserveBytes >
      this.maxCachedHistoryBytes
    ) {
      const cold = [...this.sessions].find(([sessionId, replay]) =>
        this.canEvict(sessionId, replay, protectedSessionId),
      );
      if (cold === undefined) return false;
      this.evictSession(cold[0]);
    }
    return true;
  }

  private canEvict(
    sessionId: string,
    replay: ConditionReplay,
    protectedSessionId: string,
  ): boolean {
    return (
      sessionId !== protectedSessionId &&
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
    this.journals.get(sessionId)?.close();
    this.journals.delete(sessionId);
    this.agentJournals.get(sessionId)?.close();
    this.agentJournals.delete(sessionId);
    this.viewRevisions.delete(sessionId);
    this.receiptDigests.delete(sessionId);
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
    const execution = await this.connection().readExecution(sessionId);
    if (execution.sessionId !== sessionId)
      throw new Error("ACP execution scope mismatch");
    for (const receipt of execution.recentReceipts) {
      if (receipt.sessionId !== sessionId)
        throw new Error("ACP receipt scope mismatch");
    }
    this.operations.observeReceipts(sessionId, execution.recentReceipts);
    if (options?.reconcileMissing !== false)
      await this.operations.reconcileMissing(
        sessionId,
        execution.recentReceipts,
      );
    this.applyKnownOutcomes(sessionId, execution.recentReceipts);
    const transcript = this.sessions.get(sessionId)?.snapshot().view;
    const requiredOutputWatermark = Math.max(
      execution.outputWatermark,
      ...this.operations
        .snapshot(sessionId, execution.recentReceipts)
        .map((operation) => operation.outputWatermark ?? 0),
    );
    if (transcript !== undefined || this.journals.has(sessionId)) {
      if (execution.activeRunId === null)
        this.activeRunSessions.delete(sessionId);
      else this.activeRunSessions.add(sessionId);
      const digest = JSON.stringify(execution.recentReceipts);
      const previousDigest = this.receiptDigests.get(sessionId);
      this.receiptDigests.set(sessionId, digest);
      if (previousDigest !== undefined && previousDigest !== digest)
        this.notifyChanged(sessionId);
    }
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
    this.watchAbort.abort();
    this.inbox.clear();
    this.acp?.close();
    for (const journal of this.journals.values()) journal.close();
    this.journals.clear();
    for (const journal of this.agentJournals.values()) journal.close();
    this.agentJournals.clear();
    this.sessions.clear();
    this.viewRevisions.clear();
    this.receiptDigests.clear();
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
            if (encoded === this.lastAgentState) return;
            this.lastAgentState = encoded;
            this.agentChanged(this, state);
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
    const replay = this.sessions.get(params.sessionId);
    if (replay === undefined) return;
    const mark = parseDeliveryMark(params._meta?.["antnest.dev/delivery"]);
    if (mark === null) {
      const update = params.update;
      if (update.sessionUpdate !== "config_option_update" &&
        update.sessionUpdate !== "session_info_update") return;
      try {
        const releaseBudget = this.reserveHistory(
          this,
          Buffer.byteLength(JSON.stringify(update)) + 4096,
        );
        try {
          replay.applySideband((view) => {
            if (update.sessionUpdate === "config_option_update")
              view.applyConfigurationNotification(update.configOptions);
            else view.applySessionInfoNotification(update);
          });
        } finally {
          releaseBudget();
        }
      } catch (error) {
        replay.invalidate(error);
      }
      this.notifyChanged(params.sessionId);
      return;
    }
    if (replay.snapshot().view.isLimited) {
      const before = replay.snapshot().watermark;
      try {
        replay.receive(mark, params.update);
        if (replay.snapshot().watermark > before)
          this.notifyChanged(params.sessionId);
      } catch (error) {
        replay.invalidate(error);
        this.notifyChanged(params.sessionId);
      }
      return;
    }
    let releaseBudget: () => void;
    try {
      releaseBudget = this.reserveHistory(
        this,
        Buffer.byteLength(JSON.stringify(params.update ?? null)) + 4096,
      );
    } catch (error) {
      if (error instanceof HistoryCapacityError && replay.limitCurrent()) {
        try {
          replay.receive(mark, params.update);
        } catch (cause) {
          replay.invalidate(cause);
        }
      } else {
        replay.invalidate(error);
      }
      this.notifyChanged(params.sessionId);
      return;
    }
    const before = replay.snapshot();
    try {
      replay.receive(mark, params.update);
      const after = replay.snapshot();
      if (!after.loading && after.watermark > before.watermark)
        this.notifyChanged(params.sessionId);
    } catch (error) {
      if (!(error instanceof HistoryCapacityError)) throw error;
      this.notifyChanged(params.sessionId);
    } finally {
      releaseBudget();
    }
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

  private notifyChanged(sessionId: string): void {
    if (this.retired) return;
    const revision = this.viewRevision(sessionId);
    if (revision >= Number.MAX_SAFE_INTEGER) return;
    this.viewRevisions.set(sessionId, revision + 1);
    this.changed(this, sessionId);
  }
}

function summarizeLimitedUpdate(
  update: SessionUpdate,
): SessionUpdate | undefined {
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text"
  )
    return {
      ...update,
      content: { type: "text", text: update.content.text.slice(-4096) },
    };
  if (update.sessionUpdate === "usage_update") return update;
  if (update.sessionUpdate === "config_option_update")
    return Buffer.byteLength(JSON.stringify(update)) <= 16_384
      ? update
      : { sessionUpdate: "config_option_update", configOptions: [] };
  return undefined;
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

export function connectAcpHttp(baseUrl: URL, fetchImpl?: typeof fetch) {
  return (
    scope: BridgeScope,
    callbacks: AcpBridgeCallbacks,
  ): Promise<AcpHttpBridge> =>
    AcpHttpBridge.open({ baseUrl, scope, callbacks, fetchImpl });
}
