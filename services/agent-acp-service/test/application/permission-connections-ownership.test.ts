import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { PermissionConnections } from "../../src/application/permission-connections.js";
import type {
  PermissionConnection,
  PermissionOwner,
  PermissionRequest,
} from "../../src/ports/tool-permissions.js";
import { ConnectionTasks } from "../../src/transport/acp/connection-tasks.js";
import { binding } from "../support/fixtures.js";

const request: PermissionRequest = {
  runId: "run-1",
  sessionId: "session-1",
  call: { id: "call-1", name: "write", arguments: { path: "/tmp/test", content: "data" } },
  tool: {
    source: "runtime",
    sourceId: "runtime",
    name: "write",
    modelName: "write",
    description: "write",
  },
};
const approval = { outcome: { outcome: "selected", optionId: "allow_always" } };

describe("permission connection task ownership", () => {
  it.each(["pre", "post"] as const)(
    "retains the raw %s-request access check after connection cancellation",
    async (phase) => {
      const connections = new PermissionConnections();
      const identity = binding();
      const owner: PermissionOwner = { ...identity, accessRevision: "access-1" };
      const tasks = new ConnectionTasks();
      const lifetime = new AbortController();
      const cancellation = new AbortController();
      const cancelled = new Error("Permission caller cancelled");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const handler = vi.fn<PermissionConnection["request"]>().mockResolvedValue(approval);
      let assertions = 0;
      const assertAccess = vi.fn<(connection: PermissionConnection) => Promise<void>>(() => {
        assertions += 1;
        if (assertions === (phase === "pre" ? 1 : 2)) {
          entered.resolve();
          return release.promise;
        }
        return Promise.resolve();
      });
      const connection = {
        binding: identity,
        sessionId: request.sessionId,
        signal: lifetime.signal,
        tasks,
        request: handler,
      };
      connections.attach(connection);
      const approved = vi.fn();
      const operation = connections.request(request, owner, cancellation.signal, assertAccess);
      const observed = operation.then(
        (response) => {
          approved(response);
          return { status: "approved", response };
        },
        (error: unknown) => ({ status: "cancelled", error }),
      );
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        await entered.promise;
        lifetime.abort(new Error("Permission connection closed"));
        closing = tasks.close().then(() => {
          closed = true;
        });
        cancellation.abort(cancelled);
        expect(await observed).toEqual({ status: "cancelled", error: cancelled });
        await setImmediate();
        expect(closed).toBe(false);
        expect(handler).toHaveBeenCalledTimes(phase === "pre" ? 0 : 1);
        expect(approved).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        lifetime.abort();
        cancellation.abort(cancelled);
        closing ??= tasks.close().then(() => {
          closed = true;
        });
        await Promise.allSettled([release.promise, operation, observed, closing]);
      }
      expect(closed).toBe(true);
      expect(handler).toHaveBeenCalledTimes(phase === "pre" ? 0 : 1);
      expect(approved).not.toHaveBeenCalled();
    },
  );

  it("does not start the post-response access check when the connection aborts with the reply", async () => {
    const connections = new PermissionConnections();
    const identity = binding();
    const owner: PermissionOwner = { ...identity, accessRevision: "access-1" };
    const tasks = new ConnectionTasks();
    const lifetime = new AbortController();
    const cancellation = new AbortController();
    const cancelled = new Error("Permission caller cancelled");
    const asked = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<unknown>();
    const handler = vi.fn<PermissionConnection["request"]>(() => {
      asked.resolve();
      return reply.promise;
    });
    const assertAccess = vi
      .fn<(connection: PermissionConnection) => Promise<void>>()
      .mockResolvedValue();
    const connection = {
      binding: identity,
      sessionId: request.sessionId,
      signal: lifetime.signal,
      tasks,
      request: handler,
    };
    connections.attach(connection);
    const approved = vi.fn();
    const operation = connections.request(request, owner, cancellation.signal, assertAccess);
    const observed = operation.then(
      (response) => {
        approved(response);
        return { status: "approved", response };
      },
      (error: unknown) => ({ status: "cancelled", error }),
    );
    let closing: Promise<void> | undefined;
    try {
      await asked.promise;
      reply.resolve(approval);
      queueMicrotask(() => lifetime.abort(new Error("Permission connection closed")));
      await setImmediate();
      closing = tasks.close();
      cancellation.abort(cancelled);
      expect(await observed).toEqual({ status: "cancelled", error: cancelled });
      expect(assertAccess).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledOnce();
      expect(approved).not.toHaveBeenCalled();
    } finally {
      reply.resolve(approval);
      lifetime.abort();
      cancellation.abort(cancelled);
      closing ??= tasks.close();
      await Promise.allSettled([reply.promise, operation, observed, closing]);
    }
  });
});
