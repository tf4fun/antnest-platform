import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionDirectory,
  type ExecutionDirectoryDependencies,
} from "../../src/application/execution-directory.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
  type ExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import type { ExecutionConfigurationRepository } from "../../src/ports/execution-configuration.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../fixtures/execution-configuration.js";
import { runtimeConnections } from "../support/runtime-connections.js";

class MemoryConfigurationRepository implements ExecutionConfigurationRepository {
  public readonly records = new Map<string, PublicExecutionConfiguration>();
  private readonly authorities = new Map<string, ExecutionConfiguration>();
  public readonly save = vi.fn(
    (configuration: ExecutionConfiguration, expectedRevision: number | null) => {
      const previous = this.records.get(configuration.organization_id);
      if ((previous?.revision ?? null) !== expectedRevision) return Promise.resolve(false);
      this.commit(configuration);
      return Promise.resolve(true);
    },
  );
  public commit(configuration: ExecutionConfiguration) {
    this.records.set(
      configuration.organization_id,
      structuredClone(publicExecutionConfiguration(configuration)),
    );
    this.authorities.set(configuration.organization_id, structuredClone(configuration));
  }
  public load(organizationId: string) {
    return Promise.resolve(structuredClone(this.records.get(organizationId) ?? null));
  }
  public loadAuthority(organizationId: string) {
    return Promise.resolve(structuredClone(this.authorities.get(organizationId) ?? null));
  }
  public listOrganizations() {
    return Promise.resolve([...this.records.keys()].sort());
  }
}

function setup(repository = new MemoryConfigurationRepository()) {
  const clients = new ProviderClients({
    complete: () => Promise.reject(new Error("No model should be called")),
  });
  const onApplied = vi.fn<ExecutionDirectoryDependencies["onApplied"]>(() => Promise.resolve());
  const onUnavailable = vi.fn<ExecutionDirectoryDependencies["onUnavailable"]>();
  const connections = runtimeConnections();
  const directory = new ExecutionDirectory({
    repository,
    clients,
    runtimeConnections: connections,
    onApplied,
    onUnavailable,
  });
  return { repository, clients, connections, onApplied, onUnavailable, directory };
}

