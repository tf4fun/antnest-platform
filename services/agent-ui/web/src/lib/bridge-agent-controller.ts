import type { ContentBlock } from "@agentclientprotocol/sdk";
import { openBridgeObserver } from "./bridge-observer.ts";
import { BridgeOperationTracker, type BridgeOperation } from "./bridge-operations.ts";
import { BridgePermissionStore } from "./bridge-permissions.ts";
import { BridgeSessionStore } from "./bridge-session-store.ts";
import type { BridgeAgentView } from "./bridge-stream.ts";
import type { PendingPermission } from "./permissions.ts";
import type { Conversation } from "./types.ts";
import { WorkspaceApiError, type BridgeHttpClient } from "./workspace-api-client.ts";

type ControllerApi = Pick<BridgeHttpClient,
  "agentView" | "eventsURL" | "turnContent" | "turns" | "prompt" | "operation" | "cancel" |
  "decidePermission" | "configuration">;
type ObserverOpen = typeof openBridgeObserver;

export type BridgeControllerSnapshot = {
  connection: "connecting" | "ready" | "offline";
  view: BridgeAgentView | null;
  conversation?: Conversation;
  operations: readonly BridgeOperation[];
  permissions: readonly PendingPermission[];
  revoked?: boolean;
  unauthenticated?: boolean;
};

export class BridgeAgentController {
  private readonly agentId: string;
  private readonly api: ControllerApi;
  private readonly openObserver: ObserverOpen;
  private readonly changed: (snapshot: BridgeControllerSnapshot) => void;
  private readonly tracker: BridgeOperationTracker;
  private readonly permissionStore: BridgePermissionStore;
  private selection = 0;
  private request?: AbortController;
  private stop?: () => void;
  private store?: BridgeSessionStore;
  private retry?: ReturnType<typeof setTimeout>;
  private retryFailures = 0;
  private closed = false;
  private current: BridgeControllerSnapshot = { connection: "offline", view: null, operations: [], permissions: [] };

  constructor(input: {
    agentId: string;
    api: ControllerApi;
    openObserver?: ObserverOpen;
    changed?: (snapshot: BridgeControllerSnapshot) => void;
  }) {
    this.agentId = input.agentId;
    this.api = input.api;
    this.openObserver = input.openObserver ?? openBridgeObserver;
    this.changed = input.changed ?? (() => {});
    this.permissionStore = new BridgePermissionStore(input.agentId, input.api);
    this.tracker = new BridgeOperationTracker({
      agentId: input.agentId,
      api: input.api,
      changed: () => {
        if (!this.closed)
          this.publish({ ...this.current, operations: this.tracker.snapshot });
      },
    });
  }

  get snapshot(): BridgeControllerSnapshot {
    return { ...this.current };
  }

