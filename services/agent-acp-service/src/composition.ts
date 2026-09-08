import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  AgentControllerClient,
  requireAgentControllerReady,
} from "./adapters/controller/client.js";
import { OfficialMcpDialer } from "./adapters/mcp/official-client.js";
import { McpToolCatalog } from "./adapters/mcp/tool-catalog.js";
import { OpenAICompatibleModel } from "./adapters/model/openai-compatible.js";
import { PostgresContextRepository } from "./adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "./adapters/postgres/execution-repository.js";
import { PostgresKernel } from "./adapters/postgres/kernel.js";
import { migrate } from "./adapters/postgres/migrate.js";
import { PostgresRunEventRepository } from "./adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "./adapters/postgres/run-repository.js";
import { SecretBox } from "./adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "./adapters/postgres/session-repository.js";
import { PostgresWorkerLock, WorkerOwnershipLostError } from "./adapters/postgres/worker-lock.js";
import { AcpApplication } from "./application/application.js";
import { AccessService } from "./application/access-service.js";
import { ContextBuilder } from "./application/context-builder.js";
import { PromptCoordinator } from "./application/prompt-coordinator.js";
import { RunExecutor } from "./application/run-executor.js";
import { RunRecovery } from "./application/run-recovery.js";
import { RunSupervisor } from "./application/run-supervisor.js";
import { SessionService } from "./application/session-service.js";
import type { AgentAcpConfig } from "./config.js";
import type { TelemetryPort } from "./ports/telemetry.js";
import {
  InstrumentedAcpApplication,
  InstrumentedAgentController,
  InstrumentedModel,
  InstrumentedToolCatalog,
  InstrumentedRuntimeInformation,
} from "./telemetry/instrumented-ports.js";
import { AgentAcpHttpServer } from "./transport/http-server.js";

export type RunningAgentAcpService = {
  failure: Promise<Error>;
  shutdown(): Promise<void>;
};

export async function startAgentAcpService(
  config: AgentAcpConfig,
  telemetry: TelemetryPort,
  reportOwnershipLoss: (error: WorkerOwnershipLostError) => void,
): Promise<RunningAgentAcpService> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on("error", (error) => telemetry.log("error", "postgres_pool_error", {}, error));
  let workerLock: PostgresWorkerLock | undefined;
  const failure = Promise.withResolvers<Error>();
  let serving = false;
  let requestedFailure: Error | undefined;
  let components: ReturnType<typeof buildComponents> | undefined;
  const ownership = new AbortController();
  const recoveryRequired = (error: Error): void => {
    requestedFailure ??= error;
    serving = false;
    ownership.abort(requestedFailure);
    components?.supervisor.stop(requestedFailure);
    failure.resolve(requestedFailure);
  };

  try {
    await telemetry.span("postgres.migrate", { "db.system.name": "postgresql" }, () =>
      migrate(pool),
    );
    await requireDependenciesReady(pool, config, telemetry);
    const acquiredWorkerLock = await telemetry.span(
      "postgres.worker_lock.acquire",
      { "db.system.name": "postgresql" },
      () => PostgresWorkerLock.acquire(pool),
    );
    workerLock = acquiredWorkerLock;
    const built = buildComponents(pool, config, telemetry, recoveryRequired, ownership.signal);
    components = built;
    void acquiredWorkerLock.waitForLoss().then((error) => {
      telemetry.log("error", "worker_lock_lost", {}, error);
      telemetry.count("antnest.acp.worker_lock_losses", {});
      const ownershipLoss = new WorkerOwnershipLostError({ cause: error });
      reportOwnershipLoss(ownershipLoss);
      recoveryRequired(ownershipLoss);
    });

    await waitForStartupRecovery(built.recovery.recover(ownership.signal), failure.promise);
    if (requestedFailure !== undefined) {
      throw requestedFailure;
    }
    if (!acquiredWorkerLock.isHeld()) {
      const ownershipLoss = new WorkerOwnershipLostError();
      reportOwnershipLoss(ownershipLoss);
      throw ownershipLoss;
    }

    const server = new AgentAcpHttpServer({
      agentController: built.agentController,
      application: built.application,
      maxWebSocketPayloadBytes: config.maxWebSocketPayloadBytes,
      telemetry,
      ready: async () =>
        serving &&
        acquiredWorkerLock.isHeld() &&
        (await dependenciesReady(pool, config, telemetry)),
    });
    await server.listen(config.listen.host, config.listen.port);
    serving = true;
    telemetry.log("info", "service_started", {
      listen_host: config.listen.host,
      listen_port: config.listen.port,
    });

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        serving = false;
        const results = await Promise.allSettled([server.close(), built.supervisor.shutdown()]);
        results.push(await settle(acquiredWorkerLock.release()), await settle(pool.end()));
        telemetry.log("info", "service_stopped");
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason as unknown);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Agent ACP Service shutdown was incomplete");
        }
      })();
      return shutdownPromise;
    };
    return { failure: failure.promise, shutdown };
  } catch (error) {
    const startupError = asError(error);
    if (startupError instanceof WorkerOwnershipLostError) {
      throw startupError;
    }
    components?.supervisor.stop(startupError);
    await components?.supervisor.shutdown().catch(() => undefined);
    await workerLock?.release().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw startupError;
  }
}

