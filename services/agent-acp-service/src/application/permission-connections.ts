import { EventEmitter } from "node:events";
import { DomainError } from "../domain/errors.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
} from "../domain/execution-configuration.js";
import { permissionChoices } from "../domain/tool-permissions.js";
import type {
  PermissionConnection,
  PermissionConnectionsPort,
  PermissionOwner,
  PermissionRequest,
  PermissionResolution,
} from "../ports/tool-permissions.js";

type Attached = { connection: PermissionConnection; lifetime: AbortController; detach: () => void };
const MAX_TIMER_MS = 2_147_483_647;

export class PermissionConnections implements PermissionConnectionsPort {
  private readonly sessions = new Map<string, Map<string, Attached>>();
  private readonly changed = new EventEmitter();

  public constructor(private readonly permissionTimeoutMs = 600_000) {
    if (
      !Number.isInteger(permissionTimeoutMs) ||
      permissionTimeoutMs < 1 ||
      permissionTimeoutMs > MAX_TIMER_MS
    )
      throw new Error("Permission timeout must be an integer from 1 to 2147483647");
  }

  public detach(sessionId: string): void {
    for (const attached of [...(this.sessions.get(sessionId)?.values() ?? [])]) attached.detach();
  }

  public revokeAccess(snapshot: ExecutionAccessSnapshot): void {
    for (const attachments of this.sessions.values())
      for (const attached of [...attachments.values()])
        if (isExecutionAccessRevoked(snapshot, attached.connection.binding)) attached.detach();
  }

  public attach(connection: PermissionConnection): void {
    if (connection.signal.aborted) return;
    const key = connection.sessionId;
    const id = connection.binding.connectionId;
    let attachments = this.sessions.get(key);
    if (attachments === undefined) {
      attachments = new Map();
      this.sessions.set(key, attachments);
    }
    if (attachments.has(id)) return;
    const lifetime = new AbortController();
    const attached: Attached = {
      connection,
      lifetime,
      detach: () => {
        connection.signal.removeEventListener("abort", attached.detach);
        const current = this.sessions.get(key);
        if (current?.get(id) === attached) {
          current.delete(id);
          if (current.size === 0) this.sessions.delete(key);
        }
        lifetime.abort(
          new DomainError("permission_connection_changed", "Permission connection changed"),
        );
        this.changed.emit(key);
      },
    };
    attachments.set(id, attached);
    connection.signal.addEventListener("abort", attached.detach, { once: true });
    this.changed.emit(key);
  }

  public resolve(
    request: PermissionRequest,
    owner: PermissionOwner,
    reason: PermissionResolution,
  ): void {
    for (const attached of this.matching(request.sessionId, owner)) {
      if (attached.lifetime.signal.aborted || attached.connection.resolved === undefined) continue;
      const send = () => attached.connection.resolved!(request, reason);
      void (
        attached.connection.tasks === undefined
          ? Promise.resolve().then(send)
          : attached.connection.tasks.run(send)
      ).catch(() => undefined);
    }
  }

  public async request(
    request: PermissionRequest,
    owner: PermissionOwner,
    signal: AbortSignal,
    assertAccess: (connection: PermissionConnection) => Promise<void>,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const settled = Promise.withResolvers<unknown>();
    const attempts = new Map<Attached, AbortController>();
    let done = false;
    let pending = 0;
    let failed = 0;
    let firstFailure: unknown;
    const timeout = setTimeout(
      () => fail(new DomainError("permission_timeout", "Permission request timed out")),
      this.permissionTimeoutMs,
    );
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onCallerAbort);
      this.changed.off(request.sessionId, pump);
    };
    const win = (response: unknown, winner: Attached) => {
      if (done) return;
      done = true;
      cleanup();
      const stale = new DomainError(
        "permission_stale",
        "Permission request was resolved by another connection",
      );
      for (const [attached, controller] of attempts)
        if (attached !== winner) controller.abort(stale);
      settled.resolve(response);
    };
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      const reason =
        error instanceof Error ? error : new Error("Permission request failed", { cause: error });
      for (const controller of attempts.values()) controller.abort(reason);
      settled.reject(error);
    };
    const onCallerAbort = () => fail(signal.reason);
    const pump = () => {
      if (done) return;
      for (const attached of this.matching(request.sessionId, owner)) {
        if (attempts.has(attached) || attached.lifetime.signal.aborted) continue;
        const controller = new AbortController();
        attempts.set(attached, controller);
        pending += 1;
        void attempt(attached, controller);
      }
    };
    const attempt = async (attached: Attached, controller: AbortController) => {
      try {
        const active = AbortSignal.any([signal, attached.lifetime.signal, controller.signal]);
        const checkAccess = () => {
          const check = () => assertAccess(attached.connection);
          return attached.connection.tasks === undefined
            ? check()
            : attached.connection.tasks.run(check);
        };
        active.throwIfAborted();
        await untilAborted(checkAccess(), active);
        active.throwIfAborted();
        const response = await untilAborted(attached.connection.request(request, active), active);
        active.throwIfAborted();
        await untilAborted(checkAccess(), active);
        active.throwIfAborted();
        if (!isPermissionResponse(response)) throw new Error("Permission response was not valid");
        win(response, attached);
      } catch (error) {
        if (signal.aborted) {
          fail(signal.reason);
        } else if (!done && !controller.signal.aborted) {
          if (attached.lifetime.signal.aborted) {
            attempts.delete(attached);
          } else {
            failed += 1;
            firstFailure ??= error;
          }
        }
      } finally {
        pending -= 1;
        if (!done && pending === 0 && failed > 0 && failed === attempts.size) fail(firstFailure);
      }
    };
    signal.addEventListener("abort", onCallerAbort, { once: true });
    this.changed.on(request.sessionId, pump);
    try {
      pump();
      return await settled.promise;
    } finally {
      done = true;
      cleanup();
    }
  }

  private matching(sessionId: string, owner: PermissionOwner): Attached[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].filter(
      (attached) =>
        attached.connection.binding.agentId === owner.agentId &&
        attached.connection.binding.principalId === owner.principalId &&
        attached.connection.binding.organizationId === owner.organizationId,
    );
  }
}

function isPermissionResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  if (typeof outcome !== "object" || outcome === null) return false;
  const kind = (outcome as { outcome?: unknown }).outcome;
  if (kind === "cancelled") return true;
  if (kind !== "selected") return false;
  const optionId = (outcome as { optionId?: unknown }).optionId;
  return (
    typeof optionId === "string" && permissionChoices.some((choice) => choice.optionId === optionId)
  );
}

export function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(
          error instanceof Error
            ? error
            : new Error("Permission operation failed", { cause: error }),
        );
      },
    );
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Permission request cancelled", "AbortError");
}
