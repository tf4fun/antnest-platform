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

  it("serves scoped Bridge receipts only with complete trusted identity", async () => {
    const readIntent = vi.fn().mockResolvedValue({
      intentId: "intent-1",
      sessionId: "session-1",
      runId: "run-1",
      phase: "running",
      appendVersion: 1,
      outputWatermark: 2,
      stopReason: null,
      errorClass: null,
    });
    const readSession = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      appendVersion: 1,
      outputWatermark: 2,
      activeRunId: "run-1",
      recentReceipts: [],
      configurationRevision: null,
    });
    server = new AgentAcpHttpServer({
      application: applicationPort(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
      bridgeObservation: { readIntent, readSession },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const url = `http://127.0.0.1:${address.port}/rpc/agent-acp/workspace/sessions/session-1/intents/intent-1`;
    const denied = await fetch(url);
    expect(denied.status).toBe(401);
    expect(readIntent).not.toHaveBeenCalled();
    const allowed = await fetch(url, {
      headers: {
        "X-Antnest-Organization-Id": "organization-1",
        "X-Antnest-Principal-Id": "principal-1",
        "X-Antnest-Agent-Id": "agent-1",
      },
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ intentId: "intent-1", runId: "run-1" });
    expect(readIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "organization-1",
        principalId: "principal-1",
        agentId: "agent-1",
      }),
      "session-1",
      "intent-1",
    );
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
