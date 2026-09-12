import { SessionConfigurationService } from "../../src/application/session-configuration.js";
import { PostgresToolPermissions } from "../../src/adapters/postgres/tool-permissions.js";
import { ToolPermissions } from "../../src/application/tool-permissions.js";
import { PermissionConnections } from "../../src/application/permission-connections.js";
import { PostgresSessionConfiguration } from "../../src/adapters/postgres/session-configuration.js";
import { configurationCatalog } from "./fixtures.js";
import { randomBytes, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { vi } from "vitest";

import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "../../src/adapters/postgres/execution-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { PostgresRunEventRepository } from "../../src/adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "../../src/adapters/postgres/run-repository.js";
import { SecretBox } from "../../src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../src/adapters/postgres/session-repository.js";
import { AcpApplication } from "../../src/application/application.js";
import { AccessService } from "../../src/application/access-service.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import { RunExecutor } from "../../src/application/run-executor.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import { SessionService } from "../../src/application/session-service.js";
import {
  AgentControllerError,
  type AgentControllerPort,
  type ResolveAgentAccessResult,
} from "../../src/ports/agent-controller.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";
import { AcpWireClient, type ProtocolVersion } from "./acp-wire-client.js";
import { snapshot } from "./fixtures.js";

export async function startBoundaryApplication(pool: Pool, information = runtimeInformation()) {
  const kernel = new PostgresKernel(pool);
  const sessions = new PostgresSessionRepository(kernel, new SecretBox(randomBytes(32)));
  const executions = new PostgresExecutionRepository(kernel);
  const runs = new PostgresRunRepository(kernel);
  const identities = new Map<string, ResolveAgentAccessResult>([
    ["owner", identity("principal-1", "agent-1")],
    ["other-user", identity("principal-2", "agent-1")],
    ["other-agent", identity("principal-1", "agent-2")],
  ]);
  const authorizations = new Map(
    [...identities.values()].map((value) => [
      `${value.principalId}:${value.agentId}`,
      { active: true, accessRevision: value.accessRevision },
    ]),
  );
  const resolveAgentAccess = vi.fn<AgentControllerPort["resolveAgentAccess"]>((input) => {
    const current = identities.get(input.agentAccessSubject);
    const permission =
      current === undefined
        ? undefined
        : authorizations.get(`${current.principalId}:${current.agentId}`);
    return current === undefined || permission?.active !== true
      ? Promise.reject(accessDenied())
      : Promise.resolve({ ...structuredClone(current), accessRevision: permission.accessRevision });
  });
  const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>((input) => {
    const current = authorizations.get(`${input.principalId}:${input.agentId}`);
    if (current?.active !== true || current.accessRevision !== input.expectedAccessRevision) {
      return Promise.reject(accessDenied());
    }
    return Promise.resolve({
      ...snapshot(),
      admissionId: randomUUID(),
      admissionDeadline: new Date(Date.now() + 60_000),
    });
  });
  const controller = {
    getSessionConfiguration: vi.fn<AgentControllerPort["getSessionConfiguration"]>(() =>
      Promise.resolve(configurationCatalog()),
    ),
    resolveAgentAccess,
    acquireRun,
    resolveCredential: vi.fn<AgentControllerPort["resolveCredential"]>(() =>
      Promise.resolve({
        secretType: "bearer" as const,
        secret: "synthetic-provider-secret",
        credentialVersion: "credential-version-1",
      }),
    ),
    finishRun: vi.fn<AgentControllerPort["finishRun"]>(() => Promise.resolve()),
  } satisfies AgentControllerPort;
  const model = {
    complete: vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "owner-only-response" }],
        stopReason: "end_turn",
        usage: { inputTokens: 8, outputTokens: 4 },
      }),
    ),
  };
  model.complete.mockResolvedValueOnce({
    kind: "tool_calls",
    content: [],
    usage: { inputTokens: 4, outputTokens: 2 },
    calls: [{ id: "owner-tool-call", name: "read", arguments: { path: "private.txt" } }],
  });
  const tools = {
    list: vi.fn<ToolCatalogPort["list"]>(() =>
      Promise.resolve([
        {
          source: "runtime",
          sourceId: "runtime",
          name: "read",
          modelName: "read",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
      ]),
    ),
    call: vi.fn<ToolCatalogPort["call"]>(() =>
      Promise.resolve({
        content: [{ type: "text", text: "owner-only-tool-output" }],
        isError: false,
        toolEffectState: "settled",
      }),
    ),
  };
  const recoveryRequired = vi.fn();
  const events = new PostgresRunEventRepository(kernel);
  const access = new AccessService({ agentController: controller, id: randomUUID });
  const permissions = new PermissionConnections();
  const permissionRepository = new PostgresToolPermissions(kernel);
  const supervisor = new RunSupervisor(
    new RunExecutor({
      permissions: new ToolPermissions(permissionRepository, permissions, access),
      executions,
      contextBuilder: new ContextBuilder({
        runtimeInformation: { read: () => Promise.resolve(information) },
        tools,
        repository: new PostgresContextRepository(kernel),
        id: randomUUID,
        now: () => new Date(),
      }),
      agentController: controller,
      model,
      tools,
      events,
      ownershipSignal: new AbortController().signal,
      recoveryRequired,
      id: randomUUID,
      now: () => new Date(),
    }),
  );
  const application = new AcpApplication({
    configuration: new SessionConfigurationService({
      sessions: new SessionService({ repository: sessions, id: randomUUID, now: () => new Date() }),
      repository: new PostgresSessionConfiguration(kernel),
      controller,
      id: randomUUID,
      now: () => new Date(),
    }),
    access,
    sessions: new SessionService({ repository: sessions, id: randomUUID, now: () => new Date() }),
    prompts: new PromptCoordinator({
      repository: runs,
      agentController: controller,
      executions,
      recoveryRequired,
      id: randomUUID,
      now: () => new Date(),
    }),
    runs: supervisor,
  });
  const cancel = vi.spyOn(application, "cancelRun");
  const server = new AgentAcpHttpServer({
    agentController: controller,
    application,
    permissions,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 64 * 1024,
  });
  const clients: AcpWireClient[] = [];
  async function close() {
    for (const client of clients) await client.close();
    await server.close();
    await supervisor.shutdown();
  }
  try {
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing TCP address");
    const url = `ws://127.0.0.1:${address.port}`;
    return {
      httpUrl: `http://127.0.0.1:${address.port}/v1/acp`,
      sessions,
      permissionRepository,
      events,
      controller,
      identities,
      authorizations,
      model,
      tools,
      cancel,
      recoveryRequired,
      close,
      async connect(version: ProtocolVersion, subject = "owner") {
        const client = await AcpWireClient.connect(`${url}/v${version}/acp`, subject);
        clients.push(client);
        await client.initialize(version);
        return client;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function identity(principalId: string, agentId: string): ResolveAgentAccessResult {
  return {
    principalId,
    agentId,
    accessRevision: "access-1",
    promptCapabilities: { image: false, embeddedContext: true },
  };
}

function accessDenied(): AgentControllerError {
  return new AgentControllerError("access_denied", "Agent access denied", false);
}

export async function boundaryState(pool: Pool) {
  const state: Record<string, unknown[]> = {};
  for (const table of [
    "acp_sessions",
    "client_mcp_revisions",
    "session_messages",
    "runs",
    "tool_attempts",
  ]) {
    state[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows as unknown[];
  }
  return state;
}
