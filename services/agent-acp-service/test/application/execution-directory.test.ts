import { describe, expect, it, vi } from "vitest";
import {
  ExecutionDirectory,
  type ExecutionDirectoryDependencies,
} from "../../src/application/execution-directory.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import type { ExecutionConfigurationRepository } from "../../src/ports/execution-configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

class MemoryConfigurationRepository implements ExecutionConfigurationRepository {
  public readonly records = new Map<string, PublicExecutionConfiguration>();
  public readonly save = vi.fn(
    (configuration: PublicExecutionConfiguration, expectedRevision: number | null) => {
      const previous = this.records.get(configuration.organization_id);
      if ((previous?.revision ?? null) !== expectedRevision) return Promise.resolve(false);
      this.records.set(configuration.organization_id, structuredClone(configuration));
      return Promise.resolve(true);
    },
  );
  public load(organizationId: string) {
    return Promise.resolve(structuredClone(this.records.get(organizationId) ?? null));
  }
}

function setup(repository = new MemoryConfigurationRepository()) {
  const clients = new ProviderClients({
    complete: () => Promise.reject(new Error("No model should be called")),
  });
  const onApplied = vi.fn<ExecutionDirectoryDependencies["onApplied"]>(() => Promise.resolve());
  const onUnavailable = vi.fn<ExecutionDirectoryDependencies["onUnavailable"]>();
  const directory = new ExecutionDirectory({ repository, clients, onApplied, onUnavailable });
  return { repository, clients, onApplied, onUnavailable, directory };
}

describe("execution directory", () => {
  it("checks lifecycle closure against the live applied revision rather than a user's access", async () => {
    const { directory } = setup();
    const configuration = executionConfiguration();
    configuration.revision = 3;
    configuration.agents[0]!.principal_ids = [];
    configuration.agents[0]!.accepting_runs = false;
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
        repository.records.set(configuration.organization_id, structuredClone(configuration));
        return Promise.reject(new Error("commit acknowledgement lost"));
      });
      await expect(directory.apply(changed)).rejects.toThrow("acknowledgement");
      await expect(
        directory.withAccess(executionIdentity(), ({ configuration }) =>
          Promise.resolve(configuration.revision),
        ),
      ).resolves.toBe(1);
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
    await directory.apply({ ...executionConfiguration(), organization_id: "organization-2" });
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
