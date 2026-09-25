import { diffAgentViews, validAgentView } from "./protocol/agent-view-delta.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { AcpBridgeCallbacks } from "./adapters/acp-http.ts";
import { AgentBridgeOwner, type AcpBridgePort } from "./bridge/agent-owner.ts";
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
  const owners = new Set<AgentBridgeOwner>();
  const refreshes = new WeakMap<
    AgentBridgeOwner,
    Map<string, { dirty: boolean; running: boolean; reconcile: boolean }>
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
        now: input.now, idleMs: input.idleMs, incarnation: input.incarnation,
        connect: input.connect,
        recordColdReplay: input.recordColdReplay,
        recordLocalIntentReuse: input.recordLocalIntentReuse,
        closed: (owner) => {
          owners.delete(owner);
        },
        maxAgentJournals: input.maxAgentJournals,
        maxSessionJournals: input.maxSessionJournals,
        maxAgentSubscribers: input.maxAgentSubscribers,
        stream: { epoch: identity.epoch, key },
        changed: (owner, sessionId, reconcile) => scheduleRefresh(scope, owner, sessionId, reconcile),
        agentChanged: (owner) => scheduleRefresh(scope, owner, "", true),
        evicted: (owner, sessionId) => {
          latestAgentProjections.get(owner)?.delete(sessionId);
          refreshes.get(owner)?.delete(sessionId);
        },
        agentJournalEvicted: (owner, selectedSessionId) => {
          latestAgentProjections.get(owner)?.delete(selectedSessionId ?? "");
        },
      });
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
    const journal = owner.agentJournal(sessionId);
    const cursor = journal.snapshot((cursor) => cursor).cursor;
    const previous = projections.get(sessionId ?? "")?.(cursor);
    const next = projection(cursor);
    if (!validAgentView(next)) throw new Error("Invalid Agent View projection");
    const delta = validAgentView(previous) ? diffAgentViews(previous, next) : null;
    if (delta?.patch.length === 0) return;
    projections.set(sessionId ?? "", projection);
    if (previous === undefined) return;
    if (delta !== null) {
      try { journal.publish(delta); return; }
      catch (error) { if (!(error instanceof RangeError)) throw error; }
    }
    journal.publishReset(projection);
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
    const pager = lease.owner.viewPager(
      sessionId,
      {
        ...scope,
        sessionId,
        epoch: lease.epoch,
        incarnation: lease.owner.sessionIncarnation(sessionId),
      },
      key,
      blocked,
    );
    const recent = pager.recentTurns();
    const metadata = lease.owner.viewMetadata(sessionId, blocked);
    return {
      agentId: scope.agentId,
      sessionId,
      title: metadata.sessionInfo.title,
      updatedAt: metadata.sessionInfo.updatedAt,
      bridgeEpoch: lease.epoch,
      incarnation: lease.owner.sessionIncarnation(sessionId),
      viewRevision: lease.owner.viewRevision(sessionId),
      appendVersion: session.appendVersion,
      outputWatermark: pager.watermark,
      historyToken: blocked ? null : tokens.issue({
        ...scope,
        sessionId,
        epoch: lease.epoch,
        incarnation: lease.owner.sessionIncarnation(sessionId),
        appendVersion: session.appendVersion,
      }),
      streamCursor,
      historyState: blocked ? "blocked" as const : "ready" as const,
      turns: recent?.items ?? [],
      olderTurnsCursor: blocked ? null : recent?.olderTurnsCursor ?? null,
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
              incarnation: lease.owner.sessionIncarnation(sessionId),
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
          if (selected === null) await owner.authorizeExecution(sessionId);
        } catch (error) {
          failure = error;
        }
      }
    }));
    if (failure !== undefined) throw failure;
    return projectAgentView(scope, lease, selectedSessionId);
  }
  function projectAgentView(
    scope: BridgeScope, lease: BridgeLease<AgentBridgeOwner>, selectedSessionId: string | null,
  ): (cursor: string) => unknown {
    const owner = lease.owner;
    const state = owner.cachedAgentState();
    const sessionIds = new Set<string>(owner.trackedOperationSessionIds());
    if (selectedSessionId !== null) sessionIds.add(selectedSessionId);
    if (state.activeSessionId !== null) sessionIds.add(state.activeSessionId);
    for (const permission of owner.permissions) sessionIds.add(permission.sessionId);
    const operations = [...sessionIds].flatMap((sessionId) => owner.operations.snapshot(sessionId, owner.cachedReceipts(sessionId)));
    const active = operations.find((operation) => !["completed", "failed", "cancelled", "uncertain"].includes(operation.phase));
    let selectedView: unknown = null;
    if (selectedSessionId !== null) {
      const cached = owner.cachedSession(selectedSessionId);
      const cursor = owner.streamJournal(selectedSessionId).snapshot((value) => value).cursor;
      selectedView = makeView(scope, selectedSessionId, lease, cached.session, cursor, cached.blocked);
    }
    const permissions = owner.permissions.filter((item) => sessionIds.has(item.sessionId));
    const promptCapabilities = owner.promptCapabilities;
    return (streamCursor) => ({ agentId: scope.agentId, bridgeEpoch: lease.epoch,
      availability: state.availability === "ready" && active ? "busy" : state.availability,
      promptCapabilities,
      activeSessionId: state.activeSessionId ?? active?.sessionId ?? null,
      selectedSessionId, selectedView, operations,
      permissions, streamCursor });
  }
  function scheduleRefresh(
    scope: BridgeScope,
    owner: AgentBridgeOwner,
    sessionId: string,
    reconcile = false,
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
      state = { dirty: false, running: false, reconcile: false };
      sessions.set(sessionId, state);
    }
    state.dirty = true;
    state.reconcile ||= reconcile;
    if (state.running) return;
    state.running = true;
    const pending = state;
    queueMicrotask(() => {
      void (async () => {
        while (pending.dirty) {
          pending.dirty = false;
          const reconcile = pending.reconcile;
          pending.reconcile = false;
          let lease: BridgeLease<AgentBridgeOwner> | undefined;
          try {
            lease = await registry.observe(scope);
            if (lease.owner !== owner) break;
            if (reconcile) {
              const sessionsToRead = sessionId ? new Set([sessionId]) : new Set([
                ...owner.agentJournalSelections().filter((id): id is string => id !== null),
                ...owner.trackedOperationSessionIds(),
                ...(owner.cachedAgentState().activeSessionId ? [owner.cachedAgentState().activeSessionId!] : []),
              ]);
              for (const id of sessionsToRead) {
                if (owner.retainedSession(id) !== null) await readAuthorizedSession(owner, id);
                else await owner.authorizeExecution(id);
              }
            }
            for (const selected of owner.agentJournalSelections()) {
              const projection = projectAgentView(scope, lease, selected);
              rememberAgentProjection(owner, selected, projection);
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
        return {
          condition: {
            ...scope,
            sessionId,
            epoch: lease.epoch,
            incarnation: requireHistory ? lease.owner.sessionIncarnation(sessionId) : lease.incarnation,
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
              incarnation: lease.owner.sessionIncarnation(sessionId),
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
            incarnation: lease.owner.sessionIncarnation(sessionId),
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
    sweep: async () => {
      for (const owner of owners) await owner.sweep();
      await registry.sweep();
    },
    drain: (timeoutMs) => registry.drain(timeoutMs),
    metrics: () => {
      let cachedBytes = 0;
      let streamSubscribers = 0;
      let journalQueuedBytes = 0;
      let journalRetainedBytes = 0;
      let activeReplays = 0;
      let queuedReplays = 0;
      let uncertainOperations = 0;
      let oldestUncertainMs = 0;
      for (const owner of owners) {
        cachedBytes += owner.estimatedCachedHistoryBytes;
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
      return { ...registry.snapshotMetrics(), cachedBytes,
        streamSubscribers, journalQueuedBytes, journalRetainedBytes,
        activeReplays, queuedReplays, uncertainOperations, oldestUncertainMs };
    },
  };
}
