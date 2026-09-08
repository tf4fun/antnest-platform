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
  it("creates one durable Session with an empty client MCP revision", async () => {
    const repository = createRepository();
    const service = createService(repository.port);

    await expect(
      service.createSession({
        binding,
        cwd: "/workspace",
        additionalDirectories: [],
        mcpServers: [],
      }),
    ).resolves.toEqual({ sessionId: "id-1" });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "id-1",
        binding,
        cwd: "/workspace",
        mcpRevisionId: "id-2",
        mcpSources: [],
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
    ).resolves.toEqual({
      replay: [{ kind: "state", state: "idle", stopReason: "end_turn" }],
      sequence: 0,
    });
    expect(repository.replaceMcpAndActivate).toHaveBeenCalledWith(
      expect.objectContaining({ mcpSources: [] }),
    );
    expect(repository.replay).not.toHaveBeenCalled();
    expect(repository.readOutput).toHaveBeenCalledWith("session-1", undefined);

    repository.readOutput.mockResolvedValueOnce({
      sequence: 1,
      state: { kind: "state", state: "idle", stopReason: "end_turn" },
      events: [
        {
          kind: "user_message",
          messageId: "message-1",
          content: [{ type: "text", text: "past" }],
        },
      ],
    });
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
      sequence: 1,
    });
    expect(repository.readOutput).toHaveBeenLastCalledWith("session-1", 0);
  });

  it("allows Prompt admission for an empty client MCP revision", async () => {
    const repository = createRepository();
    await expect(
      createService(repository.port).requirePromptSession("session-1", binding),
    ).resolves.toBeUndefined();
    expect(repository.getClientMcpRevision).toHaveBeenCalledWith("mcp-1");
  });

  it("rejects Prompt admission for a retained client MCP revision", async () => {
    const repository = createRepository();
    repository.getClientMcpRevision.mockResolvedValueOnce([
      {
        sourceId: "client-source",
        name: "knowledge",
        url: "https://mcp.example.test/mcp",
        headers: [],
      },
    ]);
    await expect(
      createService(repository.port).requirePromptSession("session-1", binding),
    ).rejects.toMatchObject({ code: "client_mcp_not_allowed" });
  });

  it("checks ownership before reading a Session's client MCP revision", async () => {
    const repository = createRepository();
    repository.session.principalId = "another-principal";
    await expect(
      createService(repository.port).requirePromptSession("session-1", binding),
    ).rejects.toMatchObject({ code: "session_access_denied" });
    expect(repository.getClientMcpRevision).not.toHaveBeenCalled();
  });

  it("never exposes Sessions owned by another principal through list", async () => {
    const repository = createRepository();
    repository.list.mockResolvedValueOnce({
      sessions: [repository.session],
      nextCursor: undefined,
    });
    const service = createService(repository.port);

    await expect(service.listSessions({ binding, cwd: "/workspace" })).resolves.toEqual({
      sessions: [
        {
          sessionId: "session-1",
          cwd: "/workspace",
          title: "Existing conversation",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    });

    expect(repository.list).toHaveBeenCalledWith({
      principalId: "principal-1",
      agentId: "agent-1",
      cwd: "/workspace",
      cursor: undefined,
      limit: 50,
    });
  });

  it("treats a different absolute cwd as a list filter, not a workspace creation", async () => {
    const repository = createRepository();
    repository.list.mockResolvedValue({ sessions: [], nextCursor: undefined });
    await expect(
      createService(repository.port).listSessions({ binding, cwd: "/other-project" }),
    ).resolves.toEqual({ sessions: [] });
    expect(repository.list).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/other-project" }),
    );
  });

  it.each(["", "relative", "../workspace", "/workspace\u0000other"])(
    "rejects invalid directory filter %j without querying persistence",
    async (cwd) => {
      const repository = createRepository();
      await expect(
        createService(repository.port).listSessions({ binding, cwd }),
      ).rejects.toMatchObject({ code: "invalid_directory_filter" });
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it("forks an idle Session into a new durable context with a fresh MCP revision", async () => {
    const repository = createRepository();
    const service = createService(repository.port);

    await expect(
      service.forkSession({
        binding,
        sessionId: "session-1",
        cwd: "/workspace",
        additionalDirectories: [],
        mcpServers: [],
      }),
    ).resolves.toEqual({ sessionId: "id-1" });

    expect(repository.fork).toHaveBeenCalledWith({
      sourceSessionId: "session-1",
      sessionId: "id-1",
      mcpRevisionId: "id-2",
      mcpSources: [],
      createdAt: new Date("2026-08-30T00:00:01Z"),
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

  it.each(["missing", "deleted"])("deleting a %s Session is an authorized no-op", async (state) => {
    const repository = createRepository();
    repository.session.state = "deleted";
    if (state === "missing") repository.port.get = vi.fn(() => Promise.resolve(null));

    await expect(
      createService(repository.port).deleteSession({ binding, sessionId: "session-1" }),
    ).resolves.toBeUndefined();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it.each(["principalId", "agentId"] as const)(
    "idempotent deletion still checks the deleted Session's %s",
    async (field) => {
      const repository = createRepository();
      repository.session.state = "deleted";
      repository.session[field] = "foreign";

      await expect(
        createService(repository.port).deleteSession({ binding, sessionId: "session-1" }),
      ).rejects.toMatchObject({ code: "session_access_denied" });
      expect(repository.delete).not.toHaveBeenCalled();
    },
  );
});

function createRepository() {
  const session: SessionRecord = {
    id: "session-1",
    principalId: "principal-1",
    agentId: "agent-1",
    cwd: "/workspace",
    state: "closed",
    title: "Existing conversation",
    forkedFromSessionId: null,
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
  const fork = vi.fn<SessionRepository["fork"]>(() => Promise.resolve());
  const replay = vi.fn<SessionRepository["replay"]>(() => Promise.resolve([]));
  const readOutput = vi.fn<SessionRepository["readOutput"]>(() =>
    Promise.resolve({
      sequence: 0,
      events: [],
      state: { kind: "state", state: "idle", stopReason: "end_turn" },
    }),
  );
  const getCurrentRunState = vi.fn<SessionRepository["getCurrentRunState"]>(() =>
    Promise.resolve({ kind: "state", state: "idle", stopReason: "end_turn" }),
  );
  const requestCancellation = vi.fn<SessionRepository["requestCancellation"]>(() =>
    Promise.resolve(),
  );
  const close = vi.fn<SessionRepository["close"]>(() => Promise.resolve());
  const deleteSession = vi.fn<SessionRepository["delete"]>(() => Promise.resolve());
  const getClientMcpRevision = vi.fn<SessionRepository["getClientMcpRevision"]>(() =>
    Promise.resolve([]),
  );
  const port: SessionRepository = {
    create,
    get: vi.fn(() => Promise.resolve(session)),
    list,
    replaceMcpAndActivate,
    fork,
    replay,
    readOutput,
    getCurrentRunState,
    requestCancellation,
    close,
    delete: deleteSession,
    getClientMcpRevision,
  };
  return {
    port,
    getClientMcpRevision,
    session,
    create,
    list,
    replaceMcpAndActivate,
    fork,
    replay,
    readOutput,
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
