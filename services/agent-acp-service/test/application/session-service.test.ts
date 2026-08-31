import { describe, expect, it, vi } from "vitest";

import { SessionService } from "../../src/application/session-service.js";
import type { SessionRepository } from "../../src/ports/session-repository.js";
import type { ConnectionBinding, SessionRecord } from "../../src/domain/types.js";

const binding: ConnectionBinding = {
  connectionId: "connection-1",
  agentAccessSubject: "subject-1",
  principalId: "principal-1",
  agentId: "agent-1",
  accessRevision: "access-1",
};

describe("SessionService", () => {
  it("creates one durable Session with a complete normalized MCP revision", async () => {
    const repository = createRepository();
    const service = createService(repository.port);

    await expect(
      service.createSession({
        binding,
        cwd: "/workspace",
        additionalDirectories: [],
        mcpServers: [
          {
            type: "http",
            name: "knowledge",
            url: "https://mcp.example.test/service",
            headers: [{ name: "Authorization", value: "secret" }],
          },
        ],
      }),
    ).resolves.toEqual({ sessionId: "id-1" });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "id-1",
        binding,
        cwd: "/workspace",
        mcpRevisionId: "id-2",
        mcpSources: [
          expect.objectContaining({
            name: "knowledge",
            url: "https://mcp.example.test/service",
          }),
        ],
      }),
    );
  });

  it("replaces MCP sources and always projects the current durable Run state on resume", async () => {
    const repository = createRepository();
    const service = createService(repository.port);

    await expect(
      service.resumeSession({
        binding,
        sessionId: "session-1",
        cwd: "/workspace",
        additionalDirectories: [],
        mcpServers: [],
        replayFromStart: false,
      }),
    ).resolves.toEqual({ replay: [{ kind: "state", state: "idle", stopReason: "end_turn" }] });
    expect(repository.replaceMcpAndActivate).toHaveBeenCalledWith(
      expect.objectContaining({ mcpSources: [] }),
    );
    expect(repository.replay).not.toHaveBeenCalled();
    expect(repository.getCurrentRunState).toHaveBeenCalledWith("session-1");

    repository.replay.mockResolvedValueOnce([
      {
        kind: "user_message",
        messageId: "message-1",
        content: [{ type: "text", text: "past" }],
      },
    ]);
    await expect(
      service.resumeSession({
        binding,
        sessionId: "session-1",
        cwd: "/workspace",
        additionalDirectories: [],
        mcpServers: [],
        replayFromStart: true,
      }),
    ).resolves.toEqual({
      replay: [
        {
          kind: "user_message",
          messageId: "message-1",
          content: [{ type: "text", text: "past" }],
        },
        { kind: "state", state: "idle", stopReason: "end_turn" },
      ],
    });
    expect(repository.replay).toHaveBeenCalledOnce();
  });

  it("never exposes Sessions owned by another principal through list", async () => {
    const repository = createRepository();
    const service = createService(repository.port);

    await service.listSessions({ binding, cwd: "/workspace" });

    expect(repository.list).toHaveBeenCalledWith({
      principalId: "principal-1",
      agentId: "agent-1",
      cwd: "/workspace",
      cursor: undefined,
      limit: 50,
    });
  });

  it("persists cancellation before changing Session lifecycle state", async () => {
    const repository = createRepository();
    const service = createService(repository.port);

    await service.requestCancellation("session-1", binding);
    await service.closeSession({ binding, sessionId: "session-1" });
    await service.deleteSession({ binding, sessionId: "session-1" });

    const at = new Date("2026-08-30T00:00:01Z");
    expect(repository.requestCancellation).toHaveBeenCalledWith("session-1", at);
    expect(repository.close).toHaveBeenCalledWith("session-1", at);
    expect(repository.delete).toHaveBeenCalledWith("session-1", at);
  });
});

function createRepository() {
  const session: SessionRecord = {
    id: "session-1",
    principalId: "principal-1",
    agentId: "agent-1",
    cwd: "/workspace",
    state: "closed",
    clientMcpRevisionId: "mcp-1",
    lastExecutionRevision: null,
    lastMessageSequence: 0,
    createdAt: new Date("2026-08-30T00:00:00Z"),
    updatedAt: new Date("2026-08-30T00:00:00Z"),
  };
  const create = vi.fn<SessionRepository["create"]>(() => Promise.resolve());
  const list = vi.fn<SessionRepository["list"]>(() =>
    Promise.resolve({ sessions: [], nextCursor: undefined }),
  );
  const replaceMcpAndActivate = vi.fn<SessionRepository["replaceMcpAndActivate"]>(() =>
    Promise.resolve(session),
  );
  const replay = vi.fn<SessionRepository["replay"]>(() => Promise.resolve([]));
  const getCurrentRunState = vi.fn<SessionRepository["getCurrentRunState"]>(() =>
    Promise.resolve({ kind: "state", state: "idle", stopReason: "end_turn" }),
  );
  const requestCancellation = vi.fn<SessionRepository["requestCancellation"]>(() =>
    Promise.resolve(),
  );
  const close = vi.fn<SessionRepository["close"]>(() => Promise.resolve());
  const deleteSession = vi.fn<SessionRepository["delete"]>(() => Promise.resolve());
  const port: SessionRepository = {
    create,
    get: vi.fn(() => Promise.resolve(session)),
    list,
    replaceMcpAndActivate,
    replay,
    getCurrentRunState,
    requestCancellation,
    close,
    delete: deleteSession,
    getClientMcpRevision: vi.fn(() => Promise.resolve([])),
  };
  return {
    port,
    create,
    list,
    replaceMcpAndActivate,
    replay,
    getCurrentRunState,
    requestCancellation,
    close,
    delete: deleteSession,
  };
}

function createService(repository: SessionRepository): SessionService {
  return new SessionService({
    repository,
    id: sequentialIds(),
    now: () => new Date("2026-08-30T00:00:01Z"),
  });
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}