  async select(sessionId: string | null, resetRetry = true): Promise<void> {
    if (this.closed) throw new Error("Bridge Agent controller is closed");
    if (resetRetry) this.retryFailures = 0;
    this.selection += 1;
    const selection = this.selection;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.request?.abort();
    this.stop?.();
    this.stop = undefined;
    this.store?.close();
    this.permissionStore.clear();
    this.store = sessionId === null ? undefined : new BridgeSessionStore(
      this.agentId, sessionId, this.api,
      (conversation) => {
        if (selection === this.selection && !this.closed)
          this.publish({ ...this.current, conversation });
      },
    );
    const request = new AbortController();
    this.request = request;
    this.publish({ connection: "connecting", view: null,
      operations: this.tracker.snapshot, permissions: [] });
    try {
      const stop = await this.openObserver({
        api: this.api,
        agentId: this.agentId,
        sessionId,
        signal: request.signal,
        onConnected: () => {
          if (selection === this.selection && !this.closed)
            this.retryFailures = 0;
        },
        onView: (view) => {
          if (selection !== this.selection || this.closed) return;
          if (Array.isArray(view.operations)) this.tracker.observe(view.operations);
          if (isRecord(view.selectedView) && Array.isArray(view.selectedView.operations))
            this.tracker.observe(view.selectedView.operations);
          const permissions = new Map<string, unknown>();
          if (Array.isArray(view.permissions))
            for (const item of view.permissions)
              if (isRecord(item) && typeof item.permissionId === "string")
                permissions.set(item.permissionId, item);
          if (isRecord(view.selectedView) && Array.isArray(view.selectedView.permissions))
            for (const item of view.selectedView.permissions)
              if (isRecord(item) && typeof item.permissionId === "string")
                permissions.set(item.permissionId, item);
          this.permissionStore.observe([...permissions.values()]);
          const conversation = view.selectedView === null
            ? undefined
            : this.store?.accept(view.selectedView, new Date(0).toISOString());
          this.publish({ connection: "ready", view, conversation,
            operations: this.tracker.snapshot,
            permissions: this.permissionStore.pending });
        },
        onResync: () => {
          if (selection === this.selection && !this.closed)
            queueMicrotask(() => {
              if (selection === this.selection && !this.closed)
                void this.select(sessionId).catch(() => {});
            });
        },
        onRevoked: () => {
          if (selection !== this.selection || this.closed) return;
          this.close(true);
        },
        onDisconnect: () => {
          if (selection !== this.selection || this.closed) return;
          this.publish({ ...this.current, connection: "offline" });
          this.scheduleRetry(selection, sessionId);
        },
      });
      if (selection !== this.selection || this.closed) stop();
      else this.stop = stop;
    } catch (cause) {
      if (selection !== this.selection || this.closed || request.signal.aborted) return;
      if (cause instanceof WorkspaceApiError &&
        (cause.status === 401 || cause.recovery === "login")) {
        this.close(false, true);
        throw cause;
      }
      if (cause instanceof WorkspaceApiError && cause.status === 403) {
        this.close(true);
        throw cause;
      }
      this.publish({ ...this.current, connection: "offline" });
      this.scheduleRetry(selection, sessionId);
      throw cause;
    }
  }

  loadMessageContent(messageId: string): Promise<void> {
    if (!this.store) return Promise.reject(new Error("No Bridge Session is selected"));
    return this.store.loadMessageContent(messageId);
  }

  loadProcess(turnId: string): Promise<void> {
    if (!this.store) return Promise.reject(new Error("No Bridge Session is selected"));
    return this.store.loadProcess(turnId);
  }

  unloadProcess(turnId: string): void {
    this.store?.unloadProcess(turnId);
  }

  loadOlderTurns(): Promise<void> {
    if (!this.store) return Promise.reject(new Error("No Bridge Session is selected"));
    return this.store.loadOlderTurns();
  }

  loadNewerTurns(): Promise<void> {
    if (!this.store) return Promise.reject(new Error("No Bridge Session is selected"));
    return this.store.loadNewerTurns();
  }

  showLatestTurns(): void {
    this.store?.showLatestTurns();
  }

  get hasOlderTurns(): boolean {
    return this.store?.olderTurnsCursor !== null && this.store?.olderTurnsCursor !== undefined;
  }

  get hasNewerTurns(): boolean {
    return this.store?.hasNewerTurns ?? false;
  }

  get historyGapAfter(): number | undefined {
    return this.store?.hasHistoryGap ? this.store.historyTurnCount : undefined;
  }

  submitPrompt(intentId: string, prompt: readonly ContentBlock[], signal?: AbortSignal): Promise<BridgeOperation> {
    if (this.current.connection !== "ready")
      return Promise.reject(new Error("A current Bridge connection is required"));
    const view = this.current.view;
    const selected = view?.selectedView;
    if (this.closed || view === null || view.selectedSessionId === null || !isRecord(selected) ||
      !Number.isSafeInteger(selected.appendVersion) || (selected.appendVersion as number) < 0 ||
      typeof selected.historyToken !== "string" || !selected.historyToken)
      return Promise.reject(new Error("A current Bridge Session View is required before Prompt submission"));
    return this.tracker.submit(view.selectedSessionId, {
      intentId,
      expectedAppendVersion: selected.appendVersion as number,
      historyToken: selected.historyToken,
      prompt,
    }, signal);
  }

  cancelOperation(sessionId: string, intentId: string, signal?: AbortSignal): Promise<BridgeOperation> {
    if (this.current.connection !== "ready")
      return Promise.reject(new Error("A current Bridge connection is required"));
    return this.tracker.cancel(sessionId, intentId, signal);
  }