describe("execution directory", () => {
  it("keeps the last confirmed snapshot visible during 1000 successful applies", async () => {
    const { directory, onApplied, onUnavailable } = setup();
    const initial = executionConfiguration();
    const identity = executionIdentity();
    await directory.apply(initial);
    const cleanup = directory.runtimeForCleanup(identity);
    expect(cleanup).not.toBeNull();

    for (let revision = 2; revision <= 1001; revision++) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      onApplied.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const next = structuredClone(initial);
      next.revision = revision;
      const publishing = directory.apply(next);
      try {
        await Promise.race([
          entered.promise,
          publishing.then(() => {
            throw new Error("Publication completed before its held callback");
          }),
        ]);
        await nextTurn();
        expect(directory.inspect(identity).configuration.revision).toBe(revision - 1);
        expect(directory.runtimeForCleanup(identity)).toEqual(cleanup);
      } finally {
        release.resolve();
        await publishing;
      }
      expect(directory.inspect(identity).configuration.revision).toBe(revision);
    }
    expect(onApplied).toHaveBeenCalledTimes(1001);
    expect(onUnavailable).not.toHaveBeenCalled();
  }, 15_000);

  function binding(configuration = executionConfiguration()) {
    return resolveExecutionConfiguration(
      publicExecutionConfiguration(parseExecutionConfiguration(configuration)),
      executionIdentity(),
      {},
    ).runtime;
  }

  it("rejects lifecycle closure while publication is queued without blocking another organization", async () => {
    const { directory, repository, onApplied } = setup();
    const configuration = executionConfiguration();
    configuration.agents[0]!.accepting_runs = false;
    delete configuration.agents[0]!.runtime?.credential;
    configuration.agents[0]!.operation_id = "rebuild-1";
    await directory.apply(configuration);
    const other = structuredClone(configuration);
    other.organization_id = "organization-2";
    other.agents[0]!.runtime = runtimeConfiguration(2);
    delete other.agents[0]!.runtime.credential;
    await directory.apply(other);
    const operation = {
      organizationId: "organization-1",
      agentId: "agent-1",
      minimumRevision: 1,
      operationId: "rebuild-1",
    };
    const otherOperation = { ...operation, organizationId: "organization-2" };
    const replacement = structuredClone(configuration);
    replacement.revision = 2;
    replacement.agents[0]!.operation_id = "rebuild-2";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = directory.withAccess(executionIdentity(), async () => {
      entered.resolve();
      await release.promise;
    });
    const activeResult = active.then(
      () => null,
      (error: unknown) => error,
    );
    const publicationResult = directory.apply(replacement).then(
      (acknowledgement) => acknowledgement,
      (error: unknown) => error,
    );
    const independentAction = vi.fn(() => Promise.resolve(directory.closedAgent(otherOperation)));
    const independentResult = directory
      .withAccess({ ...executionIdentity(), organizationId: "organization-2" }, independentAction)
      .then(
        (closed) => closed,
        (error: unknown) => error,
      );
    try {
      await Promise.race([
        entered.promise,
        activeResult.then(() => {
          throw new Error("Agent commit completed before its held callback");
        }),
      ]);
      await nextTurn();
      expect(onApplied).toHaveBeenCalledTimes(2);
      expect(repository.records.get("organization-1")?.revision).toBe(1);
      expect(() => directory.closedAgent(operation)).toThrow(
        expect.objectContaining({ code: "configuration_not_ready" }),
      );
      expect(directory.closedAgent(otherOperation).revision).toBe(1);
      expect(independentAction).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.all([activeResult, publicationResult, independentResult]);
    }
    expect(await activeResult).toBeNull();
    expect(await publicationResult).toEqual({
      organization_id: "organization-1",
      applied_revision: 2,
    });
    expect(await independentResult).toMatchObject({ revision: 1 });
    expect(() => directory.closedAgent(operation)).toThrow(
      expect.objectContaining({ code: "agent_operation_conflict" }),
    );
    expect(directory.closedAgent({ ...operation, operationId: "rebuild-2" }).revision).toBe(2);
  });

  it.each(["success", "failure"] as const)(
    "keeps the confirmed Runtime and principal view until held publication ends with %s",
    async (outcome) => {
      const { directory, connections, onApplied, onUnavailable } = setup();
      const initial = executionConfiguration();
      const identity = executionIdentity();
      await directory.apply(initial);
      const previous = binding(initial);
      const changed = executionConfiguration();
      changed.revision = 2;
      changed.agents[0]!.runtime = runtimeConfiguration(2);
      const candidate = binding(changed);
      changed.agents[0]!.principal_ids = ["principal-2"];
      changed.agents[0]!.access_revision = "access-2";
      const replacementIdentity = { ...identity, principalId: "principal-2" };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failure = new Error("held publication failed");
      onApplied.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") throw failure;
      });
      const publicationResult = directory.apply(changed).then(
        (acknowledgement) => acknowledgement,
        (error: unknown) => error,
      );
      const previousAction = vi.fn(() => Promise.resolve("old access"));
      const candidateAction = vi.fn(() => Promise.resolve("new access"));
      const previousAccessResult = directory.withAccess(identity, previousAction).then(
        (result) => result,
        (error: unknown) => error,
      );
      const candidateAccessResult = directory.withAccess(replacementIdentity, candidateAction).then(
        (result) => result,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          entered.promise,
          publicationResult.then(() => {
            throw new Error("Publication completed before its held callback");
          }),
        ]);
        await nextTurn();
        const inspected = directory.inspect(identity);
        expect(inspected.configuration.revision).toBe(1);
        expect(inspected.agent.principal_ids).toEqual(["principal-1"]);
        expect(inspected.agent.access_revision).toBe("access-1");
        expect(inspected.agent.runtime).toEqual({
          runtime_revision: previous.revision,
          runtime_execution_id: previous.executionId,
          mcp_endpoint: previous.mcpEndpoint,
          connection_id: previous.connectionId,
        });
        expect(directory.runtimeForCleanup(identity)).toEqual(previous);
        expect(() => directory.inspect(replacementIdentity)).toThrow(
          expect.objectContaining({ code: "access_denied" }),
        );
        expect(() => connections.fetchFor(previous)).not.toThrow();
        expect(() => connections.fetchFor(candidate)).toThrow();
        expect(previousAction).not.toHaveBeenCalled();
        expect(candidateAction).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.all([publicationResult, previousAccessResult, candidateAccessResult]);
      }
      expect(onApplied).toHaveBeenCalledTimes(2);
      expect(previousAction).not.toHaveBeenCalled();
      expect(() => connections.fetchFor(previous)).toThrow();
      if (outcome === "success") {
        expect(await publicationResult).toEqual({
          organization_id: "organization-1",
          applied_revision: 2,
        });
        expect(await previousAccessResult).toMatchObject({ code: "access_denied" });
        expect(await candidateAccessResult).toBe("new access");
        expect(candidateAction).toHaveBeenCalledTimes(1);
        expect(() => directory.inspect(identity)).toThrow(
          expect.objectContaining({ code: "access_denied" }),
        );
        const inspected = directory.inspect(replacementIdentity);
        expect(inspected.configuration.revision).toBe(2);
        expect(inspected.agent.principal_ids).toEqual(["principal-2"]);
        expect(inspected.agent.access_revision).toBe("access-2");
        expect(directory.runtimeForCleanup(identity)).toEqual(candidate);
        expect(() => connections.fetchFor(candidate)).not.toThrow();
        expect(onUnavailable).not.toHaveBeenCalled();
      } else {
        expect(await publicationResult).toBe(failure);
        expect(await previousAccessResult).toMatchObject({ code: "configuration_not_ready" });
        expect(await candidateAccessResult).toMatchObject({ code: "configuration_not_ready" });
        expect(candidateAction).not.toHaveBeenCalled();
        expect(() => directory.inspect(identity)).toThrow(
          expect.objectContaining({ code: "configuration_not_ready" }),
        );
        expect(() => directory.inspect(replacementIdentity)).toThrow(
          expect.objectContaining({ code: "configuration_not_ready" }),
        );
        expect(directory.runtimeForCleanup(identity)).toBeNull();
        expect(() => connections.fetchFor(candidate)).toThrow();
        expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("organization-1");
      }
    },
  );

  it("publishes usable private Runtime authority while storing and exposing only its public reference", async () => {
    const { directory, repository, connections, onApplied } = setup();
    const configuration = executionConfiguration();
    const reference = binding(configuration);
    onApplied.mockImplementationOnce((candidate) => {
      expect(JSON.stringify(candidate)).not.toContain(
        configuration.agents[0]!.runtime!.credential!.token,
      );
      expect(() => connections.fetchFor(reference)).toThrow();
      return Promise.resolve();
    });
    await directory.apply(configuration);
    expect(() => connections.fetchFor(reference)).not.toThrow();
    expect(JSON.stringify([...repository.records.values()])).not.toContain(
      configuration.agents[0]!.runtime!.credential!.token,
    );
    expect(directory.inspect(executionIdentity()).agent.runtime).toEqual({
      runtime_revision: reference.revision,
      runtime_execution_id: reference.executionId,
      mcp_endpoint: reference.mcpEndpoint,
      connection_id: reference.connectionId,
    });
  });

  it.each([1, 2])(
    "rejects changed Runtime credentials before acknowledgement or storage at revision %i",
    async (revision) => {
      const { directory, repository, onApplied } = setup();
      await directory.apply(executionConfiguration());
      const changed = executionConfiguration();
      changed.revision = revision;
      changed.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 7).toString("base64url");
      await expect(directory.apply(changed)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(onApplied).toHaveBeenCalledTimes(1);
      expect(directory.inspect(executionIdentity()).configuration.revision).toBe(1);
    },
  );

  it("rechecks sender files before acknowledging an equal-revision replay", async () => {
    const { directory, repository, connections, onApplied } = setup();
    await directory.apply(executionConfiguration());
    unlinkSync(join(connections.directory, binding().connectionId, "antnest-runtime"));
    await expect(directory.apply(executionConfiguration())).rejects.toMatchObject({
      code: "runtime_connection_unavailable",
    });
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("saves full private authority on an applied equal-revision replay without republishing", async () => {
    const { directory, repository, onApplied } = setup();
    const configuration = parseExecutionConfiguration(executionConfiguration());
    await directory.apply(configuration);

    await expect(directory.apply(structuredClone(configuration))).resolves.toEqual({
      organization_id: configuration.organization_id,
      applied_revision: configuration.revision,
    });

    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.save).toHaveBeenLastCalledWith(configuration, configuration.revision);
    expect(await repository.loadAuthority(configuration.organization_id)).toEqual(configuration);
    expect(onApplied).toHaveBeenCalledTimes(1);
    await expect(
      directory.withAccess(executionIdentity(), ({ configuration: current }) =>
        Promise.resolve(current.revision),
      ),
    ).resolves.toBe(configuration.revision);
  });

  it("backfills private authority before publishing a public-only legacy equal revision", async () => {
    const repository = new MemoryConfigurationRepository();
    const configuration = parseExecutionConfiguration(executionConfiguration());
    repository.records.set(
      configuration.organization_id,
      structuredClone(publicExecutionConfiguration(configuration)),
    );
    expect(await repository.loadAuthority(configuration.organization_id)).toBeNull();
    const { directory, onApplied } = setup(repository);
    onApplied.mockImplementationOnce(async () => {
      expect(repository.save).toHaveBeenCalledExactlyOnceWith(
        configuration,
        configuration.revision,
      );
      expect(await repository.loadAuthority(configuration.organization_id)).toEqual(configuration);
    });

    await expect(directory.apply(configuration)).resolves.toEqual({
      organization_id: configuration.organization_id,
      applied_revision: configuration.revision,
    });

    expect(repository.save).toHaveBeenCalledExactlyOnceWith(configuration, configuration.revision);
    expect(await repository.loadAuthority(configuration.organization_id)).toEqual(configuration);
    expect(onApplied).toHaveBeenCalledTimes(1);
    await expect(
      directory.withAccess(executionIdentity(), ({ configuration: current }) =>
        Promise.resolve(current.revision),
      ),
    ).resolves.toBe(configuration.revision);
  });

  it.each(["database", "cas"])(
    "rolls back candidate authority and keeps the original connection after %s failure",
    async (failure) => {
      const { directory, repository, connections } = setup();
      await directory.apply(executionConfiguration());
      const previous = binding();
      const changed = executionConfiguration();
      changed.revision = 2;
      changed.agents[0]!.runtime = runtimeConfiguration(2);
      const candidate = binding(changed);
      if (failure === "cas") repository.save.mockResolvedValueOnce(false);
      else repository.save.mockRejectedValueOnce(new Error("storage failed"));
      await expect(directory.apply(changed)).rejects.toThrow();
      expect(() => connections.fetchFor(previous)).not.toThrow();
      expect(() => connections.fetchFor(candidate)).toThrow();
      expect(readdirSync(connections.directory)).toEqual([previous.connectionId]);
      expect(directory.inspect(executionIdentity()).configuration.revision).toBe(1);
    },
  );

  it("revokes previous Runtime access and cleanup authority after a committed snapshot loses its acknowledgement", async () => {
    const { directory, repository, connections, onApplied } = setup();
    const identity = executionIdentity();
    await directory.apply(executionConfiguration());
    const previous = binding();
    expect(directory.runtimeForCleanup(identity)).toEqual(previous);
    const changed = executionConfiguration();
    changed.revision = 2;
    changed.agents[0]!.runtime = runtimeConfiguration(2);
    const candidate = binding(changed);
    repository.save.mockImplementationOnce((configuration) => {
      repository.commit(configuration);
      return Promise.reject(new Error("commit acknowledgement lost"));
    });

    await expect(directory.apply(changed)).rejects.toThrow("acknowledgement");
    expect(repository.records.get(changed.organization_id)?.revision).toBe(2);
    expect(await repository.loadAuthority(changed.organization_id)).toEqual(
      parseExecutionConfiguration(changed),
    );
    const oldAccess = vi.fn(() => Promise.resolve("old authority"));
    await expect(directory.withAccess(identity, oldAccess)).rejects.toMatchObject({
      code: "configuration_not_ready",
    });
    expect(oldAccess).not.toHaveBeenCalled();
    expect(directory.runtimeForCleanup(identity)).toBeNull();
    expect(() => connections.fetchFor(candidate)).toThrow();
    expect(onApplied).toHaveBeenCalledTimes(1);
    await expect(directory.apply(executionConfiguration())).rejects.toThrow("newer");
    expect(directory.runtimeForCleanup(identity)).toBeNull();

    await expect(directory.apply(changed)).resolves.toHaveProperty("applied_revision", 2);
    expect(repository.save).toHaveBeenLastCalledWith(parseExecutionConfiguration(changed), 2);
    await expect(
      directory.withAccess(identity, ({ configuration }) =>
        Promise.resolve(configuration.revision),
      ),
    ).resolves.toBe(2);
    expect(directory.runtimeForCleanup(identity)).toEqual(candidate);
    expect(() => connections.fetchFor(candidate)).not.toThrow();
    expect(() => connections.fetchFor(previous)).toThrow();
    expect(onApplied).toHaveBeenCalledTimes(2);
  });

  it("revokes publication authority on failure but preserves an already accepted original Run", async () => {
    const { directory, connections, onApplied } = setup();
    await directory.apply(executionConfiguration());
    const previous = binding();
    connections.retainRun("accepted-run", previous);
    const changed = executionConfiguration();
    changed.revision = 2;
    changed.agents[0]!.runtime = runtimeConfiguration(2);
    onApplied.mockRejectedValueOnce(new Error("publication failed"));
    await expect(directory.apply(changed)).rejects.toThrow("publication failed");
    expect(() => directory.inspect(executionIdentity())).toThrow("ready");
    expect(() => connections.fetchFor(previous)).not.toThrow();
    expect(() => connections.retainRun("later-run", previous)).toThrow();
    expect(() => connections.fetchFor(binding(changed))).toThrow();
    connections.releaseRun("accepted-run");
    expect(readdirSync(connections.directory)).toEqual([]);
    await directory.apply(changed);
    expect(() => connections.fetchFor(binding(changed))).not.toThrow();
  });

  it.each([2, 3])(
    "keeps immutable Runtime credential identity after failed publication when revision %i is retried",
    async (revision) => {
      const { directory, onApplied, repository } = setup();
      await directory.apply(executionConfiguration());
      const changed = executionConfiguration();
      changed.revision = 2;
      changed.agents[0]!.runtime = runtimeConfiguration(2);
      onApplied.mockRejectedValueOnce(new Error("publication failed"));
      await expect(directory.apply(changed)).rejects.toThrow("publication failed");
      const altered = structuredClone(changed);
      altered.revision = revision;
      altered.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 7).toString("base64url");
      await expect(directory.apply(altered)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(repository.records.get("organization-1")?.revision).toBe(2);
      await directory.apply(changed);
    },
  );

  it("closes execution if a staged sender file disappears during publication", async () => {
    const { directory, connections, onApplied, onUnavailable } = setup();
    const configuration = executionConfiguration();
    onApplied.mockImplementationOnce(() => {
      unlinkSync(join(connections.directory, binding().connectionId, "antnest-runtime"));
      return Promise.resolve();
    });
    await expect(directory.apply(configuration)).rejects.toMatchObject({
      code: "runtime_connection_unavailable",
    });
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("organization-1");
    expect(() => directory.inspect(executionIdentity())).toThrow("ready");
    expect(existsSync(join(connections.directory, binding().connectionId))).toBe(false);
  });

  it("exposes only installed and retained Runtime authority for private cleanup of a closed Agent", async () => {
    const { directory, connections } = setup();
    const scope = { organizationId: "organization-1", agentId: "agent-1" };
    expect(directory.runtimeForCleanup(scope)).toBeNull();
    const configuration = executionConfiguration();
    await directory.apply(configuration);
    const original = binding(configuration);
    connections.retainRun("accepted-run", original);
    configuration.revision++;
    configuration.agents[0]!.accepting_runs = false;
    delete configuration.agents[0]!.runtime?.credential;
    delete configuration.agents[0]!.runtime?.connection_id;
    configuration.agents[0]!.principal_ids = [];
    await directory.apply(configuration);
    expect(directory.runtimeForCleanup(scope)).toEqual(original);
    expect(directory.runtimeForCleanup({ ...scope, organizationId: "other-org" })).toBeNull();
    expect(directory.runtimeForCleanup({ ...scope, agentId: "other-agent" })).toBeNull();
    connections.releaseRun("accepted-run");
    expect(directory.runtimeForCleanup(scope)).toBeNull();
  });

  it("cannot manufacture cleanup authority from a closed snapshot after restart", async () => {
    const { directory, connections } = setup();
    const configuration = executionConfiguration();
    configuration.agents[0]!.accepting_runs = false;
    delete configuration.agents[0]!.runtime?.credential;
    await directory.apply(configuration);
    expect(
      directory.runtimeForCleanup({ organizationId: "organization-1", agentId: "agent-1" }),
    ).toBeNull();
    expect(readdirSync(connections.directory)).toEqual([]);
  });
  it("rejects nonempty legacy Skill bodies without changing the published configuration", async () => {
    const { directory, repository, onApplied } = setup();
    const current = executionConfiguration();
    await directory.apply(current);
    const candidate = structuredClone(current);
    candidate.revision++;
    candidate.agents[0]!.skill_instructions = [
      { skill_key: "example", version: "1", instructions: "hidden body" },
    ];
    await expect(directory.apply(candidate)).rejects.toThrow();
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(directory.inspect(executionIdentity()).configuration.revision).toBe(current.revision);
  });

  it("checks lifecycle closure against the live applied revision rather than a user's access", async () => {
    const { directory } = setup();
    const configuration = executionConfiguration();
    configuration.revision = 3;
    configuration.agents[0]!.principal_ids = [];
    configuration.agents[0]!.accepting_runs = false;
    delete configuration.agents[0]!.runtime?.credential;
    configuration.agents[0]!.operation_id = "rebuild-1";
    await directory.apply(configuration);
    const operation = {
      organizationId: "organization-1",
      agentId: "agent-1",
      minimumRevision: 2,
      operationId: "rebuild-1",
    };
    const inspected = directory.closedAgent(operation);
    inspected.agent.operation_id = "do-not-mutate-directory";
    expect(inspected.revision).toBe(3);
    expect(directory.closedAgent(operation).agent.operation_id).toBe("rebuild-1");
  });

  it.each(["uninitialized", "old_revision", "wrong_operation", "open", "missing", "foreign_org"])(
    "does not act on an unmatched lifecycle closure: %s",
    async (condition) => {
      const { directory } = setup();
      const configuration = executionConfiguration();
      configuration.agents[0]!.accepting_runs = condition === "open";
      if (!configuration.agents[0]!.accepting_runs)
        delete configuration.agents[0]!.runtime?.credential;
      configuration.agents[0]!.operation_id =
        condition === "wrong_operation" ? "rebuild-2" : "rebuild-1";
      if (condition === "missing") configuration.agents = [];
      if (condition !== "uninitialized") await directory.apply(configuration);
      expect(() =>
        directory.closedAgent({
          organizationId: condition === "foreign_org" ? "organization-2" : "organization-1",
          agentId: "agent-1",
          minimumRevision: condition === "old_revision" ? 2 : 1,
          operationId: "rebuild-1",
        }),
      ).toThrow(
        expect.objectContaining({
          code:
            condition === "uninitialized" || condition === "foreign_org"
              ? "configuration_not_ready"
              : "agent_operation_conflict",
        }),
      );
    },
  );

  it("does not read an unpublished lifecycle candidate or queue behind publication", async () => {
    const { directory, onApplied } = setup();
    const configuration = executionConfiguration();
    configuration.agents[0]!.accepting_runs = false;
    delete configuration.agents[0]!.runtime?.credential;
    configuration.agents[0]!.operation_id = "rebuild-1";
    await directory.apply(configuration);
    const replacement = structuredClone(configuration);
    replacement.revision = 2;
    replacement.agents[0]!.operation_id = "rebuild-2";
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    onApplied.mockImplementationOnce(() => {
      started.resolve();
      return finish.promise;
    });
    const publication = directory.apply(replacement);
    await started.promise;
    const operation = {
      organizationId: "organization-1",
      agentId: "agent-1",
      minimumRevision: 1,
      operationId: "rebuild-1",
    };
    try {
      expect(() => directory.closedAgent(operation)).toThrow(
        expect.objectContaining({ code: "configuration_not_ready" }),
      );
    } finally {
      finish.resolve();
    }
    await publication;
    expect(() => directory.closedAgent(operation)).toThrow(
      expect.objectContaining({ code: "agent_operation_conflict" }),
    );
  });

  it("does not accept access before a live configuration has been applied", async () => {
    const { directory } = setup();
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toThrow("ready");
    expect(await directory.apply(executionConfiguration())).toEqual({
      organization_id: "organization-1",
      applied_revision: 1,
    });
    expect(
      await directory.withAccess(executionIdentity(), ({ agent }) =>
        Promise.resolve(agent.agent_id),
      ),
    ).toBe("agent-1");
  });

  it("stores only non-secret configuration and never treats persisted readiness as live readiness", async () => {
    const { directory, repository } = setup();
    await directory.apply(executionConfiguration());
    expect(JSON.stringify([...repository.records.values()])).not.toContain(
      "synthetic-provider-key",
    );
    const restarted = setup(repository);
    await expect(
      restarted.directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toThrow("ready");
    await restarted.directory.apply(executionConfiguration());
    const handle = restarted.clients.acquire("organization-1", "provider-1");
    handle.release();
    expect(restarted.onApplied).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite newer configuration or revive a revoked Agent with an old snapshot", async () => {
    const { directory, clients } = setup();
    await directory.apply(executionConfiguration());
    const cleared = {
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    };
    await directory.apply(cleared);
    expect(await directory.apply(executionConfiguration())).toEqual({
      organization_id: "organization-1",
      applied_revision: 2,
    });
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toThrow("access");
    expect(() => clients.acquire("organization-1", "provider-1")).toThrow("unavailable");
  });

  it("rejects changed configuration or authentication at an already applied revision", async () => {
    const { directory } = setup();
    const initial = executionConfiguration();
    await directory.apply(initial);
    const altered = executionConfiguration();
    altered.providers = altered.providers.map((provider) => ({
      ...provider,
      credential: { method: "api_key", secret: "different-secret" },
    }));
    await expect(directory.apply(altered)).rejects.toThrow("revision");
    await expect(directory.apply({ ...initial, agents: [] })).rejects.toThrow("revision");
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it("cannot acknowledge an old snapshot as live initialization after restart", async () => {
    const repository = new MemoryConfigurationRepository();
    const next = executionConfiguration();
    next.revision = 2;
    repository.records.set(
      next.organization_id,
      publicExecutionConfiguration(parseExecutionConfiguration(next)),
    );
    const { directory, onApplied } = setup(repository);
    await expect(directory.apply(executionConfiguration())).rejects.toThrow("newer");
    expect(onApplied).not.toHaveBeenCalled();
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toThrow("ready");
    await directory.apply(next);
  });

  it("does not partially replace a live configuration when validation or storage fails", async () => {
    const { directory, repository, onApplied, onUnavailable } = setup();
    await directory.apply(executionConfiguration());
    await expect(
      directory.apply({ ...executionConfiguration(), revision: 2, providers: [] }),
    ).rejects.toThrow("reference");
    repository.save.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      directory.apply({
        organization_id: "organization-1",
        revision: 2,
        agents: [],
        models: [],
        providers: [],
      }),
    ).rejects.toThrow("database");
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).resolves.toBeUndefined();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("keeps execution closed when revocation publication fails and retries publication on replay", async () => {
    const { directory, onApplied, onUnavailable } = setup();
    await directory.apply(executionConfiguration());
    onApplied.mockRejectedValueOnce(new Error("subscription reconciliation failed"));
    const changed = { ...executionConfiguration(), revision: 2 };
    await expect(directory.apply(changed)).rejects.toThrow("subscription");
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith("organization-1");
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toThrow("ready");
    await directory.apply(changed);
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).resolves.toBeUndefined();
    expect(onApplied).toHaveBeenCalledTimes(3);
  });

  it("does not acknowledge a stored but unpublished revision when an older snapshot arrives", async () => {
    const { directory, onApplied } = setup();
    await directory.apply(executionConfiguration());
    onApplied.mockRejectedValueOnce(new Error("publication failed"));
    await expect(directory.apply({ ...executionConfiguration(), revision: 2 })).rejects.toThrow(
      "publication",
    );
    await expect(directory.apply(executionConfiguration())).rejects.toThrow("newer");
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toThrow("ready");
    await directory.apply({ ...executionConfiguration(), revision: 3 });
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it("does not allow a connection to change its routing while preserving identity", async () => {
    const { directory, repository } = setup();
    await directory.apply(executionConfiguration());
    const changed = executionConfiguration();
    changed.revision = 2;
    changed.providers[0]!.base_url = "https://different-provider.example";
    await expect(directory.apply(changed)).rejects.toMatchObject({
      code: "configuration_conflict",
    });
    expect(repository.records.get("organization-1")?.revision).toBe(1);
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it("does not attach a changed secret to the same credential revision", async () => {
    const { directory, repository } = setup();
    await directory.apply(executionConfiguration());
    const changed = executionConfiguration();
    changed.revision = 2;
    changed.providers[0]!.credential.secret = "synthetic-rotated-key";
    await expect(directory.apply(changed)).rejects.toMatchObject({
      code: "configuration_conflict",
    });
    expect(repository.records.get("organization-1")?.revision).toBe(1);
    changed.providers[0]!.credential_revision = "credential-2";
    await expect(directory.apply(changed)).resolves.toHaveProperty("applied_revision", 2);
  });

  it("validates immutable connection routing after restart without loading secrets from storage", async () => {
    const { directory, repository } = setup();
    await directory.apply(executionConfiguration());
    const restarted = setup(repository);
    const changed = executionConfiguration();
    changed.revision = 2;
    changed.providers[0]!.base_url = "https://different-provider.example";
    await expect(restarted.directory.apply(changed)).rejects.toMatchObject({
      code: "configuration_conflict",
    });
    await expect(
      restarted.directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toThrow("ready");
    await expect(restarted.directory.apply(executionConfiguration())).resolves.toHaveProperty(
      "applied_revision",
      1,
    );
  });

  it("orders authorization commits before revocation and blocks later commits", async () => {
    const { directory } = setup();
    await directory.apply(executionConfiguration());
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const order: string[] = [];
    const permission = directory.withAccess(executionIdentity(), async () => {
      entered.resolve();
      await finish.promise;
      order.push("permission committed");
    });
    await entered.promise;
    const revoked = directory
      .apply({
        organization_id: "organization-1",
        revision: 2,
        agents: [],
        models: [],
        providers: [],
      })
      .then(() => {
        order.push("revocation applied");
      });
    const late = directory.withAccess(executionIdentity(), () => {
      order.push("invalid late commit");
      return Promise.resolve();
    });
    const rejected = expect(late).rejects.toThrow("access");
    finish.resolve();
    await permission;
    await revoked;
    await rejected;
    expect(order).toEqual(["permission committed", "revocation applied"]);
  });

  it.each([2, 3])(
    "recovers a lost storage commit receipt by publishing revision %s",
    async (revision) => {
      const { directory, repository, onApplied } = setup();
      await directory.apply(executionConfiguration());
      const changed = executionConfiguration();
      changed.revision = 2;
      changed.providers[0]!.credential_revision = "credential-2";
      changed.providers[0]!.credential.secret = "rotated-key";
      repository.save.mockImplementationOnce((configuration) => {
        repository.commit(configuration);
        return Promise.reject(new Error("commit acknowledgement lost"));
      });
      await expect(directory.apply(changed)).rejects.toThrow("acknowledgement");
      expect(repository.records.get(changed.organization_id)?.revision).toBe(2);
      await expect(
        directory.withAccess(executionIdentity(), ({ configuration }) =>
          Promise.resolve(configuration.revision),
        ),
      ).rejects.toMatchObject({ code: "configuration_not_ready" });
      expect(directory.runtimeForCleanup(executionIdentity())).toBeNull();
      await expect(directory.apply(executionConfiguration())).rejects.toThrow("newer");
      expect(onApplied).toHaveBeenCalledTimes(1);
      await expect(directory.apply({ ...changed, revision })).resolves.toHaveProperty(
        "applied_revision",
        revision,
      );
      await expect(
        directory.withAccess(executionIdentity(), ({ configuration }) =>
          Promise.resolve(configuration.revision),
        ),
      ).resolves.toBe(revision);
      expect(onApplied).toHaveBeenCalledTimes(2);
    },
  );

  it.each([2, 3])(
    "keeps known credential identity after failed publication of revision %s",
    async (revision) => {
      const { directory, onApplied, repository } = setup();
      await directory.apply(executionConfiguration());
      const changed = executionConfiguration();
      changed.revision = 2;
      changed.providers[0]!.credential_revision = "credential-2";
      changed.providers[0]!.credential.secret = "rotated-key";
      onApplied.mockRejectedValueOnce(new Error("publication failed"));
      await expect(directory.apply(changed)).rejects.toThrow("publication");
      const conflict = structuredClone(changed);
      conflict.revision = revision;
      conflict.providers[0]!.credential.secret = "conflicting-key";
      await expect(directory.apply(conflict)).rejects.toMatchObject({
        code: "configuration_conflict",
      });
      expect(repository.records.get("organization-1")?.revision).toBe(2);
      await expect(
        directory.withAccess(executionIdentity(), () => Promise.resolve()),
      ).rejects.toThrow("ready");
      await expect(directory.apply(changed)).resolves.toHaveProperty("applied_revision", 2);
    },
  );

  it("revokes an omitted connection before accepting a fresh target with the same identifier", async () => {
    const { directory, clients, repository } = setup();
    await directory.apply(executionConfiguration());
    const held = clients.acquire("organization-1", "provider-1");
    try {
      await directory.apply({
        organization_id: "organization-1",
        revision: 2,
        agents: [],
        models: [],
        providers: [],
      });
      const changed = executionConfiguration();
      changed.revision = 3;
      changed.providers[0]!.base_url = "https://other-provider.example";
      changed.providers[0]!.credential_revision = "credential-3";
      changed.providers[0]!.credential.secret = "other-target-key";
      expect(held.signal.aborted).toBe(true);
      await expect(directory.apply(changed)).resolves.toHaveProperty("applied_revision", 3);
      expect(repository.records.get("organization-1")?.revision).toBe(3);
      expect(held.signal.aborted).toBe(true);
    } finally {
      held.release();
    }
  });

  it("does not couple another organization's access to a pending configuration write", async () => {
    const { directory } = setup();
    await directory.apply(executionConfiguration());
    const other = executionConfiguration();
    other.organization_id = "organization-2";
    other.agents[0]!.runtime = runtimeConfiguration(2);
    await directory.apply(other);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const active = directory.withAccess(executionIdentity(), async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    await expect(
      directory.withAccess({ ...executionIdentity(), organizationId: "organization-2" }, () =>
        Promise.resolve("independent"),
      ),
    ).resolves.toBe("independent");
    finish.resolve();
    await active;
  });

  async function twoAgents() {
    const test = setup();
    const configuration = executionConfiguration();
    configuration.agents.push({
      ...structuredClone(configuration.agents[0]!),
      agent_id: "agent-2",
      principal_ids: ["principal-2"],
      runtime: runtimeConfiguration(2),
    });
    await test.directory.apply(configuration);
    return {
      ...test,
      configuration,
      other: { ...executionIdentity(), agentId: "agent-2", principalId: "principal-2" },
    };
  }

  it("lets another Agent access the same organization while preserving each Agent's FIFO", async () => {
    const { directory, other } = await twoAgents();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const active = directory.withAccess(executionIdentity(), async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    const order: string[] = [];
    const same = directory.withAccess(executionIdentity(), () => {
      order.push("same");
      return Promise.resolve();
    });
    const independent = directory.withAccess(other, () => {
      order.push("other");
      return Promise.resolve();
    });
    try {
      await nextTurn();
      expect(order).toEqual(["other"]);
    } finally {
      finish.resolve();
      await Promise.all([active, same, independent]);
    }
    expect(order).toEqual(["other", "same"]);
  });

  it("waits for every earlier Agent commit and prevents later access from passing revocation", async () => {
    const { directory, repository, other } = await twoAgents();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const entered: string[] = [];
    const a = directory.withAccess(executionIdentity(), async () => {
      entered.push("a");
      await first.promise;
    });
    const b = directory.withAccess(other, async () => {
      entered.push("b");
      await second.promise;
    });
    const revoked = directory.apply({
      organization_id: "organization-1",
      revision: 2,
      agents: [],
      models: [],
      providers: [],
    });
    const late = directory.withAccess(other, () => {
      entered.push("invalid late");
      return Promise.resolve();
    });
    const lateResult = late.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await nextTurn();
      expect(entered).toEqual(["a", "b"]);
      expect(repository.save).toHaveBeenCalledTimes(1);
      first.resolve();
      await a;
      await nextTurn();
      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(entered).toEqual(["a", "b"]);
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([a, b, revoked]);
    }
    expect(await lateResult).toMatchObject({ code: "access_denied" });
    expect(repository.save).toHaveBeenCalledTimes(2);
  });

  it("orders successive publications around already queued Agent commits without starving either", async () => {
    const { directory, other, configuration } = await twoAgents();
    const first = Promise.withResolvers<void>();
    const middle = Promise.withResolvers<void>();
    const observed: number[] = [];
    const a = directory.withAccess(executionIdentity(), async () => {
      await first.promise;
    });
    const revision2 = directory.apply({ ...configuration, revision: 2 });
    const b = directory.withAccess(other, async ({ configuration: current }) => {
      observed.push(current.revision);
      await middle.promise;
    });
    const revision3 = directory.apply({ ...configuration, revision: 3 });
    const late = directory.withAccess(executionIdentity(), ({ configuration: current }) => {
      observed.push(current.revision);
      return Promise.resolve();
    });
    try {
      await nextTurn();
      expect(observed).toEqual([]);
      first.resolve();
      await revision2;
      await nextTurn();
      expect(observed).toEqual([2]);
    } finally {
      first.resolve();
      middle.resolve();
      await Promise.all([a, revision2, b, revision3, late]);
    }
    expect(observed).toEqual([2, 3]);
  });

  it("keeps a failed Agent action's error and releases its publication dependencies", async () => {
    const { directory, other, configuration } = await twoAgents();
    const failure = new Error("original commit failure");
    const finish = Promise.withResolvers<void>();
    const a = directory.withAccess(executionIdentity(), async () => {
      await finish.promise;
      throw failure;
    });
    const result = a.then(
      () => null,
      (error: unknown) => error,
    );
    let independent = false;
    const b = directory.withAccess(other, () => {
      independent = true;
      return Promise.resolve();
    });
    const publication = directory.apply({ ...configuration, revision: 2 });
    try {
      await nextTurn();
      expect(independent).toBe(true);
    } finally {
      finish.resolve();
      await Promise.all([result, b, publication]);
    }
    expect(await result).toBe(failure);
    await expect(
      directory.withAccess(executionIdentity(), ({ configuration: current }) =>
        Promise.resolve(current.revision),
      ),
    ).resolves.toBe(2);
  });

  it("releases the local authority boundary after an action fails", async () => {
    const { directory } = setup();
    await directory.apply(executionConfiguration());
    await expect(
      directory.withAccess(executionIdentity(), () => Promise.reject(new Error("failed commit"))),
    ).rejects.toThrow("failed commit");
    await expect(
      directory.apply({
        organization_id: "organization-1",
        revision: 2,
        agents: [],
        models: [],
        providers: [],
      }),
    ).resolves.toHaveProperty("applied_revision", 2);
  });
});
