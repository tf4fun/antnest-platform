import { randomBytes, randomUUID } from "node:crypto";
import type { AcpBridgeCallbacks } from "./adapters/acp-http.ts";
import { AgentBridgeOwner, type AcpBridgePort } from "./bridge/agent-owner.ts";
import { HistoryCapacityError } from "./bridge/compact-transcript.ts";
import { SharedHistoryBudget } from "./bridge/history-budget.ts";
import {
  ConfigurationConflictError,
  ConfigurationTokens,
} from "./bridge/configuration-token.ts";
import { HistoryTokens } from "./bridge/history-token.ts";
import { PermissionDecisionError } from "./bridge/permission-inbox.ts";
import {
  BridgeRegistry,
  type BridgeLease,
  type BridgeScope,
} from "./bridge/registry.ts";
import { createCommandHandler } from "./http/command-routes.ts";
import { createAgentViewHandler } from "./http/agent-view-routes.ts";
import { createConfigurationHandler } from "./http/configuration-routes.ts";
import { createEventHandler } from "./http/event-routes.ts";
import { createHistoryHandler } from "./http/history-routes.ts";
import { createPermissionHandler } from "./http/permission-routes.ts";
import { createBootstrapHandler, type BootstrapScope } from "./http/bootstrap-routes.ts";
import { createSessionHandler } from "./http/session-routes.ts";
import { createViewHandler } from "./http/view-routes.ts";

export type BridgeRuntimeMetrics = {
  owners: number;
  observerLeases: number;
  heldWork: number;
  cachedBytes: number;
  reservedBytes: number;
  streamSubscribers: number;
  journalQueuedBytes: number;
  journalRetainedBytes: number;
  activeReplays: number;
  queuedReplays: number;
  uncertainOperations: number;
  oldestUncertainMs: number;
};

