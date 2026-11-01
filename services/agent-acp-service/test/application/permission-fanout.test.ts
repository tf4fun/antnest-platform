import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionConnections } from "../../src/application/permission-connections.js";
import { DomainError } from "../../src/domain/errors.js";
import type {
  PermissionConnection,
  PermissionOwner,
  PermissionRequest,
} from "../../src/ports/tool-permissions.js";
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
const approval = (optionId = "allow_once") => ({
  outcome: { outcome: "selected", optionId },
});

describe("permission connection fan-out", () => {
  afterEach(() => vi.useRealTimers());

  function setup(timeoutMs = 60_000) {
    const connections = new PermissionConnections(timeoutMs);
    const owner: PermissionOwner = { ...binding(), accessRevision: "access-1" };
    const assertAccess = vi
      .fn<(connection: PermissionConnection) => Promise<void>>()
      .mockResolvedValue(undefined);
    const caller = new AbortController();
    const attached = (
      handler: PermissionConnection["request"],
      id: string,
      overrides: Partial<PermissionConnection["binding"]> = {},
      resolved?: PermissionConnection["resolved"],
    ) => {
      const lifetime = new AbortController();
      const signal = Promise.withResolvers<AbortSignal>();
      const connection: PermissionConnection = {
        binding: { ...binding(), connectionId: id, ...overrides },
        sessionId: request.sessionId,
        signal: lifetime.signal,
        request: (value, active) => {
          signal.resolve(active);
          return handler(value, active);
        },
        ...(resolved === undefined ? {} : { resolved }),
      };
      connections.attach(connection);
      return { lifetime, connection, handler, signal: signal.promise };
    };
    const pending = () => connections.request(request, owner, caller.signal, assertAccess);
    return { connections, owner, assertAccess, caller, attached, pending };
  }

  it("fans one request to every matching attachment and commits the first authorized answer", async () => {
    const h = setup();
    const slow = Promise.withResolvers<unknown>();
    const fast = Promise.withResolvers<unknown>();
    const first = h.attached(
      vi.fn(() => fast.promise),
      "first",
    );
    const second = h.attached(
      vi.fn(() => slow.promise),
      "second",
    );
    const pending = h.pending();
    await vi.waitFor(() => {
      expect(first.handler).toHaveBeenCalledOnce();
      expect(second.handler).toHaveBeenCalledOnce();
    });
    fast.resolve(approval("allow_always"));
    expect(await pending).toEqual(approval("allow_always"));
    expect((await first.signal).aborted).toBe(false);
    const losing = await second.signal;
    expect(losing.aborted).toBe(true);
    expect(losing.reason).toBeInstanceOf(DomainError);
    expect((losing.reason as DomainError).code).toBe("permission_stale");
    slow.resolve(approval("reject_always"));
    await setImmediate();
    expect(h.assertAccess.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("issues the pending request to a connection attached after the wait began", async () => {
    const h = setup();
    const pending = h.pending();
    await setImmediate();
    const late = h.attached(
      vi.fn(() => Promise.resolve(approval("reject_once"))),
      "late",
    );
    await vi.waitFor(() => expect(late.handler).toHaveBeenCalledOnce());
    expect(await pending).toEqual(approval("reject_once"));
  });

  it.each(["principalId", "organizationId", "agentId"] as const)(
    "does not fan a request to an attachment outside the owner %s",
    async (field) => {
      const h = setup();
      const foreign = h.attached(
        vi.fn(() => Promise.resolve(approval())),
        "foreign",
        {
          [field]: "other",
        },
      );
      const pending = h.pending();
      await setImmediate();
      expect(foreign.handler).not.toHaveBeenCalled();
      const matching = h.attached(
        vi.fn(() => Promise.resolve(approval())),
        "matching",
      );
      await vi.waitFor(() => expect(matching.handler).toHaveBeenCalledOnce());
      expect(await pending).toEqual(approval());
      expect(foreign.handler).not.toHaveBeenCalled();
      h.caller.abort();
    },
  );

  it("lets a healthy peer answer after another attachment fails", async () => {
    const h = setup();
    h.attached(
      vi.fn(() => Promise.reject(new Error("Method not found"))),
      "broken",
    );
    h.attached(
      vi.fn(() => Promise.resolve(approval("allow_once"))),
      "healthy",
    );
    expect(await h.pending()).toEqual(approval("allow_once"));
  });

  it("rejects the request once every current matching attempt has failed", async () => {
    const h = setup();
    h.attached(
      vi.fn(() => Promise.reject(new Error("Method not found"))),
      "broken",
    );
    h.attached(
      vi.fn(() => Promise.reject(new Error("Permission denied"))),
      "second",
    );
    await expect(h.pending()).rejects.toThrow("Method not found");
  });

  it("ignores a malformed reply while a valid peer answer still wins", async () => {
    const h = setup();
    h.attached(
      vi.fn(() => Promise.resolve({ outcome: { outcome: "selected", optionId: "bogus" } })),
      "malformed",
    );
    const healthy = h.attached(
      vi.fn(() => Promise.resolve(approval("reject_once"))),
      "healthy",
    );
    expect(await h.pending()).toEqual(approval("reject_once"));
    expect(healthy.handler).toHaveBeenCalledOnce();
  });

  it("treats an explicit cancelled outcome as a valid peer answer", async () => {
    const h = setup();
    h.attached(
      vi.fn(() => Promise.resolve({ outcome: { outcome: "cancelled" } })),
      "first",
    );
    expect(await h.pending()).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("keeps the request alive on surviving peers when one attachment detaches", async () => {
    const h = setup();
    const slow = Promise.withResolvers<unknown>();
    const dying = h.attached(
      vi.fn(() => slow.promise),
      "dying",
    );
    const answer = Promise.withResolvers<unknown>();
    const healthy = h.attached(
      vi.fn(() => answer.promise),
      "healthy",
    );
    const pending = h.pending();
    await vi.waitFor(() => {
      expect(dying.handler).toHaveBeenCalledOnce();
      expect(healthy.handler).toHaveBeenCalledOnce();
    });
    dying.lifetime.abort(new Error("Permission connection closed"));
    expect((await dying.signal).aborted).toBe(true);
    answer.resolve(approval("reject_once"));
    expect(await pending).toEqual(approval("reject_once"));
    slow.resolve(approval("allow_always"));
  });

  it("cannot accept a late reply from a detached attachment", async () => {
    const h = setup();
    const slow = Promise.withResolvers<unknown>();
    const dying = h.attached(
      vi.fn(() => slow.promise),
      "dying",
    );
    const pending = h.pending();
    await vi.waitFor(() => expect(dying.handler).toHaveBeenCalledOnce());
    dying.lifetime.abort(new Error("Permission connection closed"));
    slow.resolve(approval("allow_always"));
    const healthy = h.attached(
      vi.fn(() => Promise.resolve(approval("reject_once"))),
      "healthy",
    );
    expect(await pending).toEqual(approval("reject_once"));
    expect(healthy.handler).toHaveBeenCalledOnce();
  });

  it("keeps the first attachment when the same connection id attaches again", async () => {
    const h = setup();
    h.attached(
      vi.fn(() => Promise.resolve(approval("allow_once"))),
      "shared",
    );
    const replacement = vi.fn(() => Promise.resolve(approval("reject_always")));
    const duplicate = new AbortController();
    h.connections.attach({
      binding: { ...binding(), connectionId: "shared" },
      sessionId: request.sessionId,
      signal: duplicate.signal,
      request: replacement,
    });
    expect(await h.pending()).toEqual(approval("allow_once"));
    expect(replacement).not.toHaveBeenCalled();
    duplicate.abort();
  });

  it("ends an attachment-less wait as permission_timeout", async () => {
    vi.useFakeTimers();
    const h = setup(100);
    const pending = h.pending();
    const rejected = expect(pending).rejects.toMatchObject({ code: "permission_timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it("does not restart the approval deadline across attachments", async () => {
    vi.useFakeTimers();
    const h = setup(100);
    const first = h.attached(
      vi.fn(() => new Promise(() => undefined)),
      "first",
    );
    const pending = h.pending();
    const rejected = expect(pending).rejects.toMatchObject({ code: "permission_timeout" });
    await vi.advanceTimersByTimeAsync(50);
    expect(first.handler).toHaveBeenCalledOnce();
    first.lifetime.abort(new Error("Permission connection closed"));
    const second = h.attached(
      vi.fn(() => new Promise(() => undefined)),
      "second",
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(second.handler).toHaveBeenCalledOnce();
    await rejected;
  });

  it("lets caller cancellation beat a peer answer in flight", async () => {
    const h = setup();
    const answer = Promise.withResolvers<unknown>();
    const peer = h.attached(
      vi.fn(() => answer.promise),
      "peer",
    );
    const pending = h.pending();
    await vi.waitFor(() => expect(peer.handler).toHaveBeenCalledOnce());
    const cancelled = new Error("Run cancelled");
    h.caller.abort(cancelled);
    answer.resolve(approval("allow_always"));
    await expect(pending).rejects.toBe(cancelled);
  });

  it("detaches revoked attachments, ignores their late replies and keeps waiting", async () => {
    const h = setup();
    const slow = Promise.withResolvers<unknown>();
    const first = h.attached(
      vi.fn(() => slow.promise),
      "first",
    );
    const second = h.attached(
      vi.fn(() => slow.promise),
      "second",
    );
    const foreignHandler = vi.fn(() => Promise.resolve(approval("allow_once")));
    h.attached(foreignHandler, "foreign", { organizationId: "other-organization" });
    const pending = h.pending();
    await vi.waitFor(() => {
      expect(first.handler).toHaveBeenCalledOnce();
      expect(second.handler).toHaveBeenCalledOnce();
    });
    expect(foreignHandler).not.toHaveBeenCalled();
    h.connections.revokeAccess({ organization_id: binding().organizationId, agents: [] });
    expect((await first.signal).aborted).toBe(true);
    expect((await second.signal).aborted).toBe(true);
    slow.resolve(approval("allow_always"));
    const eligible = h.attached(
      vi.fn(() => Promise.resolve(approval("reject_once"))),
      "eligible",
    );
    expect(await pending).toEqual(approval("reject_once"));
    expect(eligible.handler).toHaveBeenCalledOnce();
    const foreignOwner: PermissionOwner = {
      ...binding(),
      organizationId: "other-organization",
      accessRevision: "access-1",
    };
    await expect(
      h.connections.request(request, foreignOwner, h.caller.signal, h.assertAccess),
    ).resolves.toEqual(approval("allow_once"));
    expect(foreignHandler).toHaveBeenCalledOnce();
  });

  it("keeps waiting through revocation until the approval deadline", async () => {
    vi.useFakeTimers();
    const h = setup(100);
    const first = h.attached(
      vi.fn(() => new Promise(() => undefined)),
      "first",
    );
    const pending = h.pending();
    const rejected = expect(pending).rejects.toMatchObject({ code: "permission_timeout" });
    await vi.advanceTimersByTimeAsync(50);
    expect(first.handler).toHaveBeenCalledOnce();
    h.connections.revokeAccess({ organization_id: binding().organizationId, agents: [] });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  });

  it("fans a resolution notice to every matching attachment and swallows failures", async () => {
    const h = setup();
    const resolvedFirst = vi.fn().mockResolvedValue(undefined);
    const resolvedFailing = vi.fn().mockRejectedValue(new Error("notice failed"));
    const resolvedForeign = vi.fn().mockResolvedValue(undefined);
    h.attached(vi.fn(), "first", {}, resolvedFirst);
    h.attached(vi.fn(), "failing", {}, resolvedFailing);
    h.attached(vi.fn(), "foreign", { principalId: "other" }, resolvedForeign);
    expect(() => h.connections.resolve(request, h.owner, "permission_resolved")).not.toThrow();
    await vi.waitFor(() => {
      expect(resolvedFirst).toHaveBeenCalledWith(request, "permission_resolved");
      expect(resolvedFailing).toHaveBeenCalledOnce();
    });
    expect(resolvedForeign).not.toHaveBeenCalled();
  });
});
