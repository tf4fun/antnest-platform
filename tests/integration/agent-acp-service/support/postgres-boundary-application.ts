import { SessionConfigurationService } from "../../../../services/agent-acp-service/src/application/session-configuration.js";
import { PostgresToolPermissions } from "../../../../services/agent-acp-service/src/adapters/postgres/tool-permissions.js";
import { ToolPermissions } from "../../../../services/agent-acp-service/src/application/tool-permissions.js";
import { PermissionConnections } from "../../../../services/agent-acp-service/src/application/permission-connections.js";
import { PostgresSessionConfiguration } from "../../../../services/agent-acp-service/src/adapters/postgres/session-configuration.js";
import { randomBytes } from "node:crypto";
import { newResourceId } from "../../../../services/agent-acp-service/src/domain/resource-id.js";

import type { Pool } from "pg";
import { vi } from "vitest";

import { PostgresContextRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresRunEventRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { AcpApplication } from "../../../../services/agent-acp-service/src/application/application.js";
import { AccessService } from "../../../../services/agent-acp-service/src/application/access-service.js";
import { ContextBuilder } from "../../../../services/agent-acp-service/src/application/context-builder.js";
import { PromptCoordinator } from "../../../../services/agent-acp-service/src/application/prompt-coordinator.js";
import { RunExecutor } from "../../../../services/agent-acp-service/src/application/run-executor.js";
import { RunSupervisor } from "../../../../services/agent-acp-service/src/application/run-supervisor.js";
import { AgentExecutionState } from "../../../../services/agent-acp-service/src/application/agent-execution-state.js";
import { SessionService } from "../../../../services/agent-acp-service/src/application/session-service.js";
import { ExecutionDirectory } from "../../../../services/agent-acp-service/src/application/execution-directory.js";
import { ProviderClients } from "../../../../services/agent-acp-service/src/application/provider-clients.js";
import { PostgresExecutionConfiguration } from "../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import type {
  ExecutionConfiguration,
  ExecutionIdentity,
  ExecutionAccessSnapshot,
} from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { SessionOutputStreams } from "../../../../services/agent-acp-service/src/transport/acp/session-output.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import type { AuthenticatedModelTransport } from "../../../../services/agent-acp-service/src/ports/model.js";
import type { ToolCatalogPort } from "../../../../services/agent-acp-service/src/ports/tools.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import { AcpWireClient, type ProtocolVersion } from "./acp-wire-client.js";

// Application recreation preserves the deployment's encryption key.
const encryptionKey = randomBytes(32);

