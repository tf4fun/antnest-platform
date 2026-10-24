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
import { PostgresPeerMembership } from "../../../../services/agent-acp-service/src/adapters/postgres/peer-membership.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import type { SessionOutputSnapshot } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { runtimeConnections } from "../../../../services/agent-acp-service/test/support/runtime-connections.js";
import { withDatabase, registration } from "../support/run-fencing-fixture.js";

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
  }) => Promise<void>,
) {
  await withDatabase(async (db) => {
    const directory = mkdtempSync(join(tmpdir(), "peer-composition-"));
    const configs: AgentAcpConfig[] = [],
      servers: PeerServer[] = [],
      components: Components[] = [];
    const connections: ReturnType<typeof runtimeConnections>[] = [],
      release: (() => void)[] = [];
    const lifetime = new AbortController();
    const failures: unknown[] = [];
    const configuration = executionConfiguration();
    configuration.agents.push({
      ...structuredClone(configuration.agents[0]!),
      agent_id: "agent-2",
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
      await db.owner(
        { organizationId: configuration.organization_id, agentId: "agent-1" },
        owners[0],
        "a",
      );
      await db.owner(
        { organizationId: configuration.organization_id, agentId: "agent-2" },
        owners[allOnA ? 0 : 1],
        allOnA ? "a" : "b",
      );
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
      await withPeers(false, async ({ a, b, configuration }) => {
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
        expect(fences.map((fence) => fence.agentId).sort()).toEqual([
          "agent-1",
          "agent-2",
        ]);
        expect(new Set(fences.map((fence) => fence.ownerInstanceId)).size).toBe(
          2,
        );
        expect(
          b.directory.inspect(executionIdentity()).configuration.revision,
        ).toBe(1);
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