export async function waitForStartupRecovery(
  recovery: Promise<void>,
  failure: Promise<Error>,
): Promise<void> {
  await Promise.race([recovery, failure.then((error) => Promise.reject(error))]);
}

function buildComponents(
  pool: Pool,
  config: AgentAcpConfig,
  telemetry: TelemetryPort,
  recoveryRequired: (error: Error) => void,
  ownershipSignal: AbortSignal,
) {
  const kernel = new PostgresKernel(pool, telemetry);
  const sessions = new PostgresSessionRepository(kernel, new SecretBox(config.clientMcpKey));
  const runs = new PostgresRunRepository(kernel);
  const contexts = new PostgresContextRepository(kernel);
  const executions = new PostgresExecutionRepository(kernel);
  const events = new PostgresRunEventRepository(kernel);

  const rawAgentController = new AgentControllerClient({
    baseUrl: new URL("rpc/agent-controller/", config.agentControllerUrl),
    timeoutMs: config.controllerTimeoutMs,
  });
  const agentController = new InstrumentedAgentController(rawAgentController, telemetry);
  const model = new InstrumentedModel(new OpenAICompatibleModel(), telemetry);
  const rawTools = new McpToolCatalog({
    runtimeDialer: new OfficialMcpDialer({ trust: "runtime" }),
    revisions: sessions,
    reportConnectionCloseFailure: (source, sourceId, error) => {
      telemetry.count("antnest.acp.mcp.close_failures", { source });
      telemetry.log(
        "warn",
        "mcp_connection_close_failed",
        { "mcp.source": source, "mcp.source_id": sourceId },
        error,
      );
    },
  });
  const tools = new InstrumentedToolCatalog(rawTools, telemetry);
  const information = new InstrumentedRuntimeInformation(rawTools, telemetry);
  const executor = new RunExecutor({
    executions,
    contextBuilder: new ContextBuilder({
      repository: contexts,
      runtimeInformation: information,
      tools,
      id: randomUUID,
      now,
    }),
    agentController,
    model,
    tools,
    events,
    ownershipSignal,
    recoveryRequired,
    id: randomUUID,
    now,
  });
  const supervisor = new RunSupervisor(executor);
  const application = new InstrumentedAcpApplication(
    new AcpApplication({
      access: new AccessService({ agentController, id: randomUUID }),
      sessions: new SessionService({ repository: sessions, id: randomUUID, now }),
      prompts: new PromptCoordinator({
        repository: runs,
        agentController,
        executions,
        recoveryRequired,
        id: randomUUID,
        now,
      }),
      runs: supervisor,
    }),
    telemetry,
  );
  const recovery = new RunRecovery({
    executions,
    runs,
    agentController,
    runExecutor: supervisor,
    events,
    telemetry,
    id: randomUUID,
    now,
  });
  return { agentController, application, recovery, supervisor };
}

async function requireDependenciesReady(
  pool: Pool,
  config: AgentAcpConfig,
  telemetry: TelemetryPort,
): Promise<void> {
  if (!(await dependenciesReady(pool, config, telemetry))) {
    throw new Error("Agent ACP Service dependencies are not ready");
  }
}

async function dependenciesReady(
  pool: Pool,
  config: AgentAcpConfig,
  telemetry: TelemetryPort,
): Promise<boolean> {
  try {
    await Promise.all([
      telemetry.span("postgres.ready", { "db.system.name": "postgresql" }, () =>
        pool.query("SELECT 1"),
      ),
      telemetry.span("agent_controller.status", {}, () => controllerReady(config)),
    ]);
    return true;
  } catch (error) {
    telemetry.log("warn", "dependency_not_ready", {}, error);
    return false;
  }
}

async function controllerReady(config: AgentAcpConfig): Promise<void> {
  await requireAgentControllerReady({
    serviceUrl: config.agentControllerUrl,
    timeoutMs: config.controllerTimeoutMs,
  });
}

function now(): Date {
  return new Date();
}

async function settle(operation: Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await operation;
    return { status: "fulfilled", value: undefined };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Agent ACP Service startup failed");
}
