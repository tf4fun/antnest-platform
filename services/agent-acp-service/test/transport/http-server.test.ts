import { sessionConfigurationView } from "../support/fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";

describe("AgentAcpHttpServer", () => {
  let server: AgentAcpHttpServer | undefined;

  afterEach(async () => {
    await server?.close().catch((error: unknown) => {
      throw new Error("server teardown failed", { cause: error });
    });
  });

  it("closes idempotently when startup never reached listen", async () => {
    server = new AgentAcpHttpServer({
      application: applicationPort(),
      ready: vi.fn(() => Promise.resolve(true)),
      maxWebSocketPayloadBytes: 64 * 1024,
    });

    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    server = undefined;
  });
});

function applicationPort() {
  return {
    assertAccess: vi.fn<AcpApplicationPort["assertAccess"]>(() => Promise.resolve()),
    getSessionConfiguration: vi.fn<AcpApplicationPort["getSessionConfiguration"]>(() =>
      Promise.resolve(sessionConfigurationView()),
    ),
    setSessionConfiguration: vi.fn<AcpApplicationPort["setSessionConfiguration"]>(() =>
      Promise.resolve(sessionConfigurationView()),
    ),
    createSession: vi.fn<AcpApplicationPort["createSession"]>(() =>
      Promise.resolve({ sessionId: "session-1" }),
    ),
    listSessions: vi.fn<AcpApplicationPort["listSessions"]>(() =>
      Promise.resolve({ sessions: [] }),
    ),
    deleteSession: vi.fn<AcpApplicationPort["deleteSession"]>(),
    forkSession: vi.fn<AcpApplicationPort["forkSession"]>(),
    resumeSession: vi.fn<AcpApplicationPort["resumeSession"]>(() =>
      Promise.resolve({ replay: [], sequence: 0 }),
    ),
    readSessionOutput: vi.fn<AcpApplicationPort["readSessionOutput"]>(() =>
      Promise.resolve({ sequence: 0, events: [], state: { kind: "state", state: "idle" } }),
    ),
    closeSession: vi.fn<AcpApplicationPort["closeSession"]>(),
    cancelRun: vi.fn<AcpApplicationPort["cancelRun"]>(),
    acceptPrompt: vi.fn<AcpApplicationPort["acceptPrompt"]>(),
  } satisfies AcpApplicationPort;
}
