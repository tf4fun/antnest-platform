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
import { LearningWorker } from "../src/application/learning-worker.js";
import { TemporarySkillCleanupWorker } from "../src/application/temporary-skill-cleanup-worker.js";
import { publicExecutionConfiguration } from "../src/domain/execution-configuration.js";
import { executionPublication } from "../src/domain/execution-publication.js";
import type { AcpApplicationPort } from "../src/ports/acp-application.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import { executionConfiguration } from "./fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { runtimeConnections } from "./support/runtime-connections.js";

type BackgroundTask = {
  signal: AbortSignal;
  finished: boolean;
  original: Promise<void>;
  release(): void;
};

it("starts a prepared owned graph on the next refresh when cancellation prevented its activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-activation-retry-"));
  const pool = new Pool();
  const connect = vi.spyOn(pool, "connect").mockImplementation(() => {
    throw new Error("Unexpected database connection in owned activation fixture");
  });
  const query = vi.spyOn(pool, "query").mockImplementation(() => {
    throw new Error("Unexpected database query in owned activation fixture");
  });
  const connections = runtimeConnections();
  const lifetime = new AbortController();
  const cancellation = new AbortController();
  const cancelled = new Error("Ownership refresh cancelled after original graph preparation");
  const tasks: BackgroundTask[] = [];
  const failures: unknown[] = [];
  let config: AgentAcpConfig | undefined;
  let components: ReturnType<typeof buildComponents> | undefined;
  let refreshing: Promise<void> | undefined;
  const run = (signal: AbortSignal): Promise<void> => {
    const done = Promise.withResolvers<void>();
    const task: BackgroundTask = {
      signal,
      finished: false,
      original: Promise.resolve(),
      release: () => done.resolve(),
    };
    const abort = () => done.resolve();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    task.original = done.promise.finally(() => {
      signal.removeEventListener("abort", abort);
      task.finished = true;
    });
    tasks.push(task);
    return task.original;
  };
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
    const acquire = vi
      .spyOn(PostgresAgentLeases.prototype, "tryAcquire")
      .mockImplementation((scope, ownerInstanceId) =>
        Promise.resolve({
          fence: { ...scope, ownerInstanceId, epoch: "1" },
          observedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
        }),
      );
    vi.spyOn(PostgresAgentLeases.prototype, "renew").mockImplementation((fence) =>
      Promise.resolve({ fence, observedAt: new Date(), expiresAt: new Date(Date.now() + 30_000) }),
    );
    const release = vi.spyOn(PostgresAgentLeases.prototype, "release").mockResolvedValue(true);
    const preparing = vi.spyOn(AgentGenerations.prototype, "prepare");
    const owns = vi.spyOn(AgentAssignment.prototype, "owns").mockReturnValue(false);
    const cleanupRun = vi
      .spyOn(TemporarySkillCleanupWorker.prototype, "run")
      .mockImplementation(function (this: TemporarySkillCleanupWorker, signal) {
        return run(signal);
      });
    const learningRun = vi
      .spyOn(LearningWorker.prototype, "run")
      .mockImplementation((signal) => run(signal));

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
      lifetime.signal,
      connections,
      owner,
      undefined,
      undefined,
      authentication,
    );
    await components.directory.applyPeerPublication(executionPublication(configuration));
    const capture = components.directory.capturePublication(configuration.organization_id);
    const manager = components.owned;
    if (manager === undefined) throw new Error("Missing owned peer components");
    expect(acquire).not.toHaveBeenCalled();
    expect(preparing).not.toHaveBeenCalled();
    manager.start();
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(learningRun).not.toHaveBeenCalled();

    owns.mockReturnValue(true);
    expect(manager.needsPreparation(next)).toBe(true);
    const originalPrepare = manager.prepare.bind(manager);
    const published = vi.spyOn(manager, "published");
    vi.spyOn(manager, "prepare").mockImplementationOnce(async (snapshot) => {
      await originalPrepare(snapshot);
      // The actual generation and graph exist, but the directory must still
      // honor cancellation before sending its ownership-activation notification.
      cancellation.abort(cancelled);
    });
    refreshing = components.directory.reconcileOwnership(cancellation.signal);
    await expect(refreshing).rejects.toBe(cancelled);
    expect(acquire).toHaveBeenCalledOnce();
    expect(preparing).toHaveBeenCalledOnce();
    const prepared = preparing.mock.results[0];
    if (prepared?.type !== "return") throw new Error("Original owned generation was not prepared");
    const generation = (await prepared.value) as AgentGeneration<AcpApplicationPort>;
    const originalFence = { ...generation.authority.fence };
    expect(generation.signal.aborted).toBe(false);
    expect(published).not.toHaveBeenCalled();
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(learningRun).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(components.directory.capturePublication(configuration.organization_id)).toBe(capture);

    // A rejoined peer changes future placement, but this valid generation must
    // still finish activation under its original lease and fence.
    owns.mockReturnValue(false);
    expect(manager.needsPreparation(next)).toBe(true);
    await components.directory.reconcileOwnership(new AbortController().signal);
    expect(published).toHaveBeenCalledExactlyOnceWith(configuration.organization_id);
    expect(manager.needsPreparation(next)).toBe(false);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(generation.authority.fence).toEqual(originalFence);
    expect(generation.signal.aborted).toBe(false);
    expect(components.directory.capturePublication(configuration.organization_id)).toBe(capture);

    // startEntry owns two distinct cleanup workers: graph-owned first, then
    // legacy cleanup. Each original receiver starts once; the global worker
    // from the unused legacy graph never starts in owned mode.
    expect(cleanupRun).toHaveBeenCalledTimes(2);
    const [ownedCleanup, legacyCleanup] = cleanupRun.mock.contexts;
    expect(ownedCleanup).toBeInstanceOf(TemporarySkillCleanupWorker);
    expect(legacyCleanup).toBeInstanceOf(TemporarySkillCleanupWorker);
    expect(ownedCleanup).not.toBe(legacyCleanup);
    expect(ownedCleanup).not.toBe(components.temporarySkillCleanupWorker);
    expect(legacyCleanup).not.toBe(components.temporarySkillCleanupWorker);
    for (const worker of [ownedCleanup, legacyCleanup])
      expect(cleanupRun.mock.contexts.filter((receiver) => receiver === worker)).toHaveLength(1);
    expect(tasks.length).toBe(2 + learningRun.mock.calls.length);
    expect(tasks.every((task) => !task.finished && !task.signal.aborted)).toBe(true);

    await manager.shutdown();
    expect(tasks.every((task) => task.finished && task.signal.aborted)).toBe(true);
    expect(release).toHaveBeenCalledExactlyOnceWith(originalFence);
    expect(generation.taskFailures).toEqual([]);
  } catch (error) {
    failures.push(error);
  } finally {
    lifetime.abort(new Error("Owned activation fixture is closing"));
    for (const task of tasks) task.release();
    await Promise.allSettled([refreshing, ...tasks.map((task) => task.original)]);
    for (const close of [
      () => components?.owned?.shutdown(),
      () => components?.supervisor.shutdown(),
      () => components?.joinRevocations(),
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
      expect(tasks.every((task) => task.finished)).toBe(true);
    } catch (error) {
      failures.push(error);
    } finally {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Owned activation retry business or cleanup failed");
});
