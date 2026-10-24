import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createOwnedAgentRepositories } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { createOwnedLearningRepositories } from "../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresWorkerLock } from "../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { RuntimeSkillMaintenanceClient } from "../../../../services/agent-acp-service/src/adapters/runtime-skill-maintenance-client.js";
import { RuntimeSkillMaintenanceSigner } from "../../../../services/agent-acp-service/src/adapters/runtime-skill-maintenance-signer.js";
import {
  parseOwnerProbeRequest,
  type OwnerRegistration,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import { learningApplyRequestId } from "../../../../services/agent-acp-service/src/domain/learning-apply-request-id.js";
import {
  buildLearningCandidatePackage,
  type LearningCandidatePackage,
} from "../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import { learningPolicySchema } from "../../../../services/agent-acp-service/src/domain/learning-policy.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import {
  testJwks,
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { snapshot } from "../../../../services/agent-acp-service/test/support/fixtures.js";
import { ProductionAcpChild } from "../support/production-acp-child.js";
import { readBody, startPeer, within } from "../support/production-peers.js";
import { runtimeAuthority } from "../support/runtime-authority.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

async function availablePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No reserved port");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function refused(port: number): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  let outcome = "pending";
  socket.once("connect", () => {
    outcome = "connected";
    socket.destroy();
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    outcome = error.code ?? "unknown";
  });
  socket.setTimeout(2000, () => {
    outcome = "timeout";
    socket.destroy();
  });
  await new Promise<void>((resolve) => socket.once("close", resolve));
  expect(outcome).toBe("ECONNREFUSED");
}

describe.skipIf(databaseUrl === undefined)(
  "two actual ACP main processes serving Skill sources",
  () => {
    it("routes single-entry inspect and exact artifact bytes to B's live owner and original Runtime", async () => {
      const root = mkdtempSync(join(tmpdir(), "acp-dual-sources-"));
      const id = randomUUID().replaceAll("-", "");
      const schema = "dual_sources_" + id;
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", "-c search_path=" + schema);
      const pool = new Pool({
        connectionString: url.toString(),
        max: 3,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 6000,
      });
      const peers: Awaited<ReturnType<typeof startPeer>>[] = [];
      const children: ProductionAcpChild[] = [];
      const originals: Promise<unknown>[] = [];
      const errors: unknown[] = [];
      const ports: number[] = [];
      const temporary: string[] = [];
      const names = ["dual-sources-a-" + id, "dual-sources-b-" + id];
      const registrations = new Map<string, OwnerRegistration>();
      const registeredChildren = new Map<string, ProductionAcpChild>();
      const registrationHistories = new Map<
        string,
        { id: string; items: OwnerRegistration[] }
      >();
      const historyRequests: string[] = [];
      const inspectionRequests: string[] = [];
      const security = testSecurityEnvironment();
      const keys = [
        generateKeyPairSync("ed25519"),
        generateKeyPairSync("ed25519"),
      ];
      const kids = ["sources-acp-a", "sources-acp-b"];
      const key = randomBytes(32);
      const organizationId = `org_${id}`;
      const principalId = `user_${randomBytes(16).toString("hex")}`;
      // Use the contract algorithm independently, with IDs accepted by Registry.
      let agentId = "";
      for (let i = 1; i < 1000; i++) {
        const candidate = "agent_" + i.toString(16).padStart(32, "0");
        const digest = createHash("sha256")
          .update(JSON.stringify([organizationId, candidate]))
          .digest("hex");
        if (BigInt("0x" + digest) % 2n === 1n) {
          agentId = candidate;
          break;
        }
      }
      if (agentId === "") throw new Error("No deterministic B assignment");
      const token = (service: string) =>
        "Bearer " +
        readFileSync(
          join(security.ANTNEST_SERVICE_AUTH_TOKEN_DIR, service),
          "utf8",
        ).trim();
      const tracked = <T>(promise: Promise<T>): Promise<T> => {
        originals.push(promise);
        void promise.catch(() => undefined);
        return promise;
      };
      let created = false,
        businessPassed = false,
        modelRequests = 0;
      let authority: ReturnType<typeof runtimeAuthority> | undefined;
      let runtimeHandler: ReturnType<typeof createMcpHandler> | undefined;
      let candidatePackage: LearningCandidatePackage | undefined;
      let installedDigest: string | null = null;
      const maintenance: string[] = [];
      try {
        await pool.query(`CREATE SCHEMA ${schema}`);
        created = true;
        await migrate(pool);
        expect((await pool.query("SELECT * FROM agent_leases")).rows).toEqual(
          [],
        );
        while (ports.length < 8) {
          const port = await availablePort();
          if (!ports.includes(port)) ports.push(port);
        }
        const members = [0, 1].map((i) => ({
          member_id: i === 0 ? "acp-a" : "acp-b",
          origin: `http://127.0.0.1:${ports[i * 4 + 3]!}`,
        }));
        for (const member of members)
          registrationHistories.set(member.member_id, {
            id: randomUUID(),
            items: [],
          });
        const identity = await startPeer(async (request, response) => {
          expect(request.method).toBe("GET");
          expect(request.url).toBe("/rpc/identity/jwks");
          expect(request.headers["antnest-service-authorization"]).toBe(
            token("identity-service"),
          );
          expect((await readBody(request)).byteLength).toBe(0);
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(testJwks()));
        });
        peers.push(identity);
        const controller = await startPeer(async (request, response) => {
          expect(request.headers["antnest-service-authorization"]).toBe(
            token("runtime-controller"),
          );
          response.setHeader("cache-control", "no-store");
          if (request.url === "/internal/acp-incarnations/history") {
            expect(request.method).toBe("POST");
            const input = JSON.parse(
              (await readBody(request)).toString("utf8"),
            ) as { member_id: string; cursor: null };
            expect(Object.keys(input).sort()).toEqual(["cursor", "member_id"]);
            expect(input.cursor).toBeNull();
            const history = registrationHistories.get(input.member_id);
            if (history === undefined)
              throw new Error("History requested an unconfigured ACP member");
            historyRequests.push(input.member_id);
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                member_id: input.member_id,
                history_id: history.id,
                snapshot_revision: String(history.items.length),
                after_sequence: "0",
                items: history.items.map((registration, index) => ({
                  sequence: String(index + 1),
                  registration,
                })),
                next_cursor: null,
              }),
            );
            return;
          }
          if (
            request.method === "GET" &&
            request.url?.startsWith("/internal/acp-incarnations/")
          ) {
            expect((await readBody(request)).byteLength).toBe(0);
            const registrationId = request.url.slice(
              "/internal/acp-incarnations/".length,
            );
            inspectionRequests.push(registrationId);
            const registration = [...registrationHistories.values()]
              .flatMap((history) => history.items)
              .find((item) => item.registration_id === registrationId);
            const child = registeredChildren.get(registrationId);
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify(
                registration !== undefined && child?.isRunning()
                  ? {
                      state: "running",
                      ...registration,
                      observed_at: new Date().toISOString(),
                    }
                  : {
                      state: "unknown",
                      registration_id: registrationId,
                      reason:
                        registration === undefined
                          ? "unregistered"
                          : "platform_unavailable",
                    },
              ),
            );
            return;
          }
          expect(request.method).toBe("POST");
          expect(request.url).toBe("/internal/acp-incarnations/register");
          const payload = JSON.parse(
            (await readBody(request)).toString("utf8"),
          ) as Record<string, unknown>;
          const challenge = parseOwnerProbeRequest({
            ...payload,
            challenge: randomBytes(32).toString("hex"),
          });
          const index = members.findIndex(
            (member) => member.member_id === challenge.member_id,
          );
          expect(index).toBeGreaterThanOrEqual(0);
          const probe = await fetch(
            `http://127.0.0.1:${ports[index * 4 + 2]!}/internal/acp-owner/incarnation/probe`,
            {
              method: "POST",
              headers: {
                ...workloadHeaders("runtime-controller"),
                "content-type": "application/json",
              },
              body: JSON.stringify(challenge),
              signal: AbortSignal.timeout(5000),
            },
          );
          const observed: unknown = await probe.json();
          expect(probe.status).toBe(200);
          expect(observed).toEqual(challenge);
          expect(registrations.has(challenge.member_id)).toBe(false);
          const registration = Object.freeze({
            registration_id: randomUUID(),
            member_id: challenge.member_id,
            incarnation_id: challenge.incarnation_id,
          });
          const child = children[index];
          if (child === undefined)
            throw new Error("Registration has no original ACP child");
          registrationHistories
            .get(challenge.member_id)!
            .items.push(registration);
          registeredChildren.set(registration.registration_id, child);
          registrations.set(challenge.member_id, registration);
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(registration));
        });
        peers.push(controller);
        const model = await startPeer(async (request, response) => {
          await readBody(request);
          modelRequests++;
          response
            .writeHead(500, { "content-type": "application/json" })
            .end("{}");
          throw new Error("Skill source observation must not call a model");
        });
        peers.push(model);
        const registry = await startPeer(async (request, response) => {
          expect(request.method).toBe("PUT");
          expect(request.url).toBe("/internal/skill-projections");
          expect(request.headers["antnest-service-authorization"]).toBe(
            token("skill-registry"),
          );
          const value = JSON.parse(
            (await readBody(request)).toString("utf8"),
          ) as Record<string, unknown>;
          expect(value).toMatchObject({
            organization_id: organizationId,
            agent_id: agentId,
            owner_id: principalId,
          });
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              outcome: "applied",
              sequence: value.sequence,
            }),
          );
        });
        peers.push(registry);
        runtimeHandler = createMcpHandler(
          () => {
            const server = new McpServer({
              name: "dual-source-runtime",
              version: "1.0.0",
            });
            server.registerResource(
              "runtime-info",
              "antnest://runtime/info",
              { mimeType: "application/json" },
              (uri) => {
                if (authority === undefined)
                  throw new Error("Runtime authority is not ready");
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
                        execution_id: authority.binding.executionId,
                        instructions: null,
                        skills: [],
                      }),
                    },
                  ],
                };
              },
            );
            return server;
          },
          { legacy: "reject" },
        );
        const runtime = await startPeer(async (request, response) => {
          const original = authority;
          if (original === undefined || !original.admit(request, response))
            return;
          const body = await readBody(request);
          if (request.url?.startsWith("/internal/skill-maintenance/")) {
            expect(request.method).toBe("POST");
            expect(request.headers.cookie).toBeUndefined();
            expect(request.headers["antnest-caller-context"]).toBeUndefined();
            const authorization = request.headers.authorization;
            expect(authorization?.startsWith("AntnestMaintenance ")).toBe(true);
            const [header, payload, signature] = authorization!
              .slice("AntnestMaintenance ".length)
              .split(".");
            expect(typeof header).toBe("string");
            expect(typeof payload).toBe("string");
            expect(typeof signature).toBe("string");
            expect(
              JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
            ).toMatchObject({ kid: kids[1] });
            // A has the same projection and Runtime token, but a different key.
            // Only a request admitted by B may reach this observation endpoint.
            expect(
              verify(
                null,
                Buffer.from(
                  `antnest-skill-maintenance-v1\n${header}.${payload}`,
                ),
                keys[1]!.publicKey,
                Buffer.from(signature!, "base64url"),
              ),
            ).toBe(true);
            const ticket = JSON.parse(
              Buffer.from(payload!, "base64url").toString("utf8"),
            ) as Record<string, unknown>;
            expect(ticket).toMatchObject({
              organization_id: organizationId,
              agent_id: agentId,
              execution_id: original.binding.executionId,
              body_sha256:
                "sha256:" + createHash("sha256").update(body).digest("hex"),
            });
            expect(request.url).toBe(
              `/internal/skill-maintenance/${String(ticket.action)}`,
            );
            if (candidatePackage === undefined)
              throw new Error("Missing persisted candidate");
            if (ticket.action === "install") {
              expect(body.includes(candidatePackage.artifact)).toBe(true);
              expect(
                body.includes(Buffer.from(candidatePackage.targetDigest)),
              ).toBe(true);
              installedDigest = candidatePackage.targetDigest;
            } else {
              expect(ticket.action).toBe("digest");
              expect(JSON.parse(body.toString("utf8"))).toEqual({
                action: "digest",
                request_id: ticket.request_id,
                job_id: ticket.job_id,
                generation: ticket.generation,
                package_path: candidatePackage.packagePath,
              });
              expect(installedDigest).toBe(candidatePackage.targetDigest);
            }
            maintenance.push(String(ticket.action));
            response
              .writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
              })
              .end(
                JSON.stringify({
                  request_id: ticket.request_id,
                  action: ticket.action,
                  execution_id: original.binding.executionId,
                  outcome: ticket.action === "install" ? "applied" : "observed",
                  observed_digest: installedDigest,
                }),
              );
            return;
          }
          expect(request.url?.startsWith("/mcp")).toBe(true);
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
          const result = await runtimeHandler!.fetch(
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
        authority = runtimeAuthority(
          new URL(runtime.origin + "/mcp"),
          "dual-source-execution",
          { organizationId, agentId },
        );
        const configuration = executionConfiguration();
        configuration.organization_id = organizationId;
        configuration.agents[0]!.agent_id = agentId;
        configuration.agents[0]!.principal_ids = [principalId];
        configuration.agents[0]!.runtime = authority.runtime;
        configuration.providers[0]!.base_url = model.origin + "/v1";
        configuration.providers[0]!.credential.secret =
          randomBytes(32).toString("base64url");
        const cluster = randomUUID();
        const peerTokens = [
          randomBytes(32).toString("base64url"),
          randomBytes(32).toString("base64url"),
        ];
        for (const i of [0, 1]) {
          const directory = join(root, String(i));
          mkdirSync(directory);
          mkdirSync(join(directory, "tokens"));
          const temp = join(directory, "tmp");
          mkdirSync(temp);
          temporary.push(temp);
          writeFileSync(
            join(directory, "members.json"),
            JSON.stringify({ version: 1, cluster_id: cluster, members }),
          );
          writeFileSync(
            join(directory, "callers.json"),
            JSON.stringify({
              [members[1 - i]!.member_id]: [
                "sha256:" +
                  createHash("sha256")
                    .update(peerTokens[1 - i]!)
                    .digest("hex"),
              ],
            }),
            { mode: 0o600 },
          );
          writeFileSync(
            join(directory, "tokens", members[1 - i]!.member_id),
            peerTokens[i]!,
            { mode: 0o600 },
          );
          const childUrl = new URL(url);
          childUrl.searchParams.set("application_name", names[i]!);
          const environment: NodeJS.ProcessEnv = { ...process.env };
          for (const name of Object.keys(environment))
            if (name.startsWith("ANTNEST_") || name === "NODE_OPTIONS")
              delete environment[name];
          Object.assign(environment, security, {
            ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
              process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
            TMPDIR: temp,
            ANTNEST_ACP_DATABASE_URL: childUrl.toString(),
            ANTNEST_ACP_CLIENT_MCP_KEY: key.toString("base64"),
            ANTNEST_ACP_LISTEN: `127.0.0.1:${ports[i * 4]!}`,
            ANTNEST_ACP_CONTROL_LISTEN: `127.0.0.1:${ports[i * 4 + 1]!}`,
            ANTNEST_ACP_OWNER_MEMBER_ID: members[i]!.member_id,
            ANTNEST_ACP_OWNER_LISTEN: `127.0.0.1:${ports[i * 4 + 2]!}`,
            ANTNEST_ACP_RUNTIME_CONTROLLER_URL: controller.origin,
            ANTNEST_ACP_IDENTITY_URL: identity.origin,
            ANTNEST_ACP_PEER_LISTEN: `127.0.0.1:${ports[i * 4 + 3]!}`,
            ANTNEST_ACP_PEER_MEMBERSHIP_FILE: join(directory, "members.json"),
            ANTNEST_ACP_PEER_CALLERS_FILE: join(directory, "callers.json"),
            ANTNEST_ACP_PEER_TOKEN_DIRECTORY: join(directory, "tokens"),
            ANTNEST_ACP_SKILL_REGISTRY_URL: registry.origin,
            ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: kids[i]!,
            ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: keys[
              i
            ]!.privateKey.export({ type: "pkcs8", format: "der" }).toString(
              "base64",
            ),
            ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "true",
            ANTNEST_ACP_SHUTDOWN_TIMEOUT: "8s",
            OTEL_SDK_DISABLED: "true",
            OTEL_TRACES_EXPORTER: "none",
            OTEL_METRICS_EXPORTER: "none",
          });
          children.push(
            new ProductionAcpChild(
              environment,
              `http://127.0.0.1:${ports[i * 4]!}`,
            ),
          );
        }
        await Promise.all(children.map((child) => tracked(child.ready())));
        expect(registrations.size).toBe(2);
        expect(new Set(historyRequests)).toEqual(new Set(["acp-a", "acp-b"]));
        for (const registration of registrations.values())
          expect(inspectionRequests).toContain(registration.registration_id);
        expect((await pool.query("SELECT * FROM agent_leases")).rows).toEqual(
          [],
        );
        const published = await within(
          tracked(
            fetch(
              `http://127.0.0.1:${ports[1]!}/rpc/agent-acp/apply-execution-snapshot`,
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("agent-controller"),
                  "content-type": "application/json",
                  connection: "close",
                },
                body: JSON.stringify(configuration),
                signal: AbortSignal.timeout(15_000),
              },
            ).then(async (response) => ({
              status: response.status,
              body: (await response.json()) as unknown,
            })),
          ),
          "source publication ACK",
          15_000,
        );
        expect(published).toEqual({
          status: 200,
          body: { organization_id: organizationId, applied_revision: 1 },
        });
        const owner = registrations.get("acp-b");
        if (owner === undefined)
          throw new Error("Missing actual B registration");
        const leases = () =>
          pool.query(
            "SELECT owner_instance_id,epoch::text,expires_at>clock_timestamp() AS live FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
            [organizationId, agentId],
          );
        expect((await leases()).rows).toEqual([
          { owner_instance_id: owner.incarnation_id, epoch: "1", live: true },
        ]);

        // Build the same durable chain as the owned Learning fixtures. Neither
        // process receives a Prompt or model request to manufacture this source.
        const owned = {
          registration: owner,
          fence: {
            organizationId,
            agentId,
            ownerInstanceId: owner.incarnation_id,
            epoch: "1",
          },
        };
        const kernel = new PostgresKernel(pool);
        const repositories = createOwnedAgentRepositories(
          kernel,
          new SecretBox(key),
          owned,
        );
        const learning = createOwnedLearningRepositories(kernel, owned);
        const sessionId = randomUUID(),
          runId = randomUUID(),
          mcpRevisionId = randomUUID();
        await repositories.sessions.create({
          sessionId,
          mcpRevisionId,
          cwd: "/workspace",
          mcpSources: [],
          binding: {
            organizationId,
            principalId,
            agentId,
            connectionId: randomUUID(),
          },
        });
        await repositories.runs.createRunIntent({
          runId,
          requestId: randomUUID(),
          sessionId,
          expectedAccessRevision: "access-1",
          userMessageId: randomUUID(),
          prompt: [
            {
              type: "text",
              text: "Inspect the current source before changing it.",
            },
          ],
          createdAt: new Date(Date.now() - 120_000),
        });
        await repositories.runs.acceptRun({
          runId,
          snapshot: {
            ...snapshot(),
            organizationId,
            clientMcpRevisionId: mcpRevisionId,
            runtime: authority.binding,
            deadlineAt: new Date(Date.now() + 60_000),
          },
          environmentFact: null,
          acceptedAt: new Date(Date.now() - 90_000),
        });
        await repositories.executions.finish({
          runId,
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
          finishedAt: new Date(Date.now() - 60_000),
        });
        const policy = learningPolicySchema.parse({
          organization_id: organizationId,
          agent_id: agentId,
          owner_principal_id: principalId,
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
        const scanScope = { organizationId, agentId, ownerId: principalId };
        await learning.scan.activate(
          scanScope,
          policy.revision,
          policy.activation_cut_at,
        );
        const pending = await learning.scan.enqueue(scanScope, runId, policy);
        expect(pending).not.toBeNull();
        const claim = await learning.scan.claimNext(policy, pending!.taskId);
        expect(claim).not.toBeNull();
        if (claim === null)
          throw new Error("Missing owned source Learning claim");
        const modelRequestId = randomUUID();
        await learning.budget.reserve(claim, policy, modelRequestId, {
          inputTokens: 100,
          outputTokens: 100,
          durationMs: 1000,
        });
        const evidence = await learning.evidence.readAndRecord(claim);
        const authenticated = evidence.items.find(
          (item) => item.kind === "authenticated_user",
        );
        if (authenticated === undefined)
          throw new Error("Missing authenticated source evidence");
        const proposal = {
          decision: "propose" as const,
          name: "inspect-first",
          description: "Inspect first.",
          instructions: "unused",
          rules: [
            {
              text: authenticated.text,
              evidenceIds: [authenticated.evidenceId],
            },
          ],
        };
        candidatePackage = buildLearningCandidatePackage(proposal, evidence);
        await learning.budget.settleReview(
          claim,
          modelRequestId,
          { inputTokens: 10, outputTokens: 10, durationMs: 100 },
          proposal,
        );
        const candidateId = "candidate-dual-source";
        await learning.candidates.record({
          claim,
          candidateId,
          package: candidatePackage,
          expectedBaseDigest: null,
        });
        await learning.bases.recordAdmitted(claim, candidateId, {
          kind: "policy",
          policyRevision: policy.revision,
          packagePath: candidatePackage.packagePath,
          expectedBaseDigest: null,
          targetDigest: candidatePackage.targetDigest,
          evidenceIds: candidatePackage.evidenceIds,
          executionId: authority.binding.executionId,
        });
        const installRequestId = learningApplyRequestId(
          claim,
          candidateId,
          "install",
          1,
        );
        const installed = await tracked(
          new RuntimeSkillMaintenanceClient(
            new RuntimeSkillMaintenanceSigner(kids[1]!, keys[1]!.privateKey),
            learning.intents,
            authority.connections,
          ).install({
            claim,
            binding: authority.binding,
            candidateId,
            requestId: installRequestId,
            package: candidatePackage,
            expectedBaseDigest: null,
            signal: AbortSignal.timeout(5000),
          }),
        );
        expect(installed).toMatchObject({
          outcome: "applied",
          observed_digest: candidatePackage.targetDigest,
        });
        const change = await learning.changes.recordApplied({
          claim,
          candidateId,
          installRequestId,
        });
        expect(change).toMatchObject({
          sequence: 1,
          kind: "applied",
          afterDigest: candidatePackage.targetDigest,
        });
        expect(
          (
            await pool.query(
              "SELECT state,receipt->>'outcome' AS outcome FROM learning_maintenance_intents WHERE request_id=$1",
              [installRequestId],
            )
          ).rows,
        ).toEqual([{ state: "settled", outcome: "applied" }]);
        expect(maintenance).toEqual(["install"]);
        const facts = async () =>
          (
            await pool.query<
              Record<string, unknown>
            >(`SELECT jsonb_build_object(
        'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM runs r),
        'models',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.task_id,m.call_index) FROM learning_model_calls m),
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM learning_tasks t),
        'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.request_id) FROM learning_maintenance_intents i),
        'changes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.change_id) FROM learning_changes c)
      ) AS value`)
          ).rows;
        const before = await facts();
        const projection = {
          organization_id: organizationId,
          agent_id: agentId,
          owner_id: principalId,
          name: proposal.name,
          description: proposal.description,
          sequence: 1,
          content_digest: candidatePackage.targetDigest,
          active: true,
        };
        const call = (route: "inspect" | "artifact", input: unknown) =>
          tracked(
            fetch(
              `http://127.0.0.1:${ports[0]!}/internal/skill-sources/${route}`,
              {
                method: "POST",
                headers: {
                  ...workloadHeaders("skill-registry"),
                  "content-type": "application/json",
                  connection: "close",
                },
                body: JSON.stringify(input),
                signal: AbortSignal.timeout(10_000),
              },
            ),
          );
        const inspected = await within(
          tracked(
            call("inspect", {
              organization_id: organizationId,
              actor_id: principalId,
              sources: [{ agent_id: agentId, name: proposal.name }],
            }).then(async (response) => ({
              status: response.status,
              body: (await response.json()) as unknown,
            })),
          ),
          "single-entry source inspect",
          10_000,
        );
        expect(inspected).toEqual({
          status: 200,
          body: { items: [projection] },
        });
        const artifact = await within(
          tracked(
            call("artifact", {
              organization_id: organizationId,
              actor_id: principalId,
              skill_ref: {
                kind: "agent",
                agent_id: agentId,
                name: proposal.name,
                sequence: 1,
              },
              expected_digest: candidatePackage.targetDigest,
            }).then(async (response) => ({
              status: response.status,
              headers: response.headers,
              bytes: Buffer.from(await response.arrayBuffer()),
            })),
          ),
          "single-entry source artifact",
          10_000,
        );
        expect(artifact.status).toBe(200);
        expect(artifact.headers.get("content-type")).toBe("application/zip");
        expect(artifact.headers.get("content-length")).toBe(
          String(candidatePackage.artifact.length),
        );
        expect(artifact.headers.get("etag")).toBe(
          `"${candidatePackage.artifactDigest}"`,
        );
        expect(artifact.headers.get("x-antnest-artifact-digest")).toBe(
          candidatePackage.artifactDigest,
        );
        expect(artifact.headers.get("x-antnest-content-digest")).toBe(
          candidatePackage.targetDigest,
        );
        expect(artifact.headers.get("x-antnest-source-sequence")).toBe("1");
        expect(artifact.bytes).toEqual(candidatePackage.artifact);
        expect(maintenance).toEqual(["install", "digest", "digest"]);
        expect(modelRequests).toBe(0);
        expect(await facts()).toEqual(before);
        expect((await leases()).rows).toEqual([
          { owner_instance_id: owner.incarnation_id, epoch: "1", live: true },
        ]);
        businessPassed = true;
      } catch (error) {
        errors.push(error);
      } finally {
        const collect = async (operations: Promise<unknown>[]) => {
          for (const result of await Promise.allSettled(operations))
            if (result.status === "rejected")
              errors.push(result.reason as unknown);
        };
        await collect(children.map((child) => child.stop()));
        await Promise.allSettled(originals);
        if (authority !== undefined) {
          await collect([authority.connections.close()]);
          if (existsSync(authority.connections.directory))
            errors.push(new Error("Original Runtime sender directory remains"));
        }
        try {
          expect(
            (
              await pool.query(
                "SELECT pid FROM pg_stat_activity WHERE application_name=ANY($1::text[])",
                [names],
              )
            ).rows,
          ).toEqual([]);
          if (businessPassed)
            expect(
              (
                await pool.query(
                  "SELECT count(*)::int AS count FROM agent_leases WHERE expires_at>clock_timestamp()",
                )
              ).rows,
            ).toEqual([{ count: 0 }]);
          const exclusive = await PostgresWorkerLock.acquire(pool);
          await exclusive.release();
          for (const port of ports) await refused(port);
          for (const directory of temporary)
            expect(
              readdirSync(directory).filter((name) =>
                name.startsWith("antnest-acp-runtime-"),
              ),
            ).toEqual([]);
        } catch (error) {
          errors.push(error);
        }
        await collect([
          ...(runtimeHandler === undefined ? [] : [runtimeHandler.close()]),
          ...peers.map((peer) => peer.close()),
        ]);
        if (created) {
          try {
            await pool.query(`DROP SCHEMA ${schema} CASCADE`);
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await pool.end();
        } catch (error) {
          errors.push(error);
        }
        rmSync(root, { recursive: true, force: true });
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(
          errors,
          "Dual-process Skill source acceptance failed",
        );
    }, 120_000);
  },
);
