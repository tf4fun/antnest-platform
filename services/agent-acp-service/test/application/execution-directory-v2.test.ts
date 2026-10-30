import { describe, expect, it, vi } from "vitest";
import {
  ExecutionDirectory,
  type ExecutionDirectoryDependencies,
} from "../../src/application/execution-directory.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  publicExecutionConfiguration,
  type ExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import type { ExecutionConfigurationRepository } from "../../src/ports/execution-configuration.js";
import {
  executionConfiguration,
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

function v2Fixture() {
  const legacy = executionConfiguration();
  return {
    ...structuredClone(legacy),
    schema_version: 2,
    providers: legacy.providers.map((provider) => ({
      connection_id: provider.connection_id,
      provider_key: provider.provider_key,
      request_protocol: provider.request_protocol,
      base_url: provider.base_url,
      enabled: provider.enabled,
      credential_revision: provider.credential_revision,
      credential: { ref: provider.connection_id, version: provider.credential_revision },
    })),
  };
}

function delta(overrides: object = {}) {
  return {
    schema_version: 2,
    organization_id: "organization-1",
    base_revision: 1,
    revision: 2,
    providers: { upserts: [], deletes: [] },
    models: { upserts: [], deletes: [] },
    agents: { upserts: [], deletes: [] },
    organization_budget: null,
    ...overrides,
  };
}

function setup(
  repository = new MemoryConfigurationRepository(),
  overrides: Partial<ExecutionDirectoryDependencies> = {},
) {
  const clients = new ProviderClients({
    complete: () => Promise.reject(new Error("No model should be called")),
  });
  const onApplied = vi.fn<ExecutionDirectoryDependencies["onApplied"]>(() => Promise.resolve());
  const onUnavailable = vi.fn<ExecutionDirectoryDependencies["onUnavailable"]>();
  const beforeAck = vi.fn(() => Promise.resolve());
  const beforePeerAck = vi.fn(() => Promise.resolve());
  const connections = runtimeConnections();
  const directory = new ExecutionDirectory({
    repository,
    clients,
    runtimeConnections: connections,
    onApplied,
    beforeAck,
    beforePeerAck,
    onUnavailable,
    ...overrides,
  });
  return {
    repository,
    clients,
    connections,
    onApplied,
    onUnavailable,
    beforeAck,
    beforePeerAck,
    directory,
  };
}

describe("execution publication v2 consumer", () => {
  it("republishes a legacy capture on an equal-revision v1-to-v2 upgrade", async () => {
    const repository = new MemoryConfigurationRepository();
    const onApplied = vi.fn<ExecutionDirectoryDependencies["onApplied"]>(() => Promise.resolve());
    const onUnavailable = vi.fn<ExecutionDirectoryDependencies["onUnavailable"]>();
    const directory = new ExecutionDirectory({
      repository,
      clients: new ProviderClients({
        complete: () => Promise.reject(new Error("No model should be called")),
      }),
      runtimeConnections: runtimeConnections(),
      onApplied,
      onUnavailable,
    });
    await directory.apply(executionConfiguration());
    expect(onApplied).toHaveBeenCalledTimes(1);
    await directory.apply(v2Fixture());
    expect(onApplied).toHaveBeenCalledTimes(2);
    const digest = await directory.getDigest({ organization_id: "organization-1" });
    expect(digest.schema_version).toBe(2);
    expect(digest.revision).toBe(1);
    await directory.apply(v2Fixture());
    expect(onApplied).toHaveBeenCalledTimes(2);
  });

  it("applies a full secret-free v2 snapshot without Provider plaintext", async () => {
    const { directory, repository } = setup();
    const applied = await directory.apply(v2Fixture());
    expect(applied).toEqual({ organization_id: "organization-1", applied_revision: 1 });
    const authority = await repository.loadAuthority("organization-1");
    expect(JSON.stringify(authority)).not.toContain("synthetic-provider-key");
    expect(JSON.stringify(await repository.load("organization-1"))).not.toContain("schema_version");
  });

  it("applies an atomic delta retaining unchanged private authority and Runtime tokens", async () => {
    const { directory, repository } = setup();
    const fixture = v2Fixture();
    await directory.apply(fixture);
    const before = await repository.loadAuthority("organization-1");
    const extra = structuredClone(fixture.agents[0]!);
    extra.agent_id = "agent-2";
    extra.runtime = runtimeConfiguration(2);
    const applied = await directory.applyDelta(
      delta({ agents: { upserts: [extra], deletes: [] } }),
    );
    expect(applied.applied_revision).toBe(2);
    const authority = await repository.loadAuthority("organization-1");
    const agents = (
      authority as {
        agents: { agent_id: string; runtime: { credential?: { token: string } } | null }[];
      }
    ).agents;
    const retained = agents.find((agent) => agent.agent_id === "agent-1");
    const upserted = agents.find((agent) => agent.agent_id === "agent-2");
    expect(retained).toBeDefined();
    expect(retained!.runtime!.credential!.token).toBe(
      (
        before as {
          agents: { agent_id: string; runtime: { credential?: { token: string } } | null }[];
        }
      ).agents.find((agent) => agent.agent_id === "agent-1")!.runtime!.credential!.token,
    );
    expect(upserted).toBeDefined();
    expect((authority as { revision: number }).revision).toBe(2);
  });

  it("rejects a stale or absent delta base without saving", async () => {
    const { directory, repository } = setup();
    await directory.apply(v2Fixture());
    const saves = repository.save.mock.calls.length;
    await expect(
      directory.applyDelta(delta({ base_revision: 2, revision: 3 })),
    ).rejects.toMatchObject({
      code: "configuration_base_mismatch",
    });
    expect(repository.save.mock.calls.length).toBe(saves);
    const empty = setup();
    await expect(empty.directory.applyDelta(delta())).rejects.toMatchObject({
      code: "configuration_base_mismatch",
    });
    expect(empty.repository.save).not.toHaveBeenCalled();
  });

  it("serializes concurrent deltas so exactly one commits", async () => {
    const { directory, repository } = setup();
    await directory.apply(v2Fixture());
    const saves = repository.save.mock.calls.length;
    const extra = structuredClone(v2Fixture().agents[0]!);
    extra.agent_id = "agent-2";
    extra.runtime = runtimeConfiguration(2);
    const first = directory.applyDelta(delta({ agents: { upserts: [extra], deletes: [] } }));
    const second = directory.applyDelta(delta({ revision: 2 }));
    const results = await Promise.allSettled([first, second]);
    const succeeded = results.filter((result) => result.status === "fulfilled");
    const mismatched = results.filter(
      (result) =>
        result.status === "rejected" &&
        (result.reason as { code?: string }).code === "configuration_base_mismatch",
    );
    const superseded = results.filter(
      (result) =>
        result.status === "rejected" &&
        (result.reason as { code?: string }).code === "configuration_unavailable",
    );
    expect(mismatched).toHaveLength(1);
    expect(succeeded.length + superseded.length).toBe(1);
    expect(repository.save.mock.calls.length).toBe(saves + 1);
    expect((await repository.loadAuthority("organization-1"))!.revision).toBe(2);
  });

  it("treats a missing sealed authority with a public projection as unavailable", async () => {
    const repository = new MemoryConfigurationRepository();
    repository.records.set(
      "organization-1",
      publicExecutionConfiguration(executionConfiguration()),
    );
    const { directory } = setup(repository);
    await expect(directory.getDigest({ organization_id: "organization-1" })).rejects.toMatchObject({
      code: "configuration_unavailable",
    });
  });

  it("rejects a delta against a legacy authority", async () => {
    const { directory } = setup();
    await directory.apply(executionConfiguration());
    await expect(directory.applyDelta(delta())).rejects.toMatchObject({
      code: "configuration_base_mismatch",
    });
  });

  it("returns a digest only after owner proof on every call", async () => {
    const { directory, beforeAck, beforePeerAck, onApplied } = setup();
    await directory.apply(v2Fixture());
    expect(onApplied).toHaveBeenCalledTimes(1);
    for (let round = 0; round < 2; round++) {
      const digest = await directory.getDigest({ organization_id: "organization-1" });
      expect(digest.schema_version).toBe(2);
      expect(digest.revision).toBe(1);
      expect(digest.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(digest)).not.toContain("synthetic-provider-key");
    }
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(beforeAck).toHaveBeenCalledTimes(3);
    expect(beforePeerAck).toHaveBeenCalledTimes(3);
  });

  it("reconciles an unavailable owner on an unchanged digest without replacing sealed authority", async () => {
    let lost = false;
    const f = setup(undefined, { needsOwnershipRefresh: () => lost });
    await f.directory.apply(v2Fixture());
    const publication = f.directory.capturePublication("organization-1");
    lost = true;
    f.beforeAck.mockImplementation(() =>
      lost
        ? Promise.reject(new DomainError("agent_unavailable", "Owner recovery pending"))
        : Promise.resolve(),
    );
    f.onApplied.mockImplementation(() => {
      lost = false;
      return Promise.resolve();
    });
    const digest = await f.directory.getDigest({ organization_id: "organization-1" });
    expect(digest.revision).toBe(1);
    expect(f.onApplied).toHaveBeenCalledTimes(2);
    expect(f.repository.save).toHaveBeenCalledTimes(1);
    expect(f.directory.capturePublication("organization-1")).toBe(publication);
    await f.directory.getDigest({ organization_id: "organization-1" });
    expect(f.onApplied).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge a digest after failed owner reconciliation", async () => {
    let lost = false;
    const f = setup(undefined, { needsOwnershipRefresh: () => lost });
    await f.directory.apply(v2Fixture());
    const proofs = f.beforePeerAck.mock.calls.length;
    lost = true;
    f.onApplied.mockRejectedValueOnce(
      new DomainError("agent_unavailable", "Owner recovery pending"),
    );
    await expect(
      f.directory.getDigest({ organization_id: "organization-1" }),
    ).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(f.beforePeerAck).toHaveBeenCalledTimes(proofs);
    expect(f.repository.save).toHaveBeenCalledTimes(1);
  });

  it("restores a cold durable authority for a digest and distinguishes storage failure from absence", async () => {
    const repository = new MemoryConfigurationRepository();
    const { directory, beforePeerAck, onApplied } = setup(repository);
    const absent = await directory.getDigest({ organization_id: "organization-1" });
    expect(absent.schema_version).toBe(0);
    expect(absent.digest).toBeNull();
    expect(beforePeerAck).not.toHaveBeenCalled();
    const v2 = v2Fixture();
    repository.commit(v2 as ExecutionConfiguration);
    const digest = await directory.getDigest({ organization_id: "organization-1" });
    expect(digest.revision).toBe(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(beforePeerAck).toHaveBeenCalledTimes(1);
    const failing = new MemoryConfigurationRepository();
    failing.loadAuthority = () => Promise.reject(new Error("storage failed"));
    const broken = setup(failing);
    await expect(broken.directory.getDigest({ organization_id: "organization-1" })).rejects.toThrow(
      "storage failed",
    );
    expect(broken.beforePeerAck).not.toHaveBeenCalled();
  });

  it("fails the digest when owner proof fails", async () => {
    const { directory, beforePeerAck } = setup();
    await directory.apply(v2Fixture());
    beforePeerAck.mockRejectedValueOnce(new DomainError("ownership_lost", "lost"));
    await expect(directory.getDigest({ organization_id: "organization-1" })).rejects.toMatchObject({
      code: "ownership_lost",
    });
  });
});