export async function startBoundaryApplication(
  pool: Pool,
  information = runtimeInformation(),
  options: { runTimeoutMs?: number } = {},
) {
  const kernel = new PostgresKernel(pool);
  const sessions = new PostgresSessionRepository(
    kernel,
    new SecretBox(encryptionKey),
  );
  const executions = new PostgresExecutionRepository(kernel);
  const persistRun = executions.finish.bind(executions);
  const finish = vi.spyOn(executions, "finish");
  const runs = new PostgresRunRepository(kernel);
  const createIntent = vi.spyOn(runs, "createRunIntent");
  const acceptRun = vi.spyOn(runs, "acceptRun");
  const identities = new Map<string, ExecutionIdentity>([
    ["owner", identity("principal-1", "agent-1")],
    ["other-user", identity("principal-2", "agent-1")],
    ["other-agent", identity("principal-1", "agent-2")],
  ]);
  const model = {
    complete: vi.fn<AuthenticatedModelTransport["complete"]>(() =>
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
    calls: [
      {
        id: "owner-tool-call",
        name: "read",
        arguments: { path: "private.txt" },
      },
    ],
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
        runtimeCallStopped: true,
      }),
    ),
  };
  const recoveryRequired = vi.fn();
  const events = new PostgresRunEventRepository(kernel);
  const providers = new ProviderClients(model);
  const acquireClient = vi.spyOn(providers, "acquire");
  const permissions = new PermissionConnections();
  const outputs = new SessionOutputStreams();
  const configurations = new PostgresExecutionConfiguration(kernel);
  const revoke = (snapshot: ExecutionAccessSnapshot) => {
    supervisor.revokeAccess(snapshot);
    permissions.revokeAccess(snapshot);
    outputs.revokeAccess(snapshot);
  };
  const directory = new ExecutionDirectory({
    repository: configurations,
    clients: providers,
    onApplied: (snapshot) => {
      revoke(snapshot);
      return Promise.resolve();
    },
    onUnavailable: (organizationId) =>
      revoke({ organization_id: organizationId, agents: [] }),
    onPublished: (organizationId) =>
      outputs.invalidateOrganization(organizationId),
  });
  const stored = await configurations.load("organization-1");
  const configuration: ExecutionConfiguration =
    stored === null
      ? boundaryConfiguration()
      : {
          ...stored,
          providers: stored.providers.map((provider) => ({
            ...provider,
            credential_revision: provider.credential_revision ?? "credential-1",
            credential: {
              method: "api_key" as const,
              secret: "synthetic-provider-secret",
            },
          })),
        };
  const access = new AccessService({ directory });
  const permissionRepository = new PostgresToolPermissions(kernel);
  const supervisor = new RunSupervisor(
    new RunExecutor({
      permissions: new ToolPermissions(
        permissionRepository,
        permissions,
        access,
      ),
      executions,
      contextBuilder: new ContextBuilder({
        runtimeInformation: { read: () => Promise.resolve(information) },
        tools,
        repository: new PostgresContextRepository(kernel),
        id: newResourceId,
        now: () => new Date(),
      }),
      providers,
      tools,
      events,
      ownershipSignal: new AbortController().signal,
      recoveryRequired,
      id: newResourceId,
      now: () => new Date(),
    }),
  );
  const application = new AcpApplication({
    configuration: new SessionConfigurationService({
      sessions: new SessionService({
        repository: sessions,
        id: newResourceId,
        now: () => new Date(),
      }),
      repository: new PostgresSessionConfiguration(kernel),
      directory,
      now: () => new Date(),
    }),
    access,
    sessions: new SessionService({
      repository: sessions,
      id: newResourceId,
      now: () => new Date(),
    }),
    prompts: new PromptCoordinator({
      repository: runs,
      directory,
      protection: executions,
      runTimeoutMs: options.runTimeoutMs ?? 60_000,
      recoveryRequired,
      id: newResourceId,
      now: () => new Date(),
    }),
    runs: supervisor,
  });
  const cancel = vi.spyOn(application, "cancelRun");
  const readOutput = vi.spyOn(application, "readSessionOutput");
  const server = new AgentAcpHttpServer({
    executionConfiguration: directory,
    executionState: new AgentExecutionState({
      directory,
      supervisor,
      protection: executions,
    }),
    outputs,
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
    await directory.apply(configuration);
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing TCP address");
    const url = `ws://127.0.0.1:${address.port}`;
    return {
      url,
      readOutput,
      httpUrl: `http://127.0.0.1:${address.port}/v1/acp`,
      sessions,
      finish,
      persistRun,
      permissionRepository,
      events,
      createIntent,
      acceptRun,
      acquireClient,
      configuration,
      directory,
      identities,
      identity(alias = "owner") {
        const value = identities.get(alias);
        if (value === undefined)
          throw new Error(`Missing fixture identity: ${alias}`);
        return { ...value };
      },
      async publishConfiguration() {
        configuration.revision += 1;
        return directory.apply(structuredClone(configuration));
      },
      model,
      tools,
      cancel,
      recoveryRequired,
      close,
      async connect(version: ProtocolVersion, alias = "owner") {
        const value = identities.get(alias);
        if (value === undefined)
          throw new Error(`Missing fixture identity: ${alias}`);
        const client = await AcpWireClient.connect(
          `${url}/v${version}/acp`,
          value,
        );
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

function identity(principalId: string, agentId: string): ExecutionIdentity {
  return { organizationId: "organization-1", principalId, agentId };
}

function boundaryConfiguration(): ExecutionConfiguration {
  const configuration = executionConfiguration();
  const provider = configuration.providers[0]!;
  provider.connection_id = "connection-1";
  provider.base_url = "https://api.example.test/v1";
  provider.credential.secret = "synthetic-provider-secret";
  const model = configuration.models[0]!;
  model.model_profile_id = "profile-1";
  model.connection_id = provider.connection_id;
  model.model = "example-model";
  model.display_name = "Example model";
  const agent = configuration.agents[0]!;
  agent.default_model_profile_id = model.model_profile_id;
  agent.default_authorization.mode = "auto";
  agent.principal_ids = ["principal-1", "principal-2"];
  agent.agent_spec_revision = "config-1";
  agent.system_prompt = "system";
  agent.max_model_requests = 4;
  configuration.agents.push({
    ...structuredClone(agent),
    agent_id: "agent-2",
    principal_ids: ["principal-1"],
  });
  return configuration;
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
    state[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`))
      .rows as unknown[];
  }
  return state;
}
