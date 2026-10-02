import { sessionConfigurationView } from "../support/fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import { DomainError } from "../../src/domain/errors.js";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { PostgresBridgeObservationRepository } from "../../src/adapters/postgres/bridge-observation-repository.js";
import { BridgeObservationService } from "../../src/application/bridge-observation.js";

describe("AgentAcpHttpServer", () => {
  let server: AgentAcpHttpServer | undefined;

  afterEach(async () => {
    await server?.close().catch((error: unknown) => {
      throw new Error("server teardown failed", { cause: error });
    });
  });

  it("real HTTP receipts and observations serialize the repository mapping against the central contract", async () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../../contracts/agent-acp/workspace-bridge.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { $schema: string; $defs: Record<string, object> };
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    const receipt = ajv.compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      $ref: "#/$defs/intentReceipt",
    });
    const observation = ajv.compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      $ref: "#/$defs/executionObservation",
    });
    let errorClass: string | null = "model_unsupported_content";
    const query = vi.fn((sql: string) =>
      Promise.resolve({
        rows: sql.includes("FROM acp_sessions")
          ? [
              {
                append_version: "2",
                configuration_revision: "1",
                last_message_sequence: "4",
                active_run_id: null,
              },
            ]
          : sql.startsWith("SET ")
            ? []
            : [
                {
                  bridge_intent_id: "intent-1",
                  session_id: "session-1",
                  run_id: "run-1",
                  state: "failed",
                  append_version: "2",
                  output_watermark: "4",
                  stop_reason: null,
                  error_class: errorClass,
                },
              ],
      }),
    );
    const transaction = async (operation: (client: never) => Promise<unknown>) =>
      operation({ query } as never);
    const repository = new PostgresBridgeObservationRepository({ query, transaction } as never);
    const access = { assert: vi.fn().mockResolvedValue(undefined) };
    const sessions = { requireAuthorized: vi.fn().mockResolvedValue(undefined) };
    server = new AgentAcpHttpServer({
      application: applicationPort(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
      bridgeObservation: new BridgeObservationService({ access, sessions, repository }),
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const base = `http://127.0.0.1:${address.port}/rpc/agent-acp/workspace/sessions/session-1`;
    const headers = {
      "X-Antnest-Organization-Id": "organization-1",
      "X-Antnest-Principal-Id": "principal-1",
      "X-Antnest-Agent-Id": "agent-1",
    };
    for (const original of ["model_unsupported_content", "Invalid-Class", null]) {
      errorClass = original;
      const expected = original === "Invalid-Class" ? "internal_error" : original;
      const lookup = await fetch(`${base}/intents/intent-1`, { headers });
      expect(lookup.status).toBe(200);
      const actualReceipt: unknown = await lookup.json();
      expect(receipt(actualReceipt), JSON.stringify(receipt.errors)).toBe(true);
      expect(actualReceipt).toMatchObject({ phase: "failed", errorClass: expected });
      const current = await fetch(`${base}/execution`, { headers });
      expect(current.status).toBe(200);
      const actualObservation: unknown = await current.json();
      expect(observation(actualObservation), JSON.stringify(observation.errors)).toBe(true);
      expect(actualObservation).toMatchObject({ recentReceipts: [actualReceipt] });
      expect(current.headers.get("cache-control")).toBe("no-store");
    }
    expect(access.assert).toHaveBeenCalledTimes(6);
    expect(sessions.requireAuthorized).toHaveBeenCalledTimes(6);
  });

  it("serves learning status with trusted identity and no caller-selected task", async () => {
    const read = vi.fn(() => Promise.resolve({ agentId: "agent-1", blocked: null }));
    server = new AgentAcpHttpServer({
      application: applicationPort(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
      learningStatus: { read },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const url = `http://127.0.0.1:${address.port}/rpc/agent-acp/workspace/agents/agent-1/learning-status`;
    const headers = {
      "X-Antnest-Organization-Id": "organization-1",
      "X-Antnest-Principal-Id": "principal-1",
      "X-Antnest-Agent-Id": "agent-1",
    };
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url.replace("agent-1", "agent-2"), { headers })).status).toBe(404);
    expect((await fetch(`${url}?taskId=x`, { headers })).status).toBe(400);
    expect((await fetch(url, { headers, method: "POST" })).status).toBe(405);
    expect(read).not.toHaveBeenCalled();
    const result = await fetch(url, { headers });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    await expect(result.json()).resolves.toEqual({ agentId: "agent-1", blocked: null });
    read.mockRejectedValueOnce(new DomainError("access_denied", "denied"));
    expect((await fetch(url, { headers })).status).toBe(404);
    read.mockRejectedValueOnce(new Error("storage unavailable"));
    const failed = await fetch(url, { headers });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({ code: "learning_status_unavailable" });
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

  it("serves bounded owner-scoped Skill learning change pages", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        items: [],
        nextCursor: "0",
        olderCursor: null,
        sealedCursor: "0",
      }),
    );
    server = new AgentAcpHttpServer({
      application: applicationPort(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
      learningChanges: { list },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const url = `http://127.0.0.1:${address.port}/rpc/agent-acp/workspace/agents/agent-1/learning-changes`;
    expect((await fetch(`${url}?after=0&limit=2`)).status).toBe(401);
    const headers = {
      "X-Antnest-Organization-Id": "organization-1",
      "X-Antnest-Principal-Id": "principal-1",
      "X-Antnest-Agent-Id": "agent-1",
    };
    expect((await fetch(url.replace("agent-1", "agent-2"), { headers })).status).toBe(404);
    expect((await fetch(`${url}?after=0&after=0`, { headers })).status).toBe(400);
    expect((await fetch(`${url}?after=0&before=x`, { headers })).status).toBe(400);
    expect((await fetch(`${url}?unknown=x`, { headers })).status).toBe(400);
    const response = await fetch(`${url}?after=0&limit=2`, { headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      nextCursor: "0",
      olderCursor: null,
      sealedCursor: "0",
    });
    expect(list).toHaveBeenCalledWith(
      { organizationId: "organization-1", agentId: "agent-1", principalId: "principal-1" },
      { after: "0" },
      2,
    );
  });

  it("does not expose out-of-scope Skill undo routes", async () => {
    server = new AgentAcpHttpServer({
      application: applicationPort(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const base = `http://127.0.0.1:${address.port}/rpc/agent-acp/workspace/agents/agent-1`;
    const body = JSON.stringify({
      request_id: "undo-1",
      expected_change_id: "change-1",
      expected_current_digest: `sha256:${"a".repeat(64)}`,
    });
    const post = `${base}/learning-changes/change-1/undo`;
    expect(
      (await fetch(post, { method: "POST", headers: { "Content-Type": "application/json" }, body }))
        .status,
    ).toBe(404);
    const readUrl = `${base}/learning-undo-operations/undo-1`;
    expect((await fetch(readUrl)).status).toBe(404);
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