  async decidePermission(id: string, optionId: string, signal?: AbortSignal): Promise<void> {
    if (this.current.connection !== "ready")
      throw new Error("A current Bridge connection is required");
    if (this.closed) return Promise.reject(new Error("Bridge Agent controller is closed"));
    const selection = this.selection;
    const selectedSessionId = this.current.view?.selectedSessionId ?? null;
    try {
      await this.permissionStore.decide(id, optionId, signal);
    } catch (cause) {
      if (!(cause instanceof WorkspaceApiError) ||
        (cause.status !== undefined && cause.status < 500) ||
        this.closed || this.selection !== selection) throw cause;
      try { await this.select(selectedSessionId); }
      catch (readError) {
        if (readError instanceof WorkspaceApiError &&
          (readError.status === 401 || readError.status === 403)) throw readError;
        throw cause;
      }
      if (this.selection === selection + 1 && this.current.connection === "ready" &&
        this.current.view?.selectedSessionId === selectedSessionId &&
        !this.permissionStore.pending.some((item) => item.id === id)) return;
      throw cause;
    }
  }

  async setConfiguration(id: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    if (this.current.connection !== "ready")
      throw new Error("A current Bridge connection is required");
    const view = this.current.view;
    const session = view?.selectedView;
    if (this.closed || view === null || view.selectedSessionId === null ||
      !isRecord(session) || typeof session.configurationToken !== "string" ||
      !session.configurationToken || !Array.isArray(session.configOptions))
      throw new Error("A current configuration View is required");
    if (!session.configOptions.some((option) => advertised(option, id, value)))
      throw new Error("Configuration value is not advertised");
    const selectedSessionId = view.selectedSessionId;
    const selection = this.selection;
    let commandFailure: unknown;
    let failed = false;
    try {
      await this.api.configuration(
        this.agentId, selectedSessionId, id, value, session.configurationToken, signal,
      );
    } catch (cause) {
      commandFailure = cause;
      failed = true;
    }
    let refreshed = false;
    if (!this.closed && this.selection === selection &&
      this.current.view?.selectedSessionId === selectedSessionId) {
      try {
        await this.select(selectedSessionId);
        refreshed = true;
      }
      catch (cause) { if (!failed) throw cause; }
    }
    if (failed) {
      const currentSession = this.current.view?.selectedView;
      if (refreshed && isRecord(currentSession) &&
        Array.isArray(currentSession.configOptions) &&
        currentSession.configOptions.some((option) => isRecord(option) &&
          option.id === id && option.currentValue === value)) return;
      throw commandFailure;
    }
  }

  close(revoked = false, unauthenticated = false): void {
    if (this.closed) return;
    this.closed = true;
    this.selection += 1;
    clearTimeout(this.retry);
    this.request?.abort();
    this.stop?.();
    this.store?.close();
    this.tracker.close();
    this.permissionStore.clear();
    this.publish({ connection: "offline", view: null, operations: [], permissions: [],
      ...(revoked ? { revoked: true } : {}),
      ...(unauthenticated ? { unauthenticated: true } : {}) });
  }

  private publish(snapshot: BridgeControllerSnapshot): void {
    this.current = snapshot;
    this.changed(this.snapshot);
  }

  private scheduleRetry(selection: number, sessionId: string | null): void {
    clearTimeout(this.retry);
    const delayMs = Math.min(1_000 * 2 ** Math.min(this.retryFailures, 5), 30_000);
    this.retryFailures = Math.min(this.retryFailures + 1, 5);
    this.retry = setTimeout(() => {
      if (selection === this.selection && !this.closed)
        void this.select(sessionId, false).catch(() => {});
    }, delayMs);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function advertised(raw: unknown, id: string, value: string | boolean): boolean {
  if (!isRecord(raw) || raw.id !== id) return false;
  if (raw.type === "boolean") return typeof value === "boolean";
  if (raw.type !== "select" || typeof value !== "string" || !Array.isArray(raw.options))
    return false;
  return raw.options.some((item) => isRecord(item) && (
    item.value === value || (Array.isArray(item.options) && item.options.some(
      (choice) => isRecord(choice) && choice.value === value,
    ))
  ));
}
