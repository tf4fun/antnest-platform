import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { startAgentAcpService, type RunningAgentAcpService } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import * as migrations from "../src/adapters/postgres/migrate.js";
import { PostgresPeerMembership } from "../src/adapters/postgres/peer-membership.js";
import { PostgresWorkerLock } from "../src/adapters/postgres/worker-lock.js";
import { PostgresAgentStartup } from "../src/adapters/postgres/agent-startup.js";
import { PostgresExecutionConfiguration } from "../src/adapters/postgres/execution-configuration.js";
import { RuntimeControllerIncarnations } from "../src/adapters/runtime-controller-incarnations.js";
import { PeerServer } from "../src/transport/peer-server.js";
import { OwnerProbeServer } from "../src/transport/owner-probe-server.js";
import { AgentAcpHttpServer } from "../src/transport/http-server.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import { testSecurityEnvironment, workloadHeaders } from "./support/auth-fixture.js";
import { executionConfiguration } from "./fixtures/execution-configuration.js";
import { PeerAcknowledgement } from "../src/application/peer-acknowledgement.js";
import type { ExecutionConfiguration } from "../src/domain/execution-configuration.js";

async function fixture(
  peer: boolean,
  action: (f: {
    start(): Promise<RunningAgentAcpService>;
    pin: MockInstance<PostgresPeerMembership["assertPinned"]>;
    peerListen: MockInstance<PeerServer["listen"]>;
    workspaceListen: MockInstance<AgentAcpHttpServer["listen"]>;
    workloadClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
    release: (() => void)[];
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "peer-bootstrap-"));
  const releases: (() => void)[] = [];
  const starts: Promise<RunningAgentAcpService>[] = [];
  let service: RunningAgentAcpService | undefined;
  const config = loadConfig({
    ...testSecurityEnvironment(),
    ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
    ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
    ANTNEST_ACP_OWNER_MEMBER_ID: "acp-a",
    ANTNEST_ACP_OWNER_LISTEN: "127.0.0.1:8085",
    ANTNEST_ACP_RUNTIME_CONTROLLER_URL: "http://runtime-controller:8080",
  });
  config.listen = { host: "127.0.0.1", port: 0 };
  config.controlListen = { host: "127.0.0.1", port: 0 };
  config.ownerIncarnation!.listen = { host: "127.0.0.1", port: 0 };
  const rawWorkloadClose = config.authentication.workload.close.bind(
    config.authentication.workload,
  );
  let workloadClosing: Promise<void> | undefined;
  const actualWorkloadClose = () => (workloadClosing ??= rawWorkloadClose());
  const workloadClose = vi.fn(actualWorkloadClose);
  vi.spyOn(config.authentication.workload, "close").mockImplementation(workloadClose);
  const peerListen = vi.spyOn(PeerServer.prototype, "listen");
  const probeListen = vi.spyOn(OwnerProbeServer.prototype, "listen");
  const workspaceListen = vi.spyOn(AgentAcpHttpServer.prototype, "listen");
  const pin = vi.spyOn(PostgresPeerMembership.prototype, "assertPinned").mockResolvedValue();
  vi.spyOn(migrations, "migrate").mockResolvedValue();
  const poolQueries = Pool.prototype as unknown as { query(sql: string): Promise<unknown> };
  vi.spyOn(poolQueries, "query").mockImplementation((sql) =>
    sql === "SELECT 1"
      ? Promise.resolve({ rows: [{ ready: 1 }], rowCount: 1 })
      : Promise.reject(new Error("Unexpected startup fixture query")),
  );
  vi.spyOn(PostgresAgentStartup.prototype, "inspect").mockResolvedValue([]);
  vi.spyOn(PostgresExecutionConfiguration.prototype, "listOrganizations").mockResolvedValue([]);
  vi.spyOn(RuntimeControllerIncarnations.prototype, "register").mockImplementation((request) =>
    Promise.resolve({
      registration_id: randomUUID(),
      member_id: request.member_id,
      incarnation_id: request.incarnation_id,
    }),
  );
  const loss = Promise.withResolvers<Error>();
  vi.spyOn(PostgresWorkerLock, "acquire").mockResolvedValue({
    isHeld: () => true,
    waitForLoss: () => loss.promise,
    release: () => Promise.resolve(),
  } as unknown as PostgresWorkerLock);
  if (peer) {
    mkdirSync(join(directory, "tokens"));
    writeFileSync(
      join(directory, "members.json"),
      JSON.stringify({
        version: 1,
        cluster_id: randomUUID(),
        members: [{ member_id: "acp-a", origin: "http://127.0.0.1:8086" }],
      }),
    );
    writeFileSync(join(directory, "callers.json"), "{}", { mode: 0o600 });
    config.peer = {
      listen: { host: "127.0.0.1", port: 0 },
      membershipFile: join(directory, "members.json"),
      callersFile: join(directory, "callers.json"),
      tokenDirectory: join(directory, "tokens"),
    };
  }
  const failures: unknown[] = [];
  try {
    await action({
      start: () => {
        const original = startAgentAcpService(config, NOOP_TELEMETRY, () => {
          throw new Error("Unexpected ownership loss");
        }).then((running) => {
          service = running;
          return running;
        });
        starts.push(original);
        void original.catch(() => undefined);
        return original;
      },
      pin,
      peerListen,
      workspaceListen,
      workloadClose,
      release: releases,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(starts);
    const stopped = await Promise.allSettled([service?.shutdown()]);
    for (const result of stopped)
      if (result.status === "rejected") failures.push(result.reason as unknown);
    try {
      await actualWorkloadClose();
      for (const listener of peerListen.mock.contexts) {
        expect(listener).toBeInstanceOf(PeerServer);
        if (listener instanceof PeerServer) expect(listener.address()).toBeNull();
      }
      for (const listener of probeListen.mock.contexts) {
        expect(listener).toBeInstanceOf(OwnerProbeServer);
        if (listener instanceof OwnerProbeServer) expect(listener.address()).toBeNull();
      }
      for (const listener of workspaceListen.mock.contexts) {
        expect(listener).toBeInstanceOf(AgentAcpHttpServer);
        if (listener instanceof AgentAcpHttpServer) expect(listener.address()).toBeNull();
      }
    } catch (error) {
      failures.push(error);
    } finally {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Peer startup fixture failed");
}

describe("production peer bootstrap", () => {
  it("aggregates a real control publication through the configured local peer before final SQL confirmation", async () => {
    await fixture(true, async (f) => {
      let stored: ExecutionConfiguration | null = null;
      vi.spyOn(PostgresExecutionConfiguration.prototype, "load").mockResolvedValue(null);
      vi.spyOn(PostgresExecutionConfiguration.prototype, "save").mockImplementation((next) => {
        stored = structuredClone(next);
        return Promise.resolve(true);
      });
      vi.spyOn(PostgresExecutionConfiguration.prototype, "loadAuthority").mockImplementation(() =>
        Promise.resolve(structuredClone(stored)),
      );
      const finalConfirmation = vi
        .spyOn(PostgresExecutionConfiguration.prototype, "confirmOwnedAuthority")
        .mockResolvedValue();
      const aggregate = vi.spyOn(PeerAcknowledgement.prototype, "confirm");
      const service = await f.start();
      const address = service.controlAddress();
      if (address === null || typeof address === "string") throw new Error("No control listener");
      const configuration = executionConfiguration();
      configuration.agents = [];
      const response = await fetch(
        `http://127.0.0.1:${address.port}/rpc/agent-acp/apply-execution-snapshot`,
        {
          method: "POST",
          headers: {
            ...workloadHeaders("agent-controller"),
            "content-type": "application/json",
            connection: "close",
          },
          body: JSON.stringify(configuration),
          signal: AbortSignal.timeout(3000),
        },
      );
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ applied_revision: 1 });
      expect(aggregate).toHaveBeenCalledOnce();
      expect(finalConfirmation).toHaveBeenCalledOnce();
      expect(finalConfirmation.mock.calls[0]?.[0]).toEqual(configuration);
      expect(finalConfirmation.mock.calls[0]?.[1]).toEqual([]);
    });
  });

  it.each([false, true])(
    "checks immutable membership before any ordinary/peer listener (peer=%s)",
    async (enabled) => {
      await fixture(enabled, async (f) => {
        const conflict = new Error("acp_peer_membership_conflict");
        f.pin.mockRejectedValue(conflict);
        let running: RunningAgentAcpService | undefined;
        const result = await f.start().then(
          (service) => {
            running = service;
            return undefined;
          },
          (error: unknown) => error,
        );
        try {
          expect(result).toBe(conflict);
          expect(f.pin).toHaveBeenCalledOnce();
          if (!enabled) expect(f.pin).toHaveBeenCalledWith(undefined);
          else
            expect(f.pin.mock.calls[0]?.[0]?.members).toEqual([
              { member_id: "acp-a", origin: "http://127.0.0.1:8086" },
            ]);
          expect(f.peerListen).not.toHaveBeenCalled();
          expect(f.workspaceListen).not.toHaveBeenCalled();
          expect(f.workloadClose).toHaveBeenCalledOnce();
        } finally {
          await running?.shutdown();
        }
      });
    },
  );

  it.each(["shutdown", "startup failure"] as const)(
    "joins the original peer close before shared resources on %s",
    async (mode) => {
      await fixture(true, async (f) => {
        const release = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        f.release.push(() => release.resolve());
        // Invoked with the original server as receiver below.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const closeActual = PeerServer.prototype.close;
        vi.spyOn(PeerServer.prototype, "close").mockImplementation(async function (
          this: PeerServer,
        ) {
          await closeActual.call(this);
          entered.resolve();
          await release.promise;
        });
        const failure = new Error("Workspace bind failed");
        if (mode === "startup failure") f.workspaceListen.mockRejectedValue(failure);
        const original = mode === "shutdown" ? (await f.start()).shutdown() : f.start();
        void original.catch(() => undefined);
        try {
          await Promise.race([
            entered.promise,
            original.then(
              () => {
                throw new Error("Peer close was bypassed");
              },
              (error: unknown) => {
                throw error;
              },
            ),
          ]);
          expect(f.peerListen).toHaveBeenCalledOnce();
          expect(f.workloadClose).not.toHaveBeenCalled();
          release.resolve();
          if (mode === "shutdown") await original;
          else await expect(original).rejects.toBe(failure);
          expect(f.workloadClose).toHaveBeenCalledOnce();
        } finally {
          release.resolve();
          await Promise.allSettled([original]);
        }
      });
    },
  );
});
