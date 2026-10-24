import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { buildComponents } from "../../../../services/agent-acp-service/src/composition.js";
import {
  loadConfig,
  type AgentAcpConfig,
} from "../../../../services/agent-acp-service/src/config.js";
import { PeerAuthentication } from "../../../../services/agent-acp-service/src/adapters/peer-authentication.js";
import { PeerServer } from "../../../../services/agent-acp-service/src/transport/peer-server.js";
import { PostgresExecutionConfiguration } from "../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { PostgresAgentLeases } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { PostgresPeerMembership } from "../../../../services/agent-acp-service/src/adapters/postgres/peer-membership.js";
import { PostgresPeerParticipation } from "../../../../services/agent-acp-service/src/adapters/postgres/peer-participation.js";
import { PeerAvailability } from "../../../../services/agent-acp-service/src/application/peer-availability.js";
import { PostgresWorkerLock } from "../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import type { SessionOutputSnapshot } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
  closedExecutionAgent,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { runtimeConnections } from "../../../../services/agent-acp-service/test/support/runtime-connections.js";
import {
  withDatabase,
  registration,
  type FencingFixture,
} from "../support/run-fencing-fixture.js";

async function port(): Promise<number> {
  const reservation = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === "string")
      throw new Error("No reserved TCP address");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
