import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RuntimeConnections } from "../../../../services/agent-acp-service/src/adapters/runtime-connections.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresAgentLeases } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { PostgresOwnerRecovery } from "../../../../services/agent-acp-service/src/adapters/postgres/owner-recovery.js";
import { PostgresWorkerLock } from "../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import type { AgentOwnershipFence } from "../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type { ServiceAuthentication } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import {
  OwnerInspectionAttemptError,
  RuntimeControllerIncarnations,
} from "../../../../services/agent-acp-service/src/adapters/runtime-controller-incarnations.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { createOwnedAgentRepositories } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { createOwnedLearningRepositories } from "../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import { learningPolicySchema } from "../../../../services/agent-acp-service/src/domain/learning-policy.js";
import { buildLearningCandidatePackage } from "../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import { learningApplyRequestId } from "../../../../services/agent-acp-service/src/domain/learning-apply-request-id.js";
import { publicExecutionConfiguration } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import type { OwnerInspection } from "../../../../services/agent-acp-service/src/application/owner-inspection.js";
import { OwnerProbeServer } from "../../../../services/agent-acp-service/src/transport/owner-probe-server.js";
import { CallerContextVerifier } from "../../../../services/agent-acp-service/src/adapters/caller-context.js";
import { RequestAuthentication } from "../../../../services/agent-acp-service/src/transport/request-authentication.js";
import {
  parseOwnerProbeRequest,
  type OwnerRegistration,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import { loadConfig } from "../../../../services/agent-acp-service/src/config.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  executionConfiguration,
  executionIdentity,
  closedExecutionAgent,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import {
  testJwks,
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { AcpWireClient, type WireFrame } from "../support/acp-wire-client.js";
import {
  serviceOrigin,
  startPeer,
  readBody,
  within,
} from "../support/production-peers.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const reply = "The sealed warm configuration admitted this Run.";
type Boot = "published" | "restored";
type StoredRun = {
  id: string;
  state: string;
  terminal_class: string | null;
  executor_state: string | null;
  tool_effect_state: string | null;
  unknown_effect_source: string | null;
  stop_reason: string | null;
  error_class: string | null;
  execution_snapshot: unknown;
  organization_id: string;
  agent_id: string;
  principal_id: string;
  execution_owner_registration_id: string | null;
  execution_owner_member_id: string | null;
  execution_owner_incarnation_id: string | null;
  execution_owner_epoch: string | null;
};

function isOnlyInspectionCleanupFailure(error: unknown): boolean {
  const seen = new Set<unknown>(),
    leaves: unknown[] = [];
  const visit = (value: unknown): void => {
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof AggregateError && value.errors.length > 0) {
      for (const item of value.errors as unknown[]) visit(item);
    } else leaves.push(value);
    if (value instanceof Error && value.cause !== undefined) visit(value.cause);
  };
  visit(error);
  const only = leaves[0];
  return (
    leaves.length === 1 &&
    only instanceof OwnerInspectionAttemptError &&
    only.cleanupFailed &&
    !only.retryable &&
    only.code === "acp_registry_unavailable"
  );
}

it.each(["sibling", "cause"] as const)(
  "rejects an additional shutdown cleanup failure in the expected error's %s",
  (position) => {
    const expected = new OwnerInspectionAttemptError(false, true);
    const unexpected = new Error("Independent resource cleanup failed");
    const aggregate =
      position === "sibling"
        ? new AggregateError([expected, unexpected], "Shutdown failed")
        : new AggregateError([expected], "Shutdown failed", {
            cause: unexpected,
          });
    expect(isOnlyInspectionCleanupFailure(aggregate)).toBe(false);
    expect(
      isOnlyInspectionCleanupFailure(
        new AggregateError([expected, expected], "Repeated wrapper"),
      ),
    ).toBe(true);
    expect(
      isOnlyInspectionCleanupFailure(new AggregateError([], "Empty failure")),
    ).toBe(false);
    expect(
      isOnlyInspectionCleanupFailure(
        new OwnerInspectionAttemptError(true, true),
      ),
    ).toBe(false);
  },
);

describe.skipIf(databaseUrl === undefined)(
  "production ACP warm admission",
  () => {
    it.each([
      {
        version: 2,
        ownership: "owned",
        proofSource: "remote",
        learningState: "install",
      },
      ...(
        [
          { version: 1, ownership: "legacy", proofSource: "none" },
          { version: 2, ownership: "legacy", proofSource: "none" },
          { version: 1, ownership: "owned", proofSource: "none" },
          { version: 2, ownership: "owned", proofSource: "none" },
          { version: 1, ownership: "owned", proofSource: "remote" },
          { version: 2, ownership: "owned", proofSource: "remote" },
          { version: 1, ownership: "owned", proofSource: "stored" },
          { version: 2, ownership: "owned", proofSource: "stored" },
          { version: 2, ownership: "owned", proofSource: "held" },
          { version: 2, ownership: "owned", proofSource: "held-error" },
          { version: 2, ownership: "owned", proofSource: "running" },
          { version: 2, ownership: "owned", proofSource: "unknown" },
          { version: 2, ownership: "owned", proofSource: "http-error" },
        ] as const
      ).map((entry) => ({ ...entry, learningState: "none" as const })),
      {
        version: 1,
        ownership: "owned",
        proofSource: "remote",
        learningState: "running",
      },
      {
        version: 2,
        ownership: "owned",
        proofSource: "remote",
        learningState: "running",
      },
      {
        version: 2,
        ownership: "owned",
        proofSource: "remote",
        learningState: "paused",
      },
      {
        version: 2,
        ownership: "owned",
        proofSource: "stored",
        learningState: "paused",
      },
      {
        version: 2,
        ownership: "owned",
        proofSource: "running",
        learningState: "running",
      },
    ] as const)(
      "$ownership v$version admits before republication and uses a newer revision (predecessor proof=$proofSource, Learning=$learningState)",
      async ({ version, ownership, proofSource, learningState }) => {
        const predecessor = proofSource !== "none";
        const heldInspection =
          proofSource === "held" || proofSource === "held-error";
        const unavailablePredecessor = [
          "held",
          "held-error",
          "running",
          "unknown",
          "http-error",
        ].includes(proofSource);
        expect(new URL(databaseUrl!).pathname).toMatch(/_test$/u);
        const pool = new Pool({
          connectionString: databaseUrl,
          max: 2,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
          query_timeout: 5000,
        });
        const key = randomBytes(32).toString("base64");
        const witnessLeases = new PostgresAgentLeases(new PostgresKernel(pool));
        const witnessFences = new Set<AgentOwnershipFence>();
        const auxiliaryAuthentication: ServiceAuthentication[] = [];
        let witness: { runId: string; fence: AgentOwnershipFence } | undefined;
        let storedProof: unknown;
        let witnessAudit: unknown;
        let inspectionUnavailable = false;
        let inspectionRequests = 0;
        const providerSecret = randomBytes(32).toString("base64url");
        const runtimeToken = randomBytes(32).toString("base64url");
        const runtimeExecutionId =
          "warm-execution-" + randomBytes(8).toString("hex");
        const connectionId = "rci_" + randomBytes(16).toString("hex");
        const otherRuntimeToken = randomBytes(32).toString("base64url");
        const otherRuntimeExecutionId =
          "independent-execution-" + randomBytes(8).toString("hex");
        const otherConnectionId = "rci_" + randomBytes(16).toString("hex");
        const cancellationStarted = Promise.withResolvers<void>();
        const cancellationRelease = Promise.withResolvers<void>();
        const cancellationJoined = Promise.withResolvers<void>();
        let nativeCancellationJoined = false;
        let expectedShutdownFailure:
          { service: RunningAgentAcpService; error: unknown } | undefined;
        const restoreFetch: Array<() => void> = [];
        const services: RunningAgentAcpService[] = [];
        const clients: AcpWireClient[] = [];
        const pending: Promise<unknown>[] = [];
        const peers: Array<Awaited<ReturnType<typeof startPeer>>> = [];
        const failures: unknown[] = [];
        const ownershipLost = vi.fn();
        const requestAbort = new AbortController();
        const prepare = vi.spyOn(RuntimeConnections.prototype, "prepare");
        const close = vi.spyOn(RuntimeConnections.prototype, "close");
        const probeListen = vi.spyOn(OwnerProbeServer.prototype, "listen");
        const releaseLease = vi.spyOn(PostgresAgentLeases.prototype, "release");
        const releaseWorker = vi.spyOn(PostgresWorkerLock.prototype, "release");
        const endPool = vi.spyOn(Pool.prototype, "end");
        const registrations: OwnerRegistration[] = [];
        const inspections: OwnerInspection[] = [];
        const stopReceipt = {
          receipt_id: randomUUID(),
          reason: "container_stopped" as const,
          observed_at: new Date().toISOString(),
        };
        let originalStopped = false;
        let predecessorSessionId: string | undefined;
        let predecessorRun: StoredRun | undefined;
        let predecessorLearning:
          | {
              taskId: string;
              claimId: string;
              generation: number;
              epoch: string;
              facts: Awaited<ReturnType<typeof learningFacts>>;
            }
          | undefined;
        let recoveredLearning:
          Awaited<ReturnType<typeof learningFacts>> | undefined;
        let installRequestId: string | undefined;
        let originalInstall: unknown;
        let registrationOrigin: string | undefined;
        const modelRequests: Array<{
          boot: Boot;
          authorized: boolean;
          model: unknown;
          messages: unknown;
        }> = [];
        const runtimeRequests: Array<{
          boot: Boot;
          authorized: boolean;
          executionId: string | string[] | undefined;
        }> = [];
        const resourceReads: Boot[] = [];
        let boot: Boot = "published";
        let closing = false;
        let publicationCount = 0;

        async function learningFacts(taskId: string) {
          const task = (
            await pool.query<Record<string, unknown>>(
              "SELECT * FROM learning_tasks WHERE id=$1",
              [taskId],
            )
          ).rows[0]!;
          const calls = (
            await pool.query<Record<string, unknown>>(
              "SELECT * FROM learning_model_calls WHERE task_id=$1 ORDER BY call_index",
              [taskId],
            )
          ).rows;
          const history = (
            await pool.query<Record<string, unknown>>(
              "SELECT * FROM learning_review_attempts WHERE task_id=$1 ORDER BY generation",
              [taskId],
            )
          ).rows;
          return { task, calls, history };
        }

        async function assertPredecessorUnchanged() {
          if (predecessorLearning !== undefined)
            expect(await learningFacts(predecessorLearning.taskId)).toEqual(
              predecessorLearning.facts,
            );
          else
            expect(await stored(predecessorSessionId!)).toEqual([
              predecessorRun!,
            ]);
        }

        function track<T>(promise: Promise<T>): Promise<T> {
          pending.push(promise);
          void promise.catch(() => undefined);
          return promise;
        }

        function senderDirectories(): string[] {
          return [
            ...new Set(
              prepare.mock.contexts.flatMap((context) =>
                context instanceof RuntimeConnections
                  ? [context.directory]
                  : [],
              ),
            ),
          ];
        }

        function assertSender(directory: string): void {
          const sender = join(directory, connectionId);
          const tokenFile = join(sender, "antnest-runtime");
          expect(lstatSync(directory).isDirectory()).toBe(true);
          expect(lstatSync(directory).mode & 0o777).toBe(0o700);
          expect(lstatSync(sender).isDirectory()).toBe(true);
          expect(lstatSync(sender).mode & 0o777).toBe(0o700);
          expect(lstatSync(tokenFile).isFile()).toBe(true);
          expect(lstatSync(tokenFile).mode & 0o777).toBe(0o600);
          expect(readFileSync(tokenFile, "utf8") === runtimeToken).toBe(true);
        }

        async function start(): Promise<RunningAgentAcpService> {
          const loaded = loadConfig({
            ...testSecurityEnvironment(),
            ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
              process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
            ANTNEST_ACP_DATABASE_URL: databaseUrl!,
            ANTNEST_ACP_CLIENT_MCP_KEY: key,
            ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "true",
          });
          // The running service owns this authentication instance. Do not also
          // register it for a second fixture-level close after shutdown.
          const authentication = new RequestAuthentication(
            loaded.authentication.workload,
            new CallerContextVerifier("http://identity.invalid/", () =>
              Promise.resolve(Response.json(testJwks())),
            ),
          );
          if (heldInspection && originalStopped) {
            const originalFetchFor = authentication.workload.fetchFor.bind(
              authentication.workload,
            );
            const spy = vi
              .spyOn(authentication.workload, "fetchFor")
              .mockImplementation((target, origin) => {
                const send = originalFetchFor(target, origin);
                return (input, init) => {
                  const originalResponse = send(input, init);
                  if (
                    target === "runtime-controller" &&
                    init?.method === "GET"
                  ) {
                    void originalResponse
                      .then((response) => {
                        if (response.body === null)
                          throw new Error("Missing original inspection body");
                        const originalReader = response.body.getReader.bind(
                          response.body,
                        );
                        Object.defineProperty(response.body, "getReader", {
                          value: () => {
                            const reader = originalReader();
                            const originalCancel = reader.cancel.bind(reader);
                            reader.cancel = async (reason) => {
                              cancellationStarted.resolve();
                              await originalCancel(reason);
                              nativeCancellationJoined = true;
                              await cancellationRelease.promise;
                              cancellationJoined.resolve();
                              if (proofSource === "held-error")
                                throw new Error(
                                  "Injected original inspection cleanup failure",
                                );
                            };
                            return reader;
                          },
                        });
                      })
                      .catch((error: unknown) => failures.push(error));
                  }
                  // Return the exact original authenticated response Promise.
                  return originalResponse;
                };
              });
            restoreFetch.push(() => spy.mockRestore());
          }
          return within(
            track(
              startAgentAcpService(
                {
                  ...loaded,
                  listen: { host: "127.0.0.1", port: 0 },
                  controlListen: { host: "127.0.0.1", port: 0 },
                  databaseTimeoutMs: 5000,
                  runTimeoutMs: 15_000,
                  authentication,
                  ...(registrationOrigin === undefined
                    ? {}
                    : {
                        ownerIncarnation: {
                          memberId: "acp-warm-owned",
                          listen: { host: "127.0.0.1", port: 0 },
                          runtimeControllerUrl: registrationOrigin,
                          registrationTimeoutMs: 5000,
                        },
                      }),
                },
                NOOP_TELEMETRY,
                ownershipLost,
              ).then(async (service) => {
                services.push(service);
                void service.failure.then((error) => failures.push(error));
                if (closing) await service.shutdown();
                return service;
              }),
            ),
            "service startup",
            20_000,
          );
        }

        function http(
          service: RunningAgentAcpService,
          path: string,
          init?: RequestInit,
          control = false,
        ) {
          const origin = serviceOrigin(service, control);
          return track(
            (async () => {
              const response = await fetch(origin + path, {
                ...init,
                signal: AbortSignal.any([
                  requestAbort.signal,
                  AbortSignal.timeout(5000),
                ]),
              });
              return {
                status: response.status,
                body: (await response.json()) as unknown,
              };
            })(),
          );
        }

        async function stored(sessionId: string): Promise<StoredRun[]> {
          return (
            await pool.query<StoredRun>(
              `SELECT r.id, r.state, r.terminal_class, r.executor_state,
                  r.tool_effect_state, r.unknown_effect_source, r.stop_reason,
                  r.error_class, r.execution_snapshot,
                  s.organization_id, s.agent_id, s.principal_id,
                  r.execution_owner_registration_id, r.execution_owner_member_id,
                  r.execution_owner_incarnation_id, r.execution_owner_epoch::text
           FROM runs r JOIN acp_sessions s ON s.id = r.session_id
           WHERE r.session_id = $1 ORDER BY r.id`,
              [sessionId],
            )
          ).rows;
        }

        async function exercise(
          service: RunningAgentAcpService,
          expected = {
            configurationRevision: 1,
            model: "test-model",
            modelRequestCount: 1,
          },
          agentId = "agent-1",
        ) {
          const expectedExecutionId =
            agentId === "agent-1"
              ? runtimeExecutionId
              : otherRuntimeExecutionId;
          const expectedConnectionId =
            agentId === "agent-1" ? connectionId : otherConnectionId;
          const connected = track(
            AcpWireClient.connect(
              serviceOrigin(service).replace("http:", "ws:") +
                `/v${version}/acp`,
              { ...executionIdentity(), agentId },
            ).then(async (client) => {
              clients.push(client);
              if (closing) await client.close();
              return client;
            }),
          );
          const client = await within(connected, "ACP connect", 5000);
          await within(
            track(client.initialize(version)),
            "ACP initialize",
            10_000,
          );
          const request = (
            method: string,
            params: Record<string, unknown>,
          ): Promise<WireFrame> =>
            within(track(client.request(method, params)), method, 10_000);
          const created = await request("session/new", {
            cwd: "/workspace",
            mcpServers: [],
          });
          expect(created.error).toBeUndefined();
          const sessionId = created.result?.sessionId;
          expect(typeof sessionId).toBe("string");
          if (typeof sessionId !== "string")
            throw new Error("Missing warm Session ID");
          const text = `warm-v${version}-${boot}`;
          const prompted = await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text }],
          });
          expect(prompted.error).toBeUndefined();
          await expect
            .poll(async () => (await stored(sessionId))[0]?.state, {
              timeout: 10_000,
            })
            .toBe("completed");
          const rows = await stored(sessionId);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            state: "completed",
            terminal_class: "completed",
            executor_state: "quiescent",
            tool_effect_state: "none",
            unknown_effect_source: null,
            stop_reason: "end_turn",
            error_class: null,
            organization_id: "organization-1",
            agent_id: agentId,
            principal_id: "principal-1",
            execution_snapshot: {
              configurationRevision: expected.configurationRevision,
              providerConnectionId: "provider-1",
              runtime: {
                executionId: expectedExecutionId,
                connectionId: expectedConnectionId,
              },
            },
          });
          const messages = await pool.query<{ kind: string; content: unknown }>(
            `SELECT kind, payload->'content' AS content FROM session_messages WHERE run_id = $1
           AND kind IN ('user_message', 'agent_message') ORDER BY sequence`,
            [rows[0]!.id],
          );
          expect(messages.rows).toEqual([
            { kind: "user_message", content: [{ type: "text", text }] },
            { kind: "agent_message", content: [{ type: "text", text: reply }] },
          ]);
          const models = modelRequests.filter(
            (request) => request.boot === boot,
          );
          expect(models).toHaveLength(expected.modelRequestCount);
          const latestModel = models.at(-1)!;
          expect(latestModel).toMatchObject({
            authorized: true,
            model: expected.model,
          });
          expect(JSON.stringify(latestModel.messages)).toContain(text);
          const runtimes = runtimeRequests.filter(
            (request) =>
              request.boot === boot &&
              request.executionId === expectedExecutionId,
          );
          expect(runtimes.length).toBeGreaterThan(0);
          expect(
            runtimes.every(
              (request) =>
                request.authorized &&
                request.executionId === expectedExecutionId,
            ),
          ).toBe(true);
          expect(resourceReads).toContain(boot);
          if (ownership === "owned") {
            const registered = registrations.at(-1)!;
            expect(registered).toBeDefined();
            expect(rows[0]!.execution_owner_registration_id).toBe(
              registered.registration_id,
            );
            expect(rows[0]).toMatchObject({
              execution_owner_registration_id: registered.registration_id,
              execution_owner_member_id: registered.member_id,
              execution_owner_incarnation_id: registered.incarnation_id,
            });
            const lease = (
              await pool.query<{
                owner_instance_id: string;
                epoch: string;
                current: boolean;
              }>(
                "SELECT owner_instance_id,epoch::text,expires_at>clock_timestamp() AS current FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                ["organization-1", agentId],
              )
            ).rows;
            expect(lease).toEqual([
              {
                owner_instance_id: registered.incarnation_id,
                epoch: rows[0]!.execution_owner_epoch,
                current: true,
              },
            ]);
          } else
            expect(rows[0]).toMatchObject({
              execution_owner_registration_id: null,
              execution_owner_member_id: null,
              execution_owner_incarnation_id: null,
              execution_owner_epoch: null,
            });
          await client.close();
          return { sessionId, rows };
        }

        function runtimeHandler(runtimeExecutionId: string) {
          return createMcpHandler(
            () => {
              const server = new McpServer({
                name: "warm-runtime-peer",
                version: "1.0.0",
              });
              server.registerResource(
                "runtime-info",
                "antnest://runtime/info",
                { mimeType: "application/json" },
                (uri) => {
                  resourceReads.push(boot);
                  const { executionId: _executionId, ...information } =
                    runtimeInformation();
                  void _executionId;
                  return {
                    contents: [
                      {
                        uri: uri.toString(),
                        mimeType: "application/json",
                        text: JSON.stringify({
                          ...information,
                          execution_id: runtimeExecutionId,
                          instructions: null,
                          skills: [],
                        }),
                      },
                    ],
                  };
                },
              );
              server.registerTool(
                "echo",
                {
                  description: "Unused warm-admission fixture Tool",
                  inputSchema: z.object({ text: z.string() }),
                },
                () => {
                  throw new Error("Warm admission must not execute a Tool");
                },
              );
              return server;
            },
            { legacy: "reject" },
          );
        }
        const handler = runtimeHandler(runtimeExecutionId);
        const otherHandler = unavailablePredecessor
          ? runtimeHandler(otherRuntimeExecutionId)
          : undefined;

        try {
          await pool.query("DROP SCHEMA public CASCADE");
          await pool.query("CREATE SCHEMA public");
          if (ownership === "owned") {
            // This peer supplies registration and authoritative process-stop facts.
            // Prompt, persistence, warm
            // restoration, provider calls and the probe remain actual service paths.
            const registration = await startPeer(async (request, response) => {
              const expectedToken = readFileSync(
                join(
                  testSecurityEnvironment().ANTNEST_SERVICE_AUTH_TOKEN_DIR,
                  "runtime-controller",
                ),
                "utf8",
              ).trim();
              expect(
                request.headers["antnest-service-authorization"] ===
                  `Bearer ${expectedToken}`,
              ).toBe(true);
              if (request.method === "GET") {
                inspectionRequests++;
                expect(predecessor).toBe(true);
                expect(originalStopped).toBe(true);
                expect(request.url).toBe(
                  `/internal/acp-incarnations/${registrations[0]!.registration_id}`,
                );
                if (inspectionUnavailable) {
                  response.writeHead(503).end();
                  return;
                }
                if (heldInspection) {
                  response.writeHead(200, {
                    "content-type": "application/json",
                  });
                  response.write('{"state":');
                  return;
                }
                if (proofSource === "http-error") {
                  response.writeHead(503).end();
                  return;
                }
                if (proofSource === "running" || proofSource === "unknown") {
                  const inspection: OwnerInspection =
                    proofSource === "running"
                      ? {
                          state: "running",
                          ...registrations[0]!,
                          observed_at: new Date().toISOString(),
                        }
                      : {
                          state: "unknown",
                          registration_id: registrations[0]!.registration_id,
                          reason: "platform_unavailable",
                        };
                  inspections.push(inspection);
                  response
                    .writeHead(200, { "content-type": "application/json" })
                    .end(JSON.stringify(inspection));
                  return;
                }
                const inspection: OwnerInspection = {
                  state: "stopped",
                  ...registrations[0]!,
                  stop_receipt: stopReceipt,
                };
                inspections.push(inspection);
                response
                  .writeHead(200, {
                    "content-type": "application/json",
                    "cache-control": "no-store",
                  })
                  .end(JSON.stringify(inspection));
                return;
              }
              expect(request.method).toBe("POST");
              expect(request.url).toBe("/internal/acp-incarnations/register");
              const input: unknown = JSON.parse(
                (await readBody(request)).toString("utf8"),
              );
              const challenge = parseOwnerProbeRequest({
                ...(input as Record<string, unknown>),
                challenge: randomBytes(32).toString("hex"),
              });
              const ownerProbe = probeListen.mock.contexts.at(-1);
              const address =
                ownerProbe instanceof OwnerProbeServer
                  ? ownerProbe.address()
                  : null;
              if (address === null)
                throw new Error(
                  "Owner probe did not listen before registration",
                );
              const probeResponse = await fetch(
                `http://127.0.0.1:${address.port}/internal/acp-owner/incarnation/probe`,
                {
                  method: "POST",
                  headers: {
                    ...workloadHeaders("runtime-controller"),
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(challenge),
                  signal: AbortSignal.any([
                    requestAbort.signal,
                    AbortSignal.timeout(2000),
                  ]),
                },
              );
              const probeBody: unknown = await probeResponse.json();
              expect(probeResponse.status).toBe(200);
              expect(probeBody).toEqual(challenge);
              const receipt = {
                registration_id: randomUUID(),
                member_id: challenge.member_id,
                incarnation_id: challenge.incarnation_id,
              };
              registrations.push(receipt);
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify(receipt));
            });
            peers.push(registration);
            registrationOrigin = registration.origin;
          }
          // These are real local HTTP peers, not a second Antnest service or a
          // fixture that reconstructs secrets and republishes on every boot.
          const model = await startPeer(async (request, response) => {
            const payload = JSON.parse(
              (await readBody(request)).toString("utf8"),
            ) as { model?: unknown; messages?: unknown };
            const authorized =
              request.headers.authorization === "Bearer " + providerSecret;
            modelRequests.push({
              boot,
              authorized,
              model: payload.model,
              messages: payload.messages,
            });
            if (
              !authorized ||
              request.method !== "POST" ||
              request.url !== "/v1/chat/completions"
            ) {
              response.writeHead(401).end();
              return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: { role: "assistant", content: reply },
                  },
                ],
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 2,
                  total_tokens: 5,
                },
              }),
            );
          });
          peers.push(model);
          async function startRuntime(
            handler: ReturnType<typeof createMcpHandler>,
            runtimeExecutionId: string,
            runtimeToken: string,
          ) {
            const runtime = await startPeer(async (request, response) => {
              const executionId =
                request.headers["x-antnest-expected-execution-id"];
              const authorized =
                request.headers["antnest-service-authorization"] ===
                  "Bearer " + runtimeToken &&
                executionId === runtimeExecutionId;
              runtimeRequests.push({ boot, authorized, executionId });
              if (!authorized) {
                response.writeHead(401).end();
                return;
              }
              const body = await readBody(request);
              const headers = new Headers();
              for (const [name, value] of Object.entries(request.headers)) {
                if (Array.isArray(value))
                  for (const item of value) headers.append(name, item);
                else if (value !== undefined) headers.set(name, value);
              }
              const init: RequestInit & { duplex?: "half" } = {
                method: request.method ?? "GET",
                headers,
              };
              if (body.length > 0) {
                init.body = new Uint8Array(body);
                init.duplex = "half";
              }
              const result = await handler.fetch(
                new Request(
                  `http://${request.headers.host}${request.url ?? "/"}`,
                  init,
                ),
              );
              response.statusCode = result.status;
              result.headers.forEach((value, name) =>
                response.setHeader(name, value),
              );
              response.end(Buffer.from(await result.arrayBuffer()));
            });
            peers.push(runtime);
            return runtime;
          }
          const runtime = await startRuntime(
            handler,
            runtimeExecutionId,
            runtimeToken,
          );
          const configuration = executionConfiguration();
          configuration.providers[0]!.base_url = model.origin + "/v1";
          configuration.providers[0]!.credential.secret = providerSecret;
          configuration.agents[0]!.runtime = {
            runtime_revision: "rtv_" + randomBytes(16).toString("hex"),
            runtime_execution_id: runtimeExecutionId,
            mcp_endpoint: runtime.origin + "/mcp",
            connection_id: connectionId,
            credential: { caller: "agent-acp-service", token: runtimeToken },
          };
          if (otherHandler !== undefined) {
            const otherRuntime = await startRuntime(
              otherHandler,
              otherRuntimeExecutionId,
              otherRuntimeToken,
            );
            configuration.agents.push({
              ...structuredClone(configuration.agents[0]!),
              agent_id: "agent-2",
              runtime: {
                runtime_revision: "rtv_" + randomBytes(16).toString("hex"),
                runtime_execution_id: otherRuntimeExecutionId,
                mcp_endpoint: otherRuntime.origin + "/mcp",
                connection_id: otherConnectionId,
                credential: {
                  caller: "agent-acp-service",
                  token: otherRuntimeToken,
                },
              },
            });
          }
          const first = await start();
          publicationCount++;
          expect(
            await http(
              first,
              "/rpc/agent-acp/apply-execution-snapshot",
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("agent-controller"),
                  "content-type": "application/json",
                },
                body: JSON.stringify(configuration),
              },
              true,
            ),
          ).toEqual({
            status: 200,
            body: { organization_id: "organization-1", applied_revision: 1 },
          });
          const before = await exercise(first);
          if (predecessor) {
            // Seed a durable accepted reservation through the real owned writers.
            // No executor dispatch occurs for this fixture; the test proves startup
            // proof consumption, not a physical two-replica crash/handoff.
            const identity = {
              ...executionIdentity(),
              connectionId: randomUUID(),
            };
            const lease = (
              await pool.query<{ epoch: string }>(
                "SELECT epoch::text FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                [identity.organizationId, identity.agentId],
              )
            ).rows[0]!;
            const original = registrations[0]!;
            const accessRevision = (
              before.rows[0]!.execution_snapshot as { accessRevision: string }
            ).accessRevision;
            if (learningState === "none") {
              const repositories = createOwnedAgentRepositories(
                new PostgresKernel(pool),
                new SecretBox(Buffer.from(key, "base64")),
                {
                  registration: original,
                  fence: {
                    organizationId: identity.organizationId,
                    agentId: identity.agentId,
                    ownerInstanceId: original.incarnation_id,
                    epoch: lease.epoch,
                  },
                },
              );
              predecessorSessionId = randomUUID();
              const mcpRevisionId = randomUUID(),
                runId = randomUUID();
              await repositories.sessions.create({
                sessionId: predecessorSessionId,
                binding: identity,
                cwd: "/workspace",
                mcpRevisionId,
                mcpSources: [],
              });
              await repositories.runs.createRunIntent({
                runId,
                requestId: randomUUID(),
                sessionId: predecessorSessionId,
                expectedAccessRevision: accessRevision,
                userMessageId: randomUUID(),
                prompt: [
                  {
                    type: "text",
                    text: "This predecessor Prompt must never be replayed",
                  },
                ],
                createdAt: new Date(),
              });
              await repositories.runs.acceptRun({
                runId,
                snapshot: runSnapshot({
                  configuration: publicExecutionConfiguration(configuration),
                  identity,
                  overrides: {},
                  accessRevision,
                  clientMcpRevisionId: mcpRevisionId,
                  deadlineAt: new Date(Date.now() + 60_000),
                }),
                environmentFact: null,
                acceptedAt: new Date(),
              });
              predecessorRun = (await stored(predecessorSessionId))[0]!;
              expect(predecessorRun.state).toBe("running");
              expect(modelRequests).toHaveLength(1);
            } else {
              // The source is the actual completed first Prompt. Claim using
              // legal writers after the real quiet interval; never backdate it.
              const repositories = createOwnedLearningRepositories(
                new PostgresKernel(pool),
                {
                  registration: original,
                  fence: {
                    organizationId: identity.organizationId,
                    agentId: identity.agentId,
                    ownerInstanceId: original.incarnation_id,
                    epoch: lease.epoch,
                  },
                },
              );
              const policy = learningPolicySchema.parse({
                organization_id: identity.organizationId,
                agent_id: identity.agentId,
                owner_principal_id: identity.principalId,
                revision: "b".repeat(64),
                activation_cut_at: new Date(Date.now() - 180_000).toISOString(),
                mode: "automatic",
                scope: { auto_generated_personal: true, adopted_paths: [] },
                pinned_paths: [],
                limits: {
                  daily_reviews: 20,
                  daily_model_input_tokens: 320000,
                  daily_model_output_tokens: 80000,
                },
              });
              const scanScope = {
                organizationId: identity.organizationId,
                agentId: identity.agentId,
                ownerId: identity.principalId,
              };
              await repositories.scan.activate(
                scanScope,
                policy.revision,
                policy.activation_cut_at,
              );
              const pending = await repositories.scan.enqueue(
                scanScope,
                before.rows[0]!.id,
                policy,
              );
              expect(pending).not.toBeNull();
              await delay(15_050, undefined, { signal: requestAbort.signal });
              const claim = await repositories.scan.claimNext(
                policy,
                pending!.taskId,
              );
              expect(claim).not.toBeNull();
              const settled = randomUUID();
              await repositories.budget.reserve(claim!, policy, settled, {
                inputTokens: 100,
                outputTokens: 100,
                durationMs: 1000,
              });
              if (learningState === "install") {
                const evidence = await repositories.evidence.readAndRecord(
                  claim!,
                );
                const authenticated = evidence.items.find(
                  (item) => item.kind === "authenticated_user",
                );
                expect(authenticated).toBeDefined();
                const proposal = {
                  decision: "propose" as const,
                  name: "persist-once",
                  description: "Persist once.",
                  instructions: "unused",
                  rules: [
                    {
                      text: authenticated!.text,
                      evidenceIds: [authenticated!.evidenceId],
                    },
                  ],
                };
                const candidatePackage = buildLearningCandidatePackage(
                  proposal,
                  evidence,
                );
                await repositories.budget.settleReview(
                  claim!,
                  settled,
                  { inputTokens: 10, outputTokens: 20, durationMs: 30 },
                  proposal,
                );
                const candidateId = randomUUID();
                await repositories.candidates.record({
                  claim: claim!,
                  candidateId,
                  package: candidatePackage,
                  expectedBaseDigest: null,
                });
                const runtime = configuration.agents[0]!.runtime;
                await repositories.bases.recordAdmitted(claim!, candidateId, {
                  kind: "policy",
                  policyRevision: policy.revision,
                  packagePath: candidatePackage.packagePath,
                  expectedBaseDigest: null,
                  targetDigest: candidatePackage.targetDigest,
                  evidenceIds: candidatePackage.evidenceIds,
                  executionId: runtime.runtime_execution_id,
                });
                installRequestId = learningApplyRequestId(
                  claim!,
                  candidateId,
                  "install",
                  1,
                );
                await repositories.intents.reserve({
                  claim: claim!,
                  requestId: installRequestId,
                  action: "install",
                  executionId: runtime.runtime_execution_id,
                  revision: runtime.runtime_revision,
                  mcpEndpoint: runtime.mcp_endpoint,
                  connectionId: runtime.connection_id!,
                  bodySha256: `sha256:${"a".repeat(64)}`,
                  requestFacts: {
                    candidate_id: candidateId,
                    package_path: candidatePackage.packagePath,
                    expected_base_digest: null,
                    target_digest: candidatePackage.targetDigest,
                  },
                });
                await repositories.intents.markUnknown(
                  claim!,
                  installRequestId,
                );
                originalInstall = (
                  await pool.query(
                    "SELECT * FROM learning_maintenance_intents WHERE request_id=$1",
                    [installRequestId],
                  )
                ).rows;
              } else {
                await repositories.budget.settle(claim!, settled, {
                  inputTokens: 10,
                  outputTokens: 20,
                  durationMs: 30,
                });
              }
              await repositories.budget.reserve(claim!, policy, randomUUID(), {
                inputTokens: 100,
                outputTokens: 100,
                durationMs: 1000,
              });
              if (learningState === "paused")
                await repositories.outcomes.pauseRunning(
                  claim!,
                  "model_unavailable",
                );
              predecessorLearning = {
                taskId: claim!.taskId,
                claimId: claim!.claimId,
                generation: claim!.generation,
                epoch: lease.epoch,
                facts: await learningFacts(claim!.taskId),
              };
              expect(modelRequests).toHaveLength(1);
            }
            if (proofSource === "stored") {
              // A separate admitting Agent can persist the same process-stop
              // fact first. It needs no Runtime or dispatched model work.
              const binding = {
                ...identity,
                agentId: "proof-witness",
                connectionId: randomUUID(),
              };
              const lease = await witnessLeases.tryAcquire(
                binding,
                original.incarnation_id,
                30_000,
              );
              if (lease === null) throw new Error("Missing witness lease");
              witnessFences.add(lease.fence);
              const repositories = createOwnedAgentRepositories(
                new PostgresKernel(pool),
                new SecretBox(Buffer.from(key, "base64")),
                { registration: original, fence: lease.fence },
              );
              const sessionId = randomUUID(),
                runId = randomUUID();
              await repositories.sessions.create({
                sessionId,
                binding,
                cwd: "/workspace",
                mcpRevisionId: randomUUID(),
                mcpSources: [],
              });
              await repositories.runs.createRunIntent({
                runId,
                requestId: randomUUID(),
                sessionId,
                expectedAccessRevision: accessRevision,
                userMessageId: randomUUID(),
                prompt: [{ type: "text", text: "Unaccepted proof witness" }],
                createdAt: new Date(),
              });
              witness = { runId, fence: lease.fence };
            }
          }
          expect(senderDirectories()).toHaveLength(1);
          const firstDirectory = senderDirectories().find((directory) =>
            existsSync(join(directory, connectionId)),
          )!;
          assertSender(firstDirectory);
          if (unavailablePredecessor)
            expect(
              readFileSync(
                join(firstDirectory, otherConnectionId, "antnest-runtime"),
                "utf8",
              ) === otherRuntimeToken,
            ).toBe(true);
          await first.shutdown();
          originalStopped = true;
          expect(existsSync(firstDirectory)).toBe(false);

          if (witness !== undefined) {
            expect(await witnessLeases.release(witness.fence)).toBe(true);
            witnessFences.delete(witness.fence);
            const successor = {
              registration_id: randomUUID(),
              member_id: "proof-successor",
              incarnation_id: randomUUID(),
            };
            const lease = await witnessLeases.tryAcquire(
              witness.fence,
              successor.incarnation_id,
              30_000,
            );
            if (lease === null)
              throw new Error("Missing successor witness lease");
            witnessFences.add(lease.fence);
            const auth = loadConfig({
              ...testSecurityEnvironment(),
              ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
                process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS,
              ANTNEST_ACP_DATABASE_URL: databaseUrl!,
              ANTNEST_ACP_CLIENT_MCP_KEY: key,
            }).authentication.workload;
            auxiliaryAuthentication.push(auth);
            const inspection = await new RuntimeControllerIncarnations({
              origin: registrationOrigin!,
              authentication: auth,
            }).inspect(registrations[0]!, requestAbort.signal);
            await new PostgresOwnerRecovery(new PostgresKernel(pool), {
              registration: successor,
              fence: lease.fence,
            }).recoverRun({
              runId: witness.runId,
              inspection,
              recoveredAt: new Date(),
            });
            storedProof = (
              await pool.query("SELECT * FROM owner_stop_receipts")
            ).rows;
            witnessAudit = (
              await pool.query(
                "SELECT * FROM run_owner_recoveries WHERE run_id=$1",
                [witness.runId],
              )
            ).rows;
            expect(witnessAudit).toEqual([
              expect.objectContaining({
                organization_id: witness.fence.organizationId,
                agent_id: witness.fence.agentId,
                original_registration_id: registrations[0]!.registration_id,
                original_member_id: registrations[0]!.member_id,
                original_incarnation_id: registrations[0]!.incarnation_id,
                original_epoch: witness.fence.epoch,
                recovering_registration_id: successor.registration_id,
                recovering_member_id: successor.member_id,
                recovering_incarnation_id: successor.incarnation_id,
                recovering_epoch: lease.fence.epoch,
                receipt_id: stopReceipt.receipt_id,
              }),
            ]);
            expect(await witnessLeases.release(lease.fence)).toBe(true);
            witnessFences.delete(lease.fence);
            inspectionUnavailable = true;
          }

          boot = "restored";
          const aReleases = () =>
            releaseLease.mock.calls.filter(
              ([fence]) => fence.agentId === "agent-1",
            ).length;
          const initialAReleases = aReleases(),
            workerReleases = releaseWorker.mock.calls.length,
            poolEnds = endPool.mock.calls.length;
          const second = await within(
            start(),
            "independent Agent warm readiness",
            15_000,
          );
          expect((await http(second, "/status")).status).toBe(200);
          if (learningState === "install") {
            expect(predecessorLearning).toBeDefined();
            expect(
              (await learningFacts(predecessorLearning!.taskId)).task,
            ).toMatchObject({
              state: "cancelled",
              cancel_reason: "worker_lost",
            });
            expect(inspectionRequests).toBe(1);
            const protection = (
              await pool.query(
                "SELECT * FROM learning_runtime_protections WHERE request_id=$1",
                [installRequestId],
              )
            ).rows;
            expect(protection).toHaveLength(1);
            const barrier = await http(
              second,
              "/rpc/agent-acp/get-runtime-barrier",
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("agent-controller"),
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  organization_id: configuration.organization_id,
                  agent_id: "agent-1",
                  expected_runtime_revision:
                    configuration.agents[0]!.runtime.runtime_revision,
                }),
              },
              true,
            );
            expect(barrier).toMatchObject({
              status: 200,
              body: {
                barrier: {
                  reason: "runtime_barrier_required",
                  runtime_execution_id: runtimeExecutionId,
                },
              },
            });
            const closed = structuredClone(configuration);
            closed.revision++;
            closed.agents[0] = closedExecutionAgent(closed.agents[0]!);
            closed.agents[0].operation_id = randomUUID();
            publicationCount++;
            expect(
              await http(
                second,
                "/rpc/agent-acp/apply-execution-snapshot",
                {
                  method: "POST",
                  headers: {
                    ...workloadHeaders("agent-controller"),
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(closed),
                },
                true,
              ),
            ).toEqual({
              status: 200,
              body: {
                organization_id: configuration.organization_id,
                applied_revision: closed.revision,
              },
            });
            const settlement = await http(
              second,
              "/rpc/agent-acp/settle-agent",
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("agent-controller"),
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  organization_id: configuration.organization_id,
                  agent_id: "agent-1",
                  minimum_revision: closed.revision,
                  operation_id: closed.agents[0].operation_id,
                  mode: "wait",
                  deadline_at: new Date(Date.now() + 5000).toISOString(),
                }),
              },
              true,
            );
            expect(settlement).toEqual({
              status: 200,
              body: {
                applied_revision: closed.revision,
                outcome: "runtime_barrier_required",
              },
            });
            for (const [override, expected] of [
              [
                { deadline_at: new Date(Date.now() - 1000).toISOString() },
                {
                  status: 200,
                  body: {
                    applied_revision: closed.revision,
                    outcome: "not_settled",
                  },
                },
              ],
              [{ operation_id: randomUUID() }, { status: 409 }],
              [{ minimum_revision: closed.revision + 1 }, { status: 409 }],
            ] as const) {
              expect(
                await http(
                  second,
                  "/rpc/agent-acp/settle-agent",
                  {
                    method: "POST",
                    headers: {
                      ...workloadHeaders("agent-controller"),
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({
                      organization_id: configuration.organization_id,
                      agent_id: "agent-1",
                      minimum_revision: closed.revision,
                      operation_id: closed.agents[0].operation_id,
                      mode: "wait",
                      deadline_at: new Date(Date.now() + 5000).toISOString(),
                      ...override,
                    }),
                  },
                  true,
                ),
              ).toMatchObject(expected);
            }
            expect(
              (
                await pool.query(
                  "SELECT * FROM learning_maintenance_intents WHERE request_id=$1",
                  [installRequestId],
                )
              ).rows,
            ).toEqual(originalInstall);
            expect(
              (
                await pool.query(
                  "SELECT * FROM learning_runtime_protections WHERE request_id=$1",
                  [installRequestId],
                )
              ).rows,
            ).toEqual(protection);
            expect(await stored(before.sessionId)).toEqual(before.rows);
            expect(modelRequests).toHaveLength(1);
          } else if (unavailablePredecessor) {
            if (heldInspection)
              await within(
                cancellationStarted.promise,
                "original inspection cancellation",
                2000,
              );
            if (heldInspection) {
              expect(aReleases()).toBe(initialAReleases);
              expect(releaseWorker).toHaveBeenCalledTimes(workerReleases);
              expect(endPool).toHaveBeenCalledTimes(poolEnds);
            }
            expect(inspectionRequests).toBe(1);
            await assertPredecessorUnchanged();
            expect(
              (await pool.query("SELECT * FROM owner_stop_receipts")).rows,
            ).toEqual([]);
            expect(
              (await pool.query("SELECT * FROM run_owner_recoveries")).rows,
            ).toEqual([]);
            expect(
              (await pool.query("SELECT * FROM learning_owner_recoveries"))
                .rows,
            ).toEqual([]);
            const b = await exercise(
              second,
              {
                configurationRevision: 1,
                model: "test-model",
                modelRequestCount: 1,
              },
              "agent-2",
            );
            const blocked = await within(
              track(
                AcpWireClient.connect(
                  serviceOrigin(second).replace("http:", "ws:") + "/v2/acp",
                  executionIdentity(),
                ).then(async (client) => {
                  clients.push(client);
                  if (closing) await client.close();
                  return client;
                }),
              ),
              "unavailable Agent connect",
              5000,
            );
            await within(
              track(blocked.initialize(2)),
              "unavailable Agent initialize",
              5000,
            );
            const denied = await within(
              track(
                blocked.request("session/new", {
                  cwd: "/workspace",
                  mcpServers: [],
                }),
              ),
              "unavailable Agent session",
              5000,
            );
            expect(denied.error).toMatchObject({
              data: { code: "agent_unavailable" },
            });
            await blocked.close();
            // A missing owner cannot be acknowledged, but that rejection must
            // leave the already healthy B's published configuration usable.
            const ack = await http(
              second,
              "/rpc/agent-acp/apply-execution-snapshot",
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("agent-controller"),
                  "content-type": "application/json",
                },
                body: JSON.stringify(configuration),
              },
              true,
            );
            expect(ack.status).toBe(503);
            await exercise(
              second,
              {
                configurationRevision: 1,
                model: "test-model",
                modelRequestCount: 2,
              },
              "agent-2",
            );
            expect(await stored(b.sessionId)).toEqual(b.rows);
            await assertPredecessorUnchanged();
            expect(ownershipLost).not.toHaveBeenCalled();
            expect(failures).toEqual([]);
            expect(JSON.stringify(modelRequests)).not.toContain(
              "This predecessor Prompt must never be replayed",
            );
            if (heldInspection) {
              expect(aReleases()).toBe(initialAReleases);
              expect(releaseWorker).toHaveBeenCalledTimes(workerReleases);
              expect(endPool).toHaveBeenCalledTimes(poolEnds);
              let finished = false;
              const shutdown = track(second.shutdown()).then(
                () => {
                  finished = true;
                  return undefined;
                },
                (error: unknown) => {
                  finished = true;
                  return error;
                },
              );
              await delay(100);
              expect(finished).toBe(false);
              expect(aReleases()).toBe(initialAReleases);
              expect(releaseWorker).toHaveBeenCalledTimes(workerReleases);
              expect(endPool).toHaveBeenCalledTimes(poolEnds);
              expect(nativeCancellationJoined).toBe(true);
              cancellationRelease.resolve();
              const shutdownFailure = await within(
                shutdown,
                "shutdown joins original inspection cancellation",
                10_000,
              );
              if (proofSource === "held-error") {
                expect(isOnlyInspectionCleanupFailure(shutdownFailure)).toBe(
                  true,
                );
                expectedShutdownFailure = {
                  service: second,
                  error: shutdownFailure,
                };
              } else expect(shutdownFailure).toBeUndefined();
              await cancellationJoined.promise;
              expect(aReleases()).toBe(initialAReleases + 1);
              expect(releaseWorker).toHaveBeenCalledTimes(workerReleases + 1);
              expect(endPool).toHaveBeenCalledTimes(poolEnds + 1);
            }
          } else {
            if (predecessorLearning !== undefined) {
              expect(inspectionRequests).toBe(1);
              expect(inspections).toHaveLength(1);
              const beforeLearning = predecessorLearning.facts;
              const afterLearning = await learningFacts(
                predecessorLearning.taskId,
              );
              recoveredLearning = afterLearning;
              expect(afterLearning.task.updated_at).toBeInstanceOf(Date);
              expect(afterLearning.task).toEqual({
                ...beforeLearning.task,
                state: "cancelled",
                cancel_reason: "worker_lost",
                pause_reason: null,
                updated_at: afterLearning.task.updated_at,
              });
              expect(afterLearning.calls).toEqual(
                beforeLearning.calls.map((call) => ({
                  ...call,
                  state: call.state === "reserved" ? "unknown" : call.state,
                })),
              );
              expect(afterLearning.history).toEqual(beforeLearning.history);
              const currentLease = (
                await pool.query<{ epoch: string }>(
                  "SELECT epoch::text FROM agent_leases WHERE organization_id=$1 AND agent_id=$2 AND owner_instance_id=$3",
                  [
                    "organization-1",
                    "agent-1",
                    registrations[1]!.incarnation_id,
                  ],
                )
              ).rows[0]!;
              expect(
                (
                  await pool.query(
                    "SELECT task_id,claim_id,generation,organization_id,agent_id,original_registration_id,original_member_id,original_incarnation_id,original_epoch::text,recovering_registration_id,recovering_member_id,recovering_incarnation_id,recovering_epoch::text,receipt_id FROM learning_owner_recoveries",
                  )
                ).rows,
              ).toEqual([
                {
                  task_id: predecessorLearning.taskId,
                  claim_id: predecessorLearning.claimId,
                  generation: predecessorLearning.generation,
                  organization_id: "organization-1",
                  agent_id: "agent-1",
                  original_registration_id: registrations[0]!.registration_id,
                  original_member_id: registrations[0]!.member_id,
                  original_incarnation_id: registrations[0]!.incarnation_id,
                  original_epoch: predecessorLearning.epoch,
                  recovering_registration_id: registrations[1]!.registration_id,
                  recovering_member_id: registrations[1]!.member_id,
                  recovering_incarnation_id: registrations[1]!.incarnation_id,
                  recovering_epoch: currentLease.epoch,
                  receipt_id: stopReceipt.receipt_id,
                },
              ]);
              expect(
                (await pool.query("SELECT inspection FROM owner_stop_receipts"))
                  .rows,
              ).toEqual([{ inspection: inspections[0] }]);
              if (witness !== undefined) {
                expect(
                  (await pool.query("SELECT * FROM owner_stop_receipts")).rows,
                ).toEqual(storedProof);
                expect(
                  (
                    await pool.query(
                      "SELECT * FROM run_owner_recoveries WHERE run_id=$1",
                      [witness.runId],
                    )
                  ).rows,
                ).toEqual(witnessAudit);
              }
            } else if (predecessor) {
              expect(inspectionRequests).toBe(1);
              expect(inspections).toHaveLength(1);
              expect(await stored(predecessorSessionId!)).toEqual([
                {
                  ...predecessorRun!,
                  state: "failed",
                  terminal_class: "failed",
                  executor_state: "quiescent",
                  tool_effect_state: "none",
                  unknown_effect_source: null,
                  error_class: "service_restarted_during_run",
                },
              ]);
              expect(
                (await pool.query("SELECT inspection FROM owner_stop_receipts"))
                  .rows,
              ).toEqual([{ inspection: inspections[0] }]);
              expect(
                (await pool.query("SELECT run_id FROM run_owner_recoveries"))
                  .rows,
              ).toEqual(
                expect.arrayContaining([
                  { run_id: predecessorRun!.id },
                  ...(witness === undefined ? [] : [{ run_id: witness.runId }]),
                ]),
              );
              expect(
                (await pool.query("SELECT * FROM run_owner_recoveries")).rows,
              ).toHaveLength(witness === undefined ? 1 : 2);
              if (witness !== undefined) {
                expect(
                  (await pool.query("SELECT * FROM owner_stop_receipts")).rows,
                ).toEqual(storedProof);
                expect(
                  (
                    await pool.query(
                      "SELECT * FROM run_owner_recoveries WHERE run_id=$1",
                      [witness.runId],
                    )
                  ).rows,
                ).toEqual(witnessAudit);
                const currentLease = (
                  await pool.query<{ epoch: string }>(
                    "SELECT epoch::text FROM agent_leases WHERE organization_id=$1 AND agent_id=$2 AND owner_instance_id=$3",
                    [
                      "organization-1",
                      "agent-1",
                      registrations[1]!.incarnation_id,
                    ],
                  )
                ).rows[0]!;
                expect(
                  (
                    await pool.query(
                      "SELECT organization_id,agent_id,original_registration_id,original_member_id,original_incarnation_id,original_epoch::text,recovering_registration_id,recovering_member_id,recovering_incarnation_id,recovering_epoch::text,receipt_id FROM run_owner_recoveries WHERE run_id=$1",
                      [predecessorRun!.id],
                    )
                  ).rows,
                ).toEqual([
                  {
                    organization_id: "organization-1",
                    agent_id: "agent-1",
                    original_registration_id: registrations[0]!.registration_id,
                    original_member_id: registrations[0]!.member_id,
                    original_incarnation_id: registrations[0]!.incarnation_id,
                    original_epoch: predecessorRun!.execution_owner_epoch,
                    recovering_registration_id:
                      registrations[1]!.registration_id,
                    recovering_member_id: registrations[1]!.member_id,
                    recovering_incarnation_id: registrations[1]!.incarnation_id,
                    recovering_epoch: currentLease.epoch,
                    receipt_id: stopReceipt.receipt_id,
                  },
                ]);
              }
            }
            // Capture at readiness, before any ACP request could trigger lazy restore.
            const directoriesAtReadiness = senderDirectories();
            const privateFilesAtReadiness = directoriesAtReadiness
              .filter((directory) => directory !== firstDirectory)
              .map((directory) => {
                const sender = join(directory, connectionId);
                const file = join(sender, "antnest-runtime");
                return (
                  existsSync(file) &&
                  (lstatSync(directory).mode & 0o777) === 0o700 &&
                  (lstatSync(sender).mode & 0o777) === 0o700 &&
                  (lstatSync(file).mode & 0o777) === 0o600 &&
                  readFileSync(file, "utf8") === runtimeToken
                );
              });
            expect(await stored(before.sessionId)).toEqual(before.rows);
            expect(modelRequests).toHaveLength(1);
            // Deliberately no apply(), control publication or Controller resync here.
            const after = await exercise(second);
            expect(after.sessionId).not.toBe(before.sessionId);
            expect(after.rows[0]!.id).not.toBe(before.rows[0]!.id);
            expect(await stored(before.sessionId)).toEqual(before.rows);
            expect(publicationCount).toBe(1);
            expect(directoriesAtReadiness).toHaveLength(2);
            expect(privateFilesAtReadiness).toEqual([true]);
            const secondDirectory = directoriesAtReadiness.find(
              (directory) => directory !== firstDirectory,
            );
            expect(secondDirectory).toBeDefined();
            if (secondDirectory === undefined)
              throw new Error("Missing restored sender directory");
            assertSender(secondDirectory);
            expect(existsSync(firstDirectory)).toBe(false);
            expect(ownershipLost).not.toHaveBeenCalled();

            // This same warm instance must accept the next real control
            // publication and use it for new work, without replaying either Run.
            expect(modelRequests).toHaveLength(2);
            const replacement = structuredClone(configuration);
            replacement.revision = configuration.revision + 1;
            const replacementModel = "test-model-after-warm-publication";
            replacement.models[0]!.model = replacementModel;
            publicationCount++;
            expect(
              await http(
                second,
                "/rpc/agent-acp/apply-execution-snapshot",
                {
                  method: "POST",
                  headers: {
                    ...workloadHeaders("agent-controller"),
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(replacement),
                },
                true,
              ),
            ).toEqual({
              status: 200,
              body: {
                organization_id: configuration.organization_id,
                applied_revision: replacement.revision,
              },
            });
            expect(modelRequests).toHaveLength(2);
            expect(await stored(before.sessionId)).toEqual(before.rows);
            expect(await stored(after.sessionId)).toEqual(after.rows);
            if (predecessorLearning !== undefined)
              expect(await learningFacts(predecessorLearning.taskId)).toEqual(
                recoveredLearning,
              );

            const republished = await exercise(second, {
              configurationRevision: replacement.revision,
              model: replacementModel,
              modelRequestCount: 2,
            });
            if (predecessorLearning !== undefined)
              expect(await learningFacts(predecessorLearning.taskId)).toEqual(
                recoveredLearning,
              );
            expect([before.sessionId, after.sessionId]).not.toContain(
              republished.sessionId,
            );
            expect([before.rows[0]!.id, after.rows[0]!.id]).not.toContain(
              republished.rows[0]!.id,
            );
            expect(modelRequests.map((request) => request.model)).toEqual([
              "test-model",
              "test-model",
              replacementModel,
            ]);
            if (predecessor) {
              expect(inspectionRequests).toBe(1);
              expect(inspections).toHaveLength(1);
              expect(JSON.stringify(modelRequests)).not.toContain(
                "This predecessor Prompt must never be replayed",
              );
            }
            expect(await stored(before.sessionId)).toEqual(before.rows);
            expect(await stored(after.sessionId)).toEqual(after.rows);
            expect(publicationCount).toBe(2);
            expect(services).toHaveLength(2);
            expect(services[0]).toBe(first);
            expect(services[1]).toBe(second);
            if (ownership === "owned") {
              expect(registrations).toHaveLength(2);
              expect(registrations[0]!.incarnation_id).not.toBe(
                registrations[1]!.incarnation_id,
              );
            }
            assertSender(secondDirectory);
            expect(existsSync(firstDirectory)).toBe(false);
            expect(ownershipLost).not.toHaveBeenCalled();
          }
          expect(JSON.stringify(modelRequests)).not.toContain(
            "Unaccepted proof witness",
          );
          expect(runtimeRequests.every((request) => request.authorized)).toBe(
            true,
          );
        } catch (error) {
          failures.push(error);
        } finally {
          closing = true;
          cancellationRelease.resolve();
          requestAbort.abort(new Error("Warm admission fixture is closing"));
          const settle = async (operation: () => Promise<unknown>) => {
            try {
              await operation();
            } catch (error) {
              failures.push(error);
            }
          };
          await settle(async () => {
            const results = await Promise.allSettled(
              clients.map((client) => client.close()),
            );
            for (const result of results)
              if (result.status === "rejected") failures.push(result.reason);
          });
          for (const service of services.toReversed())
            await settle(async () => {
              try {
                await service.shutdown();
              } catch (error) {
                if (
                  expectedShutdownFailure === undefined ||
                  service !== expectedShutdownFailure.service ||
                  error !== expectedShutdownFailure.error
                )
                  throw error;
              }
            });
          await Promise.allSettled(pending);
          await settle(() => handler.close());
          if (otherHandler !== undefined)
            await settle(() => otherHandler.close());
          for (const auth of auxiliaryAuthentication)
            await settle(() => auth.close());
          for (const fence of witnessFences)
            await settle(() => witnessLeases.release(fence));
          for (const peer of peers.toReversed())
            await settle(() => peer.close());
          await settle(() => pool.end());
          const directories = new Set([
            ...senderDirectories(),
            ...close.mock.contexts.flatMap((context) =>
              context instanceof RuntimeConnections ? [context.directory] : [],
            ),
          ]);
          prepare.mockRestore();
          close.mockRestore();
          probeListen.mockRestore();
          releaseLease.mockRestore();
          releaseWorker.mockRestore();
          endPool.mockRestore();
          for (const restore of restoreFetch) restore();
          for (const directory of directories) {
            if (existsSync(directory))
              failures.push(
                new Error("Owned Runtime sender directory survived shutdown"),
              );
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "Warm admission or cleanup failed",
          );
      },
      90_000,
    );
  },
);
