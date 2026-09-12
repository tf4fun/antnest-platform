import { EventEmitter } from "node:events";
import { DomainError } from "../domain/errors.js";
import type {
  PermissionConnection,
  PermissionConnectionsPort,
  PermissionOwner,
  PermissionRequest,
} from "../ports/tool-permissions.js";

type Attached = { connection: PermissionConnection; lifetime: AbortController; detach: () => void };

export class PermissionConnections implements PermissionConnectionsPort {
  private readonly sessions = new Map<string, Attached>();
  private readonly changed = new EventEmitter();

  public detach(sessionId: string): void {
    this.sessions.get(sessionId)?.detach();
  }

  public attach(connection: PermissionConnection): void {
    if (connection.signal.aborted) return;
    const key = connection.sessionId;
    const previous = this.sessions.get(key);
    if (previous?.connection.binding.connectionId === connection.binding.connectionId) return;
    previous?.detach();
    const lifetime = new AbortController();
    const attached: Attached = {
      connection,
      lifetime,
      detach: () => {
        connection.signal.removeEventListener("abort", attached.detach);
        if (this.sessions.get(key) === attached) this.sessions.delete(key);
        lifetime.abort(
          new DomainError("permission_connection_changed", "Permission connection changed"),
        );
        this.changed.emit(key);
      },
    };
    this.sessions.set(key, attached);
    connection.signal.addEventListener("abort", attached.detach, { once: true });
    this.changed.emit(key);
  }

  public async request(
    request: PermissionRequest,
    owner: PermissionOwner,
    signal: AbortSignal,
    assertAccess: (connection: PermissionConnection) => Promise<void>,
  ) {
    for (;;) {
      signal.throwIfAborted();
      const attached = await this.connection(request.sessionId, owner, signal);
      const active = AbortSignal.any([signal, attached.lifetime.signal]);
      try {
        await untilAborted(assertAccess(attached.connection), active);
        active.throwIfAborted();
        const response = await untilAborted(attached.connection.request(request, active), active);
        await untilAborted(assertAccess(attached.connection), active);
        active.throwIfAborted();
        return response;
      } catch (error) {
        signal.throwIfAborted();
        if (!attached.lifetime.signal.aborted) throw error;
      }
    }
  }

  private async connection(
    sessionId: string,
    owner: PermissionOwner,
    signal: AbortSignal,
  ): Promise<Attached> {
    for (;;) {
      signal.throwIfAborted();
      const current = this.sessions.get(sessionId);
      const binding = current?.connection.binding;
      if (
        binding?.agentId === owner.agentId &&
        binding.principalId === owner.principalId &&
        binding.accessRevision === owner.accessRevision
      )
        return current!;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(abortError(signal));
        };
        const cleanup = () => {
          this.changed.off(sessionId, finish);
          signal.removeEventListener("abort", abort);
        };
        this.changed.once(sessionId, finish);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
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