type Components = ReturnType<typeof buildComponents>;
async function withPeers(
  allOnA: boolean,
  action: (f: {
    a: Components;
    b: Components;
    configuration: ReturnType<typeof executionConfiguration>;
    release: (() => void)[];
    db: FencingFixture;
    owners: ReturnType<typeof registration>[];
    availabilities: PeerAvailability[];
  }) => Promise<void>,
  availabilityEnabled = false,
) {
  await withDatabase(async (db) => {
    const directory = mkdtempSync(join(tmpdir(), "peer-composition-"));
    const configs: AgentAcpConfig[] = [],
      servers: PeerServer[] = [],
      components: Components[] = [];
    const availabilities: PeerAvailability[] = [];
    const connections: ReturnType<typeof runtimeConnections>[] = [],
      release: (() => void)[] = [];
    const lifetime = new AbortController();
    const failures: unknown[] = [];
    const configuration = executionConfiguration();
    configuration.agents.push({
      ...structuredClone(configuration.agents[0]!),
      agent_id: allOnA ? "agent-2" : "agent-3",
      runtime: runtimeConfiguration(2),
    });
    try {
      const ports = [await port(), await port()];
      expect(ports[0]).not.toBe(ports[1]);
      const members = ports.map((value, i) => ({
        member_id: i === 0 ? "acp-a" : "acp-b",
        origin: `http://127.0.0.1:${value}`,
      }));
      const cluster = randomUUID(),
        key = randomBytes(32),
        tokens = [
          randomBytes(32).toString("base64url"),
          randomBytes(32).toString("base64url"),
        ];
      const owners = [registration("acp-a"), registration("acp-b")];
      const registeredOwners: ReturnType<typeof registration>[] = [];
      const historyIds = new Map(
        members.map((member) => [member.member_id, randomUUID()]),
      );
      expect((await db.a.query("SELECT * FROM agent_leases")).rows).toEqual([]);
      for (const i of [0, 1]) {
        const current = join(directory, String(i));
        mkdirSync(current);
        mkdirSync(join(current, "tokens"));
        const peer = 1 - i;
        writeFileSync(
          join(current, "members.json"),
          JSON.stringify({ version: 1, cluster_id: cluster, members }),
        );
        writeFileSync(
          join(current, "callers.json"),
          JSON.stringify({
            [members[peer]!.member_id]: [
              `sha256:${createHash("sha256").update(tokens[peer]!).digest("hex")}`,
            ],
          }),
          { mode: 0o600 },
        );
        writeFileSync(
          join(current, "tokens", members[peer]!.member_id),
          tokens[i]!,
          { mode: 0o600 },
        );
        const config = loadConfig({
          ...testSecurityEnvironment(),
          ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
          ANTNEST_ACP_CLIENT_MCP_KEY: key.toString("base64"),
        });
        configs.push(config);
        const authentication = new PeerAuthentication({
          memberId: members[i]!.member_id,
          membershipFile: join(current, "members.json"),
          callersFile: join(current, "callers.json"),
          tokenDirectory: join(current, "tokens"),
          workload: config.authentication.workload,
        });
        await new PostgresPeerMembership(
          i === 0 ? db.kernelA : db.kernelB,
        ).assertPinned(authentication.membership);
        if (availabilityEnabled) {
          const ledger = new PostgresPeerParticipation(
            i === 0 ? db.kernelA : db.kernelB,
            authentication.membership.sha256,
          );
          await ledger.join(owners[i]!);
          registeredOwners.push(owners[i]!);
          const availability = new PeerAvailability({
            registration: owners[i]!,
            membershipSha256: authentication.membership.sha256,
            members: members.map((member) => member.member_id),
            ledger,
            registry: {
              history: (input, signal) => {
                signal.throwIfAborted();
                expect(input.cursor).toBeNull();
                const entries = registeredOwners.filter(
                  (owner) => owner.member_id === input.member_id,
                );
                return Promise.resolve({
                  member_id: input.member_id,
                  history_id: historyIds.get(input.member_id)!,
                  snapshot_revision: String(entries.length),
                  after_sequence: "0",
                  items: entries.map((owner, index) => ({
                    sequence: String(index + 1),
                    registration: owner,
                  })),
                  next_cursor: null,
                });
              },
              inspect: (original, signal) => {
                signal.throwIfAborted();
                expect(registeredOwners).toContainEqual(original);
                return Promise.resolve({
                  ...original,
                  state: "running",
                  observed_at: "2026-10-24T00:00:00.000Z",
                });
              },
            },
          });
          await availability.refresh(lifetime.signal, Date.now() + 5000);
          availabilities.push(availability);
        }
        const transport = runtimeConnections();
        connections.push(transport);
        const built = buildComponents(
          i === 0 ? db.a : db.b,
          config,
          NOOP_TELEMETRY,
          () => {
            throw new Error("Unexpected global failure");
          },
          lifetime.signal,
          transport,
          owners[i],
          undefined,
          undefined,
          authentication,
          availabilities[i],
        );
        components.push(built);
        const server = new PeerServer({
          registration: owners[i]!,
          authentication,
          apply: built.applyPeerPublication,
        });
        servers.push(server);
        await server.listen("127.0.0.1", ports[i]!);
      }
      await action({
        a: components[0]!,
        b: components[1]!,
        configuration,
        release,
        db,
        owners,
        availabilities,
      });
    } catch (error) {
      failures.push(error);
    } finally {
      for (const finish of release) finish();
      lifetime.abort(new Error("Peer composition fixture is closing"));
      for (const result of await Promise.allSettled([
        ...servers.map((server) => server.close()),
        ...components.flatMap((built) => [
          built.owned!.shutdown(),
          built.supervisor.shutdown(),
          built.outputs.revokeAccess({
            organization_id: configuration.organization_id,
            agents: [],
          }),
          built.joinRevocations(),
        ]),
      ]))
        if (result.status === "rejected")
          failures.push(result.reason as unknown);
      for (const result of await Promise.allSettled(
        connections.map((connection) => connection.close()),
      ))
        if (result.status === "rejected")
          failures.push(result.reason as unknown);
      for (const result of await Promise.allSettled(
        configs.map((config) => config.authentication.workload.close()),
      ))
        if (result.status === "rejected")
          failures.push(result.reason as unknown);
      try {
        for (const server of servers) expect(server.address()).toBeNull();
      } catch (error) {
        failures.push(error);
      } finally {
        vi.restoreAllMocks();
        rmSync(directory, { recursive: true, force: true });
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Peer composition fixture failed");
  });
}

describe.skipIf(process.env.ANTNEST_ACP_TEST_DATABASE_URL === undefined)(
  "production aggregate peer publication with real HTTP and PostgreSQL",
  () => {
    it("confirms the complete union from two owning compositions and never saves or aggregates at the peer leaf", async () => {
      await withPeers(false, async ({ a, b, configuration, db, owners }) => {
        const save = vi.spyOn(PostgresExecutionConfiguration.prototype, "save");
        const confirm = vi.spyOn(
          PostgresExecutionConfiguration.prototype,
          "confirmOwnedAuthority",
        );
        await expect(a.directory.apply(configuration)).resolves.toMatchObject({
          applied_revision: 1,
        });
        expect(save).toHaveBeenCalledOnce();
        expect(confirm).toHaveBeenCalledOnce();
        const fences = confirm.mock.calls[0]![1];
        expect(fences.map((fence) => fence.agentId).sort()).toEqual(
          configuration.agents.map((agent) => agent.agent_id).sort(),
        );
        expect(new Set(fences.map((fence) => fence.ownerInstanceId)).size).toBe(
          2,
        );
        expect(fences).toEqual(
          expect.arrayContaining([
            {
              organizationId: configuration.organization_id,
              agentId: "agent-1",
              ownerInstanceId: owners[0]!.incarnation_id,
              epoch: "1",
            },
            {
              organizationId: configuration.organization_id,
              agentId: "agent-3",
              ownerInstanceId: owners[1]!.incarnation_id,
              epoch: "1",
            },
          ]),
        );
        expect(
          (
            await db.observer.query(
              "SELECT agent_id, owner_instance_id, epoch::text FROM agent_leases ORDER BY agent_id",
            )
          ).rows,
        ).toEqual([
          {
            agent_id: "agent-1",
            owner_instance_id: owners[0]!.incarnation_id,
            epoch: "1",
          },
          {
            agent_id: "agent-3",
            owner_instance_id: owners[1]!.incarnation_id,
            epoch: "1",
          },
        ]);
        expect(
          b.directory.inspect(executionIdentity()).configuration.revision,
        ).toBe(1);
      });
    });

    it("refreshes stale participation before acquiring the first publication leases", async () => {
      await withPeers(
        false,
        async ({ a, b, configuration, db, owners, availabilities }) => {
          const first = availabilities[0]!.current();
          const second = availabilities[1]!.current();
          expect(first.guard.revision).toBe("1");
          expect(first.members).toEqual([
            {
              memberId: "acp-a",
              state: "running",
              registration: owners[0]!,
              stopped: [],
            },
            { memberId: "acp-b", state: "unregistered" },
          ]);
          expect(second.guard.revision).toBe("2");
          expect(second.live).toEqual(owners);
          expect((await db.a.query("SELECT * FROM agent_leases")).rows).toEqual(
            [],
          );
          const save = vi.spyOn(
            PostgresExecutionConfiguration.prototype,
            "save",
          );
          const confirm = vi.spyOn(
            PostgresExecutionConfiguration.prototype,
            "confirmOwnedAuthority",
          );
          await expect(a.directory.apply(configuration)).resolves.toMatchObject(
            {
              applied_revision: 1,
            },
          );
          expect(availabilities[0]!.current().guard).toEqual(second.guard);
          expect(availabilities[0]!.current().live).toEqual(owners);
          expect(save).toHaveBeenCalledOnce();
          expect(confirm).toHaveBeenCalledOnce();
          const fences = confirm.mock.calls[0]![1];
          expect(fences.map((fence) => fence.agentId).sort()).toEqual(
            configuration.agents.map((agent) => agent.agent_id).sort(),
          );
          expect(
            new Set(fences.map((fence) => fence.ownerInstanceId)).size,
          ).toBe(2);
          expect(fences).toEqual(
            expect.arrayContaining([
              {
                organizationId: configuration.organization_id,
                agentId: "agent-1",
                ownerInstanceId: owners[0]!.incarnation_id,
                epoch: "1",
              },
              {
                organizationId: configuration.organization_id,
                agentId: "agent-3",
                ownerInstanceId: owners[1]!.incarnation_id,
                epoch: "1",
              },
            ]),
          );
          expect(
            (
              await db.observer.query(
                "SELECT agent_id, owner_instance_id, epoch::text FROM agent_leases ORDER BY agent_id",
              )
            ).rows,
          ).toEqual([
            {
              agent_id: "agent-1",
              owner_instance_id: owners[0]!.incarnation_id,
              epoch: "1",
            },
            {
              agent_id: "agent-3",
              owner_instance_id: owners[1]!.incarnation_id,
              epoch: "1",
            },
          ]);
          expect(
            b.directory.inspect(executionIdentity()).configuration.revision,
          ).toBe(1);
        },
        true,
      );
    });

    it("starts local revocation before a held participation refresh and defers owned preparation", async () => {
      await withPeers(
        false,
        async ({ a, b, configuration, availabilities }) => {
          await expect(a.directory.apply(configuration)).resolves.toMatchObject(
            {
              applied_revision: 1,
            },
          );
          const revoke = vi.spyOn(a.outputs, "revokeAccess");
          const prepare = vi.spyOn(a.owned!, "prepare");
          const availability = availabilities[0]!;
          const originalRefresh = availability.refresh.bind(availability);
          const entered = Promise.withResolvers<void>();
          const held = Promise.withResolvers<void>();
          const refresh = vi
            .spyOn(availability, "refresh")
            .mockImplementationOnce(async (signal, deadline) => {
              entered.resolve();
              await held.promise;
              return originalRefresh(signal, deadline);
            });
          const changed = structuredClone(configuration);
          changed.revision = 2;
          changed.agents = [];
          const applied = a.directory.apply(changed);
          void applied.catch(() => undefined);
          try {
            await Promise.race([entered.promise, applied]);
            expect(refresh).toHaveBeenCalledOnce();
            expect(revoke).toHaveBeenCalledWith(
              expect.objectContaining({
                organization_id: changed.organization_id,
                revision: changed.revision,
                agents: [],
              }),
            );
            expect(prepare).not.toHaveBeenCalled();
            held.resolve();
            await expect(applied).resolves.toMatchObject({
              applied_revision: 2,
            });
            for (const built of [a, b])
              expect(
                built.directory.capturePublication(changed.organization_id)
                  .configuration,
              ).toMatchObject({ revision: 2, agents: [] });
          } finally {
            held.resolve();
            await Promise.allSettled([applied]);
          }
        },
        true,
      );
    });

    it("rejects one publication during original retirement and accepts one identical replay after cleanup", async () => {
      await withPeers(
        false,
        async ({ a, b, configuration, db, owners, release }) => {
          const model = vi.spyOn(OpenAICompatibleModel.prototype, "complete");
          await expect(a.directory.apply(configuration)).resolves.toMatchObject(
            {
              applied_revision: 1,
            },
          );
          const owned = a.owned!;
          const [originalFence] = await owned.localPublicationFences(
            a.directory.capturePublication(configuration.organization_id),
            new AbortController().signal,
          );
          if (originalFence === undefined)
            throw new Error("Missing original local Agent fence");
          expect(originalFence).toMatchObject({
            agentId: "agent-1",
            epoch: "1",
          });
          const businessFacts = async () => ({
            runs: (
              await db.observer.query<Record<string, unknown>>(
                "SELECT id,state FROM runs ORDER BY id",
              )
            ).rows,
            sessions: (
              await db.observer.query<Record<string, unknown>>(
                "SELECT id,state FROM acp_sessions ORDER BY id",
              )
            ).rows,
          });
          // This case has no Run: it proves publication/lease retirement and
          // zero new model execution, not replay recovery of an original Run.
          const businessBefore = await businessFacts();
          expect(businessBefore).toEqual({ runs: [], sessions: [] });
          const revised = structuredClone(configuration);
          revised.revision = 2;
          const sameSnapshot = structuredClone(revised);
          const entered = Promise.withResolvers<void>();
          const held = Promise.withResolvers<void>();
          release.push(() => held.resolve());
          const originalPrepare = owned.prepare.bind(owned);
          let preparationCompleted = false;
          vi.spyOn(owned, "prepare").mockImplementation(async (next) => {
            await originalPrepare(next);
            if (next.revision === revised.revision) preparationCompleted = true;
          });
          const originalFences = owned.localPublicationFences.bind(owned);
          let samplingLocalReceipt = false;
          vi.spyOn(owned, "localPublicationFences").mockImplementationOnce(
            (capture, signal) => {
              expect(preparationCompleted).toBe(true);
              samplingLocalReceipt = true;
              return originalFences(capture, signal);
            },
          );
          // Preserve the actual SQL and its returned authority. Only hold its
          // response to the original dispatch; no authority/fence is fabricated.
          const loadOwnedAuthority =
            // eslint-disable-next-line @typescript-eslint/unbound-method
            PostgresExecutionConfiguration.prototype.loadOwnedAuthority;
          let originalQuery: ReturnType<typeof loadOwnedAuthority> | undefined;
          let queryClaimed = false;
          vi.spyOn(
            PostgresExecutionConfiguration.prototype,
            "loadOwnedAuthority",
          ).mockImplementation(async function (
            this: PostgresExecutionConfiguration,
            fence,
          ) {
            if (
              samplingLocalReceipt &&
              !queryClaimed &&
              fence.organizationId === originalFence.organizationId &&
              fence.agentId === originalFence.agentId &&
              fence.ownerInstanceId === originalFence.ownerInstanceId &&
              fence.epoch === originalFence.epoch
            ) {
              queryClaimed = true;
              originalQuery = loadOwnedAuthority.call(this, fence);
              const authority = await originalQuery;
              expect(authority).toEqual(sameSnapshot);
              entered.resolve();
              await held.promise;
              return authority;
            }
            return loadOwnedAuthority.call(this, fence);
          });
          // eslint-disable-next-line @typescript-eslint/unbound-method
          const releaseLease = PostgresAgentLeases.prototype.release;
          const originalReleases: ReturnType<typeof releaseLease>[] = [];
          let releaseCompleted = false;
          vi.spyOn(PostgresAgentLeases.prototype, "release").mockImplementation(
            async function (this: PostgresAgentLeases, fence) {
              const original = releaseLease.call(this, fence);
              if (
                fence.organizationId === originalFence.organizationId &&
                fence.agentId === originalFence.agentId &&
                fence.ownerInstanceId === originalFence.ownerInstanceId &&
                fence.epoch === originalFence.epoch
              ) {
                originalReleases.push(original);
                const released = await original;
                expect(released).toBe(true);
                releaseCompleted = true;
                return released;
              }
              return original;
            },
          );
          const acquisitions = vi.spyOn(
            PostgresAgentLeases.prototype,
            "tryAcquire",
          );
          const confirm = vi.spyOn(
            PostgresExecutionConfiguration.prototype,
            "confirmOwnedAuthority",
          );
          let firstCompleted = false;
          const first = a.directory.apply(revised).finally(() => {
            firstCompleted = true;
          });
          const firstJoined = first.catch(() => undefined);
          let replay: ReturnType<typeof a.directory.apply> | undefined;
          try {
            await Promise.race([
              entered.promise,
              first.then(() => {
                throw new Error(
                  "Original owned authority query gate was bypassed",
                );
              }),
            ]);
            expect(preparationCompleted).toBe(true);
            expect(queryClaimed).toBe(true);
            owned.withdraw(configuration.organization_id);
            await Promise.resolve();
            expect(firstCompleted).toBe(false);
            expect(releaseCompleted).toBe(false);
            expect(acquisitions).not.toHaveBeenCalled();
            held.resolve();
            await expect(first).rejects.toMatchObject({
              code: "configuration_unavailable",
            });
            expect(releaseCompleted).toBe(true);
            expect(originalReleases).toHaveLength(1);
            expect(confirm).not.toHaveBeenCalled();
            expect(await businessFacts()).toEqual(businessBefore);
            expect(model).not.toHaveBeenCalled();
            expect(revised).toEqual(sameSnapshot);

            // One explicit replay after the original retirement has joined;
            // keep exactly the same revision and private publication payload.
            replay = a.directory.apply(revised);
            await expect(replay).resolves.toMatchObject({
              applied_revision: 2,
            });
            expect(revised).toEqual(sameSnapshot);
            expect(acquisitions).toHaveBeenCalledOnce();
            expect(confirm).toHaveBeenCalledOnce();
            expect(confirm.mock.calls[0]![0]).toEqual(sameSnapshot);
            expect(confirm.mock.calls[0]![1]).toEqual(
              expect.arrayContaining([
                { ...originalFence, epoch: "2" },
                {
                  organizationId: configuration.organization_id,
                  agentId: "agent-3",
                  ownerInstanceId: owners[1]!.incarnation_id,
                  epoch: "1",
                },
              ]),
            );
            expect(confirm.mock.calls[0]![1]).toHaveLength(2);
            expect(
              (
                await db.observer.query<{
                  agent_id: string;
                  owner_instance_id: string;
                  epoch: string;
                }>(
                  "SELECT agent_id,owner_instance_id,epoch::text FROM agent_leases ORDER BY agent_id",
                )
              ).rows,
            ).toEqual([
              {
                agent_id: "agent-1",
                owner_instance_id: owners[0]!.incarnation_id,
                epoch: "2",
              },
              {
                agent_id: "agent-3",
                owner_instance_id: owners[1]!.incarnation_id,
                epoch: "1",
              },
            ]);
            for (const built of [a, b])
              expect(
                built.directory.capturePublication(
                  configuration.organization_id,
                ).authority,
              ).toEqual(sameSnapshot);
            expect(await businessFacts()).toEqual(businessBefore);
            expect(model).not.toHaveBeenCalled();
          } finally {
            held.resolve();
            await Promise.allSettled([firstJoined, replay, originalQuery]);
            await Promise.allSettled(originalReleases);
          }
        },
        true,
      );
    });

    it.each(["admitting", "running"] as const)(
      "protects unknown legacy %s work without withholding the healthy peer's Agent",
      async (state) => {
        await withPeers(false, async ({ a, b, configuration, db }) => {
          const session = await db.session({
            organizationId: configuration.organization_id,
            agentId: "agent-1",
          });
          const input = db.input(session);
          const runs = db.legacy();
          await runs.createRunIntent(input);
          if (state === "running")
            await runs.acceptRun(db.acceptance(session, input.runId));
          const before = await db.snapshot();
          await expect(a.directory.apply(configuration)).rejects.toMatchObject({
            code: "configuration_unavailable",
          });
          expect(await db.snapshot()).toBe(before);
          expect(Object.values(await db.origin(input.runId))).toEqual([
            null,
            null,
            null,
            null,
          ]);
          await expect(
            a.application.createSession({
              binding: { ...executionIdentity(), connectionId: randomUUID() },
              cwd: "/workspace",
              additionalDirectories: [],
              mcpServers: [],
            }),
          ).rejects.toMatchObject({ code: "agent_unavailable" });
          await expect(
            b.application.createSession({
              binding: {
                ...executionIdentity(),
                connectionId: randomUUID(),
                agentId: "agent-3",
              },
              cwd: "/workspace",
              additionalDirectories: [],
              mcpServers: [],
            }),
          ).resolves.toMatchObject({
            sessionId: expect.any(String) as unknown,
          });
        });
      },
    );

    it("preserves inventory-only legacy execution during shared startup", async () => {
      await withPeers(false, async ({ a, b, configuration, db }) => {
        const session = await db.session({
          organizationId: configuration.organization_id,
          agentId: "inventory-agent",
        });
        const input = db.input(session);
        const runs = db.legacy();
        await runs.createRunIntent(input);
        await runs.acceptRun(db.acceptance(session, input.runId));
        const before = await db.snapshot();
        const worker = await PostgresWorkerLock.acquire(db.a, {
          mode: "shared",
        });
        try {
          await a.owned!.recoverStartup(worker);
          await b.owned!.recoverStartup(worker);
          expect(await db.snapshot()).toBe(before);
          expect(Object.values(await db.origin(input.runId))).toEqual([
            null,
            null,
            null,
            null,
          ]);
        } finally {
          await worker.release();
        }
      });
    });

    it("does not acquire another member's released Agent through lifecycle settlement", async () => {
      await withPeers(true, async ({ a, b, configuration, db }) => {
        configuration.agents = configuration.agents.map((agent) => ({
          ...closedExecutionAgent(agent),
          operation_id: "operation-1",
        }));
        await a.directory.apply(configuration);
        await a.owned!.shutdown();
        const before = (
          await db.observer.query(
            "SELECT * FROM agent_leases ORDER BY agent_id",
          )
        ).rows;
        await expect(
          b.settlement.settle({
            organization_id: configuration.organization_id,
            agent_id: "agent-1",
            operation_id: "operation-1",
            minimum_revision: 1,
            mode: "wait",
            deadline_at: new Date(Date.now() + 5000).toISOString(),
          }),
        ).resolves.toEqual({ applied_revision: 1, outcome: "not_settled" });
        expect(
          (
            await db.observer.query(
              "SELECT * FROM agent_leases ORDER BY agent_id",
            )
          ).rows,
        ).toEqual(before);
      });
    });

    it("waits for the non-owner peer's original revoked output while healthy Agent admission continues", async () => {
      await withPeers(true, async ({ a, b, configuration, release }) => {
        await a.directory.apply(configuration);
        const read = Promise.withResolvers<SessionOutputSnapshot>(),
          entered = Promise.withResolvers<void>();
        const stop = new AbortController();
        const finish = () => {
          read.resolve({
            sequence: 0,
            events: [],
            state: { kind: "state", state: "idle" },
          });
          stop.abort();
        };
        release.push(finish);
        const attaching = b.outputs.attach({
          identity: executionIdentity(),
          key: "old",
          connectionId: "old",
          read: () => {
            entered.resolve();
            return read.promise;
          },
          send: () => Promise.resolve(),
          signal: stop.signal,
          onFailure: () => undefined,
        });
        await entered.promise;
        const revoked = structuredClone(configuration);
        revoked.revision = 2;
        revoked.agents[0]!.principal_ids = [];
        let completed = false;
        const applied = a.directory.apply(revoked).then((result) => {
          completed = true;
          return result;
        });
        void applied.catch(() => undefined);
        try {
          await attaching;
          await expect(
            a.directory.withAccess(
              { ...executionIdentity(), agentId: "agent-2" },
              () => Promise.resolve("healthy"),
            ),
          ).resolves.toBe("healthy");
          await delay(50);
          expect(completed).toBe(false);
          finish();
          await expect(applied).resolves.toMatchObject({ applied_revision: 2 });
        } finally {
          finish();
          await Promise.allSettled([attaching, applied]);
        }
      });
    });
  },
);
