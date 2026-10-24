import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { buildComponents } from "../src/composition.js";
import { loadConfig, type AgentAcpConfig } from "../src/config.js";
import { PeerAuthentication } from "../src/adapters/peer-authentication.js";
import { PostgresAgentLeases } from "../src/adapters/postgres/agent-leases.js";
import { PostgresAgentStartup } from "../src/adapters/postgres/agent-startup.js";
import { PostgresExecutionConfiguration } from "../src/adapters/postgres/execution-configuration.js";
import { PostgresOwnerRecovery } from "../src/adapters/postgres/owner-recovery.js";
import { AgentAssignment } from "../src/application/agent-assignment.js";
import { AgentGenerations, type AgentGeneration } from "../src/application/agent-generations.js";
import { publicExecutionConfiguration } from "../src/domain/execution-configuration.js";
import { executionPublication } from "../src/domain/execution-publication.js";
import type { AcpApplicationPort } from "../src/ports/acp-application.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import { executionConfiguration } from "./fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { runtimeConnections } from "./support/runtime-connections.js";

it("keeps an original valid generation and lease when a rejoined member changes assignment during held work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-membership-rejoin-"));
  const pool = new Pool();
  const connect = vi.spyOn(pool, "connect").mockImplementation(() => {
    throw new Error("Unexpected database connection in membership rejoin fixture");
  });
  const query = vi.spyOn(pool, "query").mockImplementation(() => {
    throw new Error("Unexpected database query in membership rejoin fixture");
  });
  const connections = runtimeConnections();
  const work = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let config: AgentAcpConfig | undefined;
  let components: ReturnType<typeof buildComponents> | undefined;
  let dispatched: Promise<string> | undefined;
  try {
    const configuration = executionConfiguration();
    const next = publicExecutionConfiguration(configuration);
    const owner = {
      registration_id: randomUUID(),
      member_id: "acp-a",
      incarnation_id: randomUUID(),
    };
    vi.spyOn(PostgresExecutionConfiguration.prototype, "load").mockResolvedValue(next);
    vi.spyOn(PostgresExecutionConfiguration.prototype, "loadAuthority").mockResolvedValue(
      configuration,
    );
    vi.spyOn(PostgresExecutionConfiguration.prototype, "loadOwnedAuthority").mockResolvedValue(
      configuration,
    );
    vi.spyOn(PostgresExecutionConfiguration.prototype, "confirmOwnedAuthority").mockResolvedValue();
    vi.spyOn(PostgresExecutionConfiguration.prototype, "save").mockResolvedValue(true);
    vi.spyOn(PostgresOwnerRecovery.prototype, "listPredecessors").mockResolvedValue([]);
    vi.spyOn(PostgresOwnerRecovery.prototype, "listLearningPredecessors").mockResolvedValue([]);
    vi.spyOn(PostgresAgentStartup.prototype, "assertAvailable").mockResolvedValue();
    vi.spyOn(PostgresAgentStartup.prototype, "settlement").mockResolvedValue({
      localUncertain: false,
      runtimeProtected: false,
    });
    let acquisitions = 0;
    const acquire = vi
      .spyOn(PostgresAgentLeases.prototype, "tryAcquire")
      .mockImplementation((scope, ownerInstanceId) =>
        Promise.resolve({
          fence: { ...scope, ownerInstanceId, epoch: String(++acquisitions) },
          observedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
        }),
      );
    const release = vi.spyOn(PostgresAgentLeases.prototype, "release").mockResolvedValue(true);
    const preparing = vi.spyOn(AgentGenerations.prototype, "prepare");
    const owns = vi.spyOn(AgentAssignment.prototype, "owns").mockReturnValue(true);

    mkdirSync(join(directory, "tokens"));
    writeFileSync(
      join(directory, "members.json"),
      JSON.stringify({
        version: 1,
        cluster_id: randomUUID(),
        members: [
          { member_id: "acp-a", origin: "http://127.0.0.1:8086" },
          { member_id: "acp-b", origin: "http://127.0.0.1:8087" },
        ],
      }),
    );
    const inbound = randomBytes(32).toString("base64url");
    writeFileSync(
      join(directory, "callers.json"),
      JSON.stringify({
        "acp-b": ["sha256:" + createHash("sha256").update(inbound).digest("hex")],
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(directory, "tokens", "acp-b"), randomBytes(32).toString("base64url"), {
      mode: 0o600,
    });
    config = loadConfig({
      ...testSecurityEnvironment(),
      ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
      ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
      ANTNEST_ACP_OWNER_MEMBER_ID: owner.member_id,
      ANTNEST_ACP_OWNER_LISTEN: "127.0.0.1:8085",
      ANTNEST_ACP_RUNTIME_CONTROLLER_URL: "http://runtime-controller:8080",
      ANTNEST_ACP_PEER_LISTEN: "127.0.0.1:8086",
      ANTNEST_ACP_PEER_MEMBERSHIP_FILE: join(directory, "members.json"),
      ANTNEST_ACP_PEER_CALLERS_FILE: join(directory, "callers.json"),
      ANTNEST_ACP_PEER_TOKEN_DIRECTORY: join(directory, "tokens"),
    });
    const peer = config.peer;
    if (peer === undefined) throw new Error("Peer mode must be configured");
    const authentication = new PeerAuthentication({
      memberId: owner.member_id,
      membershipFile: peer.membershipFile,
      callersFile: peer.callersFile,
      tokenDirectory: peer.tokenDirectory,
      workload: config.authentication.workload,
    });
    components = buildComponents(
      pool,
      config,
      NOOP_TELEMETRY,
      vi.fn(),
      new AbortController().signal,
      connections,
      owner,
      undefined,
      undefined,
      authentication,
    );
    // Apply the actual local peer leaf without starting listeners or a remote
    // publication aggregate. Its onApplied hook prepares the real generation.
    await components.directory.applyPeerPublication(executionPublication(configuration));
    expect(preparing).toHaveBeenCalledOnce();
    const prepared = preparing.mock.results[0];
    if (prepared?.type !== "return") throw new Error("Original generation was not prepared");
    const generation = (await prepared.value) as AgentGeneration<AcpApplicationPort>;
    const originalFence = { ...generation.authority.fence };
    expect(originalFence.epoch).toBe("1");
    expect(generation.signal.aborted).toBe(false);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    generation.retainRun(work.promise);
    let originalSignal: AbortSignal | undefined;
    dispatched = generation.dispatch(async (_application, signal) => {
      originalSignal = signal;
      entered.resolve();
      await work.promise;
      signal.throwIfAborted();
      return "original work completed";
    });
    void dispatched.catch(() => undefined);
    await entered.promise;
    // A member rejoin changes future preference. It is not an instruction to
    // cancel work already owned by this still-valid lease and generation.
    owns.mockReturnValue(false);
    const manager = components.owned;
    if (manager === undefined) throw new Error("Missing owned peer components");
    await manager.prepare(next);
    expect(originalSignal?.aborted).toBe(false);
    expect(generation.signal.aborted).toBe(false);
    expect(generation.authority.fence).toEqual(originalFence);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    work.resolve();
    await expect(dispatched).resolves.toBe("original work completed");
    expect(generation.taskFailures).toEqual([]);
    expect(generation.signal.aborted).toBe(false);
    expect(release).not.toHaveBeenCalled();
    await manager.shutdown();
    expect(release).toHaveBeenCalledExactlyOnceWith(originalFence);
    expect(acquire).toHaveBeenCalledOnce();
  } catch (error) {
    failures.push(error);
  } finally {
    work.resolve();
    await Promise.allSettled([dispatched]);
    for (const close of [
      () => components?.owned?.shutdown(),
      () => components?.supervisor.shutdown(),
      () => connections.close(),
      () => pool.end(),
      () => config?.authentication.workload.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } catch (error) {
      failures.push(error);
    } finally {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Owned membership rejoin business or cleanup failed");
});
