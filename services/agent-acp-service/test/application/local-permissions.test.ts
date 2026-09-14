import { describe, expect, it, vi } from "vitest";
import { AccessService } from "../../src/application/access-service.js";
import { PermissionConnections } from "../../src/application/permission-connections.js";
import { ToolPermissions } from "../../src/application/tool-permissions.js";
import type { PermissionRepository, PermissionRequest } from "../../src/ports/tool-permissions.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import { localExecution } from "../support/local-execution.js";

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

async function setup() {
  const local = await localExecution();
  const access = new AccessService({ directory: local.directory });
  const connections = new PermissionConnections();
  const owner = { ...executionIdentity(), accessRevision: "access-1" };
  const repository = {
    open: vi.fn<PermissionRepository["open"]>().mockResolvedValue(owner),
    decide: vi.fn<PermissionRepository["decide"]>().mockResolvedValue(true),
    cancelAbandoned: vi.fn<PermissionRepository["cancelAbandoned"]>().mockResolvedValue(),
  };
  const lifetime = new AbortController();
  const reply = Promise.withResolvers<unknown>();
  const asked = Promise.withResolvers<void>();
  connections.attach({
    binding: { ...executionIdentity(), connectionId: "connection-1" },
    sessionId: request.sessionId,
    signal: lifetime.signal,
    request: () => {
      asked.resolve();
      return reply.promise;
    },
  });
  const cancellation = new AbortController();
  const service = new ToolPermissions(repository, connections, access);
  const input = {
    ...request,
    signal: cancellation.signal,
    authoritySignal: new AbortController().signal,
  };
  const allow = () => reply.resolve({ outcome: { outcome: "selected", optionId: "allow_always" } });
  return {
    local,
    access,
    repository,
    connections,
    lifetime,
    asked,
    reply,
    allow,
    service,
    input,
    cancellation,
    owner,
  };
}

describe("local permission authority", () => {
  it("orders approval persistence before a revocation can acknowledge", async () => {
    const h = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.repository.decide.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return true;
    });
    const permission = h.service.request(h.input);
    await h.asked.promise;
    h.allow();
    await entered.promise;
    const revoked = executionConfiguration();
    revoked.revision = 2;
    revoked.agents[0]!.principal_ids = [];
    let applied = false;
    const applying = h.local.directory.apply(revoked).then(() => {
      applied = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(applied).toBe(false);
    } finally {
      release.resolve();
      await permission;
      await applying;
      h.lifetime.abort();
    }
    expect(await permission).toMatchObject({ decision: "allow_always" });
  });

  it("does not preserve a remembered rule from an older access revision", async () => {
    const h = await setup();
    h.owner.accessRevision = "access-before-revocation";
    h.allow();
    try {
      expect(await h.service.request(h.input)).toEqual({
        decision: "cancelled",
        reason: "permission_stale",
      });
      expect(h.repository.decide).toHaveBeenCalledOnce();
      expect(h.repository.decide.mock.calls[0]?.[0].rule).toBeUndefined();
      expect(h.repository.decide.mock.calls[0]?.[0].result.decision).toBe("cancelled");
    } finally {
      h.lifetime.abort();
    }
  });

  it("does not block configuration publication while the user is deciding", async () => {
    const h = await setup();
    const pending = h.service.request(h.input);
    await h.asked.promise;
    const revoked = executionConfiguration();
    revoked.revision = 2;
    revoked.agents[0]!.principal_ids = [];
    try {
      await h.local.directory.apply(revoked);
      h.allow();
      expect(await pending).toMatchObject({ decision: "cancelled", reason: "access_denied" });
      expect(h.repository.decide.mock.calls[0]?.[0].rule).toBeUndefined();
    } finally {
      h.cancellation.abort();
      h.allow();
      await pending;
      h.lifetime.abort();
    }
  });

  it("preserves a real storage failure instead of manufacturing a permission result", async () => {
    const h = await setup();
    const failure = new Error("storage write failed");
    h.repository.decide.mockRejectedValue(failure);
    h.allow();
    try {
      await expect(h.service.request(h.input)).rejects.toBe(failure);
      expect(h.repository.decide).toHaveBeenCalledOnce();
    } finally {
      h.lifetime.abort();
    }
  });
});