export function createWorkspaceRuntime(input: {
  discover?(scope: BootstrapScope): Promise<unknown>;
  connect(
    scope: BridgeScope,
    callbacks: AcpBridgeCallbacks,
  ): Promise<AcpBridgePort>;
  tokenKey?: Buffer;
  now?: () => number;
  idleMs?: number;
  maxSessionHistoryBytes?: number;
  maxCachedHistoryBytes?: number;
  maxGlobalHistoryBytes?: number;
  maxOwners?: number;
  maxAcpPromptBytes?: number;
  maxAgentJournals?: number;
  maxSessionJournals?: number;
  maxAgentSubscribers?: number;
  recordColdReplay?(durationMs: number, outcome: "success" | "error"): void;
  recordLocalIntentReuse?(outcome: "hit" | "conflict"): void;
  epoch?: () => string;
  incarnation?: () => string;
}): {
  handle(request: Request): Promise<Response | null>;
  sweep(): Promise<void>;
  drain(timeoutMs: number): Promise<{ forced: boolean }>;
  metrics(): BridgeRuntimeMetrics;
} {
  const key = input.tokenKey ?? randomBytes(32);
  const bridgeEpoch = (input.epoch ?? randomUUID)();
  const tokens = new HistoryTokens(key);
  const configurationTokens = new ConfigurationTokens(key);
  const historyBudget = new SharedHistoryBudget(input.maxGlobalHistoryBytes ?? 512 * 1024 * 1024);
  const owners = new Set<AgentBridgeOwner>();
  const refreshes = new WeakMap<
    AgentBridgeOwner,
    Map<string, { dirty: boolean; running: boolean }>
  >();
  const latestAgentProjections = new WeakMap<
    AgentBridgeOwner,
    Map<string, (cursor: string) => unknown>
  >();
  const registry = new BridgeRegistry({
    create: async (scope, retainWork, identity) => {
      const owner = await AgentBridgeOwner.open({
        scope,
        retainWork,
        connect: input.connect,
        maxSessionHistoryBytes: input.maxSessionHistoryBytes,
        maxCachedHistoryBytes: input.maxCachedHistoryBytes,
        reserveHistory: (owner, bytes) => historyBudget.reserve(owner, bytes),
        recordColdReplay: input.recordColdReplay,
        recordLocalIntentReuse: input.recordLocalIntentReuse,
        closed: (owner) => {
          historyBudget.unregister(owner);
          owners.delete(owner);
        },
        maxAgentJournals: input.maxAgentJournals,
        maxSessionJournals: input.maxSessionJournals,
        maxAgentSubscribers: input.maxAgentSubscribers,
        stream: { epoch: identity.epoch, key },
        changed: (owner, sessionId) => scheduleRefresh(scope, owner, sessionId),
        agentChanged: (owner) => scheduleRefresh(scope, owner, ""),
        evicted: (owner, sessionId) => {
          latestAgentProjections.get(owner)?.delete(sessionId);
          refreshes.get(owner)?.delete(sessionId);
        },
        agentJournalEvicted: (owner, selectedSessionId) => {
          latestAgentProjections.get(owner)?.delete(selectedSessionId ?? "");
        },
      });
      historyBudget.register(owner);
      owners.add(owner);
      return owner;
    },
    now: input.now ?? Date.now,
    idleMs: input.idleMs ?? 300_000,
    maxOwners: input.maxOwners,
    epoch: () => bridgeEpoch,
    incarnation: input.incarnation ?? randomUUID,
  });
  type Session = Awaited<ReturnType<AgentBridgeOwner["authorizeSession"]>>;
  function rememberAgentProjection(
    owner: AgentBridgeOwner,
    sessionId: string | null,
    projection: (cursor: string) => unknown,
  ): void {
    let projections = latestAgentProjections.get(owner);
    if (projections === undefined) {
      projections = new Map();
      latestAgentProjections.set(owner, projections);
    }
    projections.set(sessionId ?? "", projection);
  }
  function currentAgentProjection(
    owner: AgentBridgeOwner,
    sessionId: string | null,
  ): (cursor: string) => unknown {
    const projection = latestAgentProjections.get(owner)?.get(sessionId ?? "");
    if (projection === undefined)
      throw new Error("Agent projection is unavailable");
    return projection;
  }
  function makeView(
    scope: BridgeScope,
    sessionId: string,
    lease: BridgeLease<AgentBridgeOwner>,
    session: Session,
    streamCursor: string,
    blocked = false,
  ) {
    const limited = blocked ? null : lease.owner.viewLimit(sessionId);
    const pager = limited === null ? lease.owner.viewPager(
      sessionId,
      {
        ...scope,
        sessionId,
        epoch: lease.epoch,
        incarnation: lease.incarnation,
      },
      key,
      blocked,
    ) : null;
    const recent = pager?.recentTurns();
    const metadata = lease.owner.viewMetadata(sessionId, blocked);
    return {
      agentId: scope.agentId,
      sessionId,
      title: metadata.sessionInfo.title,
      updatedAt: metadata.sessionInfo.updatedAt,
      bridgeEpoch: lease.epoch,
      incarnation: lease.incarnation,
      viewRevision: lease.owner.viewRevision(sessionId),
      appendVersion: session.appendVersion,
      outputWatermark: limited?.watermark ?? pager!.watermark,
      historyToken: limited || blocked ? null : tokens.issue({
        ...scope,
        sessionId,
        epoch: lease.epoch,
        incarnation: lease.incarnation,
        appendVersion: session.appendVersion,
      }),
      streamCursor,
      historyState: limited ? "view_limited" as const : blocked ? "blocked" as const : "ready" as const,
      turns: recent?.items ?? [],
      olderTurnsCursor: blocked ? null : recent?.olderTurnsCursor ?? null,
      ...(limited ? { limitedPreview: limited.preview } : {}),
      operations: lease.owner.operations.snapshot(
        sessionId,
        session.recentReceipts,
      ),
      permissions: lease.owner.permissions.filter(
        (item) => item.sessionId === sessionId,
      ),
      configOptions: metadata.configOptions,
      configurationToken:
        !blocked && session.configurationRevision !== null &&
        metadata.configOptions.length > 0
          ? configurationTokens.issue({
              ...scope,
              sessionId,
              epoch: lease.epoch,
              incarnation: lease.incarnation,
              revision: session.configurationRevision,
            })
          : null,
      usage: metadata.usage,
    };
  }
  async function readAuthorizedSession(
    owner: AgentBridgeOwner,
    sessionId: string,
  ): Promise<{ session: Session; blocked: boolean }> {
    try {
      return { session: await owner.authorizeSession(sessionId), blocked: false };
    } catch (cause) {
      if (owner.retainedSession(sessionId) === null) throw cause;
      const execution = await owner.authorizeExecution(sessionId);
      const retained = owner.retainedSession(sessionId);
      if (retained === null) throw cause;
      return { session: { ...execution, appendVersion: retained.appendVersion,
        configurationRevision: null, upstreamConfigurationRevision: null }, blocked: true };
    }
  }
  async function prepareAgentView(
    scope: BridgeScope,
    lease: BridgeLease<AgentBridgeOwner>,
    selectedSessionId: string | null,
  ): Promise<(streamCursor: string) => unknown> {
    const owner = lease.owner;
    const state = await owner.readAgentExecutionState();
    const sessions = new Set<string>();
    if (selectedSessionId !== null) sessions.add(selectedSessionId);
    if (state.activeSessionId !== null) sessions.add(state.activeSessionId);
    for (const sessionId of owner.trackedOperationSessionIds())
      sessions.add(sessionId);
    for (const permission of owner.permissions)
      sessions.add(permission.sessionId);
    const sessionIds = [...sessions];
    const observed = new Array<ReturnType<typeof owner.operations.snapshot>>(sessionIds.length);
    let selectedView: unknown = null;
    let next = 0;
    let failure: unknown;
    await Promise.all(Array.from({ length: Math.min(8, sessionIds.length) }, async () => {
      while (failure === undefined && next < sessionIds.length) {
        const index = next++;
        const sessionId = sessionIds[index]!;
        try {
          const selected = sessionId === selectedSessionId
            ? await readAuthorizedSession(owner, sessionId)
            : null;
          const execution = selected?.session ?? await owner.authorizeExecution(sessionId);
          observed[index] = owner.operations.snapshot(sessionId, execution.recentReceipts);
          if (sessionId === selectedSessionId) {
            const cursor = owner.streamJournal(sessionId).snapshot((value) => value).cursor;
            selectedView = makeView(scope, sessionId, lease, execution, cursor,
              selected?.blocked ?? false);
          }
        } catch (error) {
          failure = error;
        }
      }
    }));
    if (failure !== undefined) throw failure;
    const operations = new Map<string, ReturnType<typeof owner.operations.snapshot>[number]>();
    for (const sessionOperations of observed)
      for (const operation of sessionOperations)
        operations.set(JSON.stringify([operation.sessionId, operation.operationId]), operation);
    const permissions = owner.permissions.filter((item) => sessions.has(item.sessionId));
    return (streamCursor) => ({
      agentId: scope.agentId,
      bridgeEpoch: lease.epoch,
      availability: state.availability,
      promptCapabilities: owner.promptCapabilities,
      activeSessionId: state.activeSessionId,
      selectedSessionId,
      selectedView,
      operations: [...operations.values()],
      permissions,
      streamCursor,
    });
  }
  function scheduleRefresh(
    scope: BridgeScope,
    owner: AgentBridgeOwner,
    sessionId: string,
  ): void {
    if (
      !owner.hasStreamJournal(sessionId) &&
      owner.agentJournalSelections().length === 0
    ) return;
    let sessions = refreshes.get(owner);
    if (sessions === undefined) {
      sessions = new Map();
      refreshes.set(owner, sessions);
    }
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { dirty: false, running: false };
      sessions.set(sessionId, state);
    }
    state.dirty = true;
    if (state.running) return;
    state.running = true;
    const pending = state;
    queueMicrotask(() => {
      void (async () => {
        while (pending.dirty) {
          pending.dirty = false;
          let lease: BridgeLease<AgentBridgeOwner> | undefined;
          try {
            lease = await registry.observe(scope);
            if (lease.owner !== owner) break;
            if (owner.hasStreamJournal(sessionId)) {
              const { session, blocked } = await readAuthorizedSession(owner, sessionId);
              owner
                .streamJournal(sessionId)
                .publishReset((cursor) =>
                  makeView(scope, sessionId, lease!, session, cursor, blocked),
                );
            }
            for (const selected of owner.agentJournalSelections()) {
              const projection = await prepareAgentView(scope, lease, selected);
              rememberAgentProjection(owner, selected, projection);
              owner.agentJournal(selected).publishReset((cursor) =>
                currentAgentProjection(owner, selected)(cursor));
            }
          } catch {
            // A failed read preserves the last valid view; a later read can retry.
          } finally {
            lease?.release();
          }
        }
        pending.running = false;
        if (sessions.get(sessionId) === pending) sessions.delete(sessionId);
      })();
    });
  }
  const commands = createCommandHandler({
    tokens,
    maxAcpPromptBytes: input.maxAcpPromptBytes,
    async authorize(scope, sessionId, requireHistory) {
      const lease = await registry.observe(scope);
      try {
        const session = requireHistory
          ? await lease.owner.authorizeSession(sessionId)
          : await lease.owner.authorizeExecution(sessionId, {
              reconcileMissing: false,
            });
        if (requireHistory && lease.owner.viewLimit(sessionId) !== null)
          throw new HistoryCapacityError();
        return {
          condition: {
            ...scope,
            sessionId,
            epoch: lease.epoch,
            incarnation: lease.incarnation,
            appendVersion: session.appendVersion,
          },
          operations: session.operations,
          release: lease.release,
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  });
  const history = createHistoryHandler({
    async authorize(scope, sessionId) {
      const lease = await registry.observe(scope);
      try {
        await lease.owner.authorizeSession(sessionId);
        return {
          pager: lease.owner.viewPager(
            sessionId,
            {
              ...scope,
              sessionId,
              epoch: lease.epoch,
              incarnation: lease.incarnation,
            },
            key,
          ),
          release: lease.release,
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  });
  const views = createViewHandler({
    async read(scope, sessionId) {
      const lease = await registry.observe(scope);
      try {
        const { session, blocked } = await readAuthorizedSession(lease.owner, sessionId);
        const event = lease.owner
          .streamJournal(sessionId)
          .snapshot((cursor) =>
            makeView(scope, sessionId, lease, session, cursor, blocked),
          );
        return event.view;
      } finally {
        lease.release();
      }
    },
  });
  const agentViews = createAgentViewHandler({
    async read(scope, sessionId) {
      const lease = await registry.observe(scope);
      try {
        const projection = await prepareAgentView(scope, lease, sessionId);
        const journal = lease.owner.agentJournal(sessionId);
        rememberAgentProjection(lease.owner, sessionId, projection);
        return journal.snapshot((cursor) =>
          currentAgentProjection(lease.owner, sessionId)(cursor)).view;
      } finally {
        lease.release();
      }
    },
  });
  const events = createEventHandler({
    async subscribe(scope, sessionId, cursor) {
      const lease = await registry.observe(scope);
      try {
        const projection = await prepareAgentView(scope, lease, sessionId);
        rememberAgentProjection(lease.owner, sessionId, projection);
        return {
          events: lease.owner.subscribeAgentJournal(sessionId, cursor, (nextCursor) =>
              currentAgentProjection(lease.owner, sessionId)(nextCursor)),
          release: lease.release,
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  });
  const permissions = createPermissionHandler({
    async decide(scope, permissionId, generation, optionId) {
      const lease = await registry.observe(scope);
      try {
        const pending = lease.owner.permissions.find(
          (item) => item.permissionId === permissionId,
        );
        if (pending === undefined)
          throw new PermissionDecisionError(
            "Permission request is no longer current",
          );
        const session = await lease.owner.authorizeSession(pending.sessionId);
        lease.owner.decidePermission(permissionId, generation, optionId);
        return lease.owner
          .streamJournal(pending.sessionId)
          .snapshot((cursor) =>
            makeView(scope, pending.sessionId, lease, session, cursor),
          ).view;
      } finally {
        lease.release();
      }
    },
  });
  const configuration = createConfigurationHandler({
    async apply(scope, sessionId, configId, value, token) {
      const lease = await registry.observe(scope);
      try {
        const current = await lease.owner.authorizeSession(sessionId);
        if (
          current.configurationRevision === null ||
          current.upstreamConfigurationRevision === null ||
          !configurationTokens.matches(token, {
            ...scope,
            sessionId,
            epoch: lease.epoch,
            incarnation: lease.incarnation,
            revision: current.configurationRevision,
          })
        )
          throw new ConfigurationConflictError("Configuration token is stale");
        await lease.owner.setConfiguration(sessionId, configId, value,
          current.upstreamConfigurationRevision);
        const updated = await lease.owner.authorizeSession(sessionId);
        return lease.owner
          .streamJournal(sessionId)
          .snapshot((cursor) =>
            makeView(scope, sessionId, lease, updated, cursor),
          ).view;
      } finally {
        lease.release();
      }
    },
  });
  const sessions = createSessionHandler({
    async list(scope, cursor) {
      const lease = await registry.observe(scope);
      try {
        return await lease.owner.listSessions(cursor);
      } finally {
        lease.release();
      }
    },
    async create(scope) {
      const lease = await registry.observe(scope);
      try {
        return await lease.owner.createSession();
      } finally {
        lease.release();
      }
    },
  });
  const bootstrap = createBootstrapHandler({
    epoch: bridgeEpoch,
    now: input.now ?? Date.now,
    discover: input.discover ?? (async () => {
      throw new Error("Controller discovery is not configured");
    }),
  });
  return {
    handle: async (request) =>
      (await bootstrap(request)) ??
      (await events(request)) ??
      (await permissions(request)) ??
      (await configuration(request)) ??
      (await sessions(request)) ??
      (await agentViews(request)) ??
      (await views(request)) ??
      (await history(request)) ??
      (await commands(request)),
    sweep: () => registry.sweep(),
    drain: (timeoutMs) => registry.drain(timeoutMs),
    metrics: () => {
      let streamSubscribers = 0;
      let journalQueuedBytes = 0;
      let journalRetainedBytes = 0;
      let activeReplays = 0;
      let queuedReplays = 0;
      let uncertainOperations = 0;
      let oldestUncertainMs = 0;
      for (const owner of owners) {
        const snapshot = owner.streamMetrics();
        streamSubscribers += snapshot.subscribers;
        journalQueuedBytes += snapshot.queuedBytes;
        journalRetainedBytes += snapshot.retainedBytes;
        const replay = owner.replayMetrics();
        activeReplays += replay.active;
        queuedReplays += replay.queued;
        const operations = owner.operationMetrics();
        uncertainOperations += operations.uncertainOperations;
        oldestUncertainMs = Math.max(oldestUncertainMs, operations.oldestUncertainMs);
      }
      return { ...registry.snapshotMetrics(), ...historyBudget.snapshotMetrics(),
        streamSubscribers, journalQueuedBytes, journalRetainedBytes,
        activeReplays, queuedReplays, uncertainOperations, oldestUncertainMs };
    },
  };
}
