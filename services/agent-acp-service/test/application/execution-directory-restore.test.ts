import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
import {
  InvalidExecutionAuthorityError,
  type ExecutionConfigurationRepository,
} from "../../src/ports/execution-configuration.js";
import type { AuthenticatedModelTransport } from "../../src/ports/model.js";
import {
  closedExecutionAgent,
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../fixtures/execution-configuration.js";
import { runtimeConnections } from "../support/runtime-connections.js";

class StoredConfigurations implements ExecutionConfigurationRepository {
  public readonly records = new Map<string, PublicExecutionConfiguration>();
  public readonly authorities = new Map<string, ExecutionConfiguration>();
  public readonly load = vi.fn((organizationId: string) =>
    Promise.resolve(structuredClone(this.records.get(organizationId) ?? null)),
  );
  public readonly loadAuthority = vi.fn((organizationId: string) =>
    Promise.resolve(structuredClone(this.authorities.get(organizationId) ?? null)),
  );
  public readonly listOrganizations = vi.fn(() => Promise.resolve([...this.records.keys()].sort()));
  public readonly save = vi.fn(
    (configuration: ExecutionConfiguration, expectedRevision: number | null) => {
      if ((this.records.get(configuration.organization_id)?.revision ?? null) !== expectedRevision)
        return Promise.resolve(false);
      this.commit(configuration);
      return Promise.resolve(true);
    },
  );

  public commit(configuration: ExecutionConfiguration): void {
    this.records.set(
      configuration.organization_id,
      structuredClone(publicExecutionConfiguration(configuration)),
    );
    this.authorities.set(configuration.organization_id, structuredClone(configuration));
  }
}

function setup(repository = new StoredConfigurations()) {
  const complete = vi.fn<AuthenticatedModelTransport["complete"]>(() =>
    Promise.reject(new Error("Restoration must not execute a model request")),
  );
  const clients = new ProviderClients({ complete });
  const connections = runtimeConnections();
  const prepare = vi.spyOn(connections, "prepare");
  const onApplied = vi.fn<ExecutionDirectoryDependencies["onApplied"]>(() => Promise.resolve());
  const onUnavailable = vi.fn<ExecutionDirectoryDependencies["onUnavailable"]>();
  const onPublished = vi.fn<NonNullable<ExecutionDirectoryDependencies["onPublished"]>>();
  const onInvalidAuthority =
    vi.fn<NonNullable<ExecutionDirectoryDependencies["onInvalidAuthority"]>>();
  const directory = new ExecutionDirectory({
    repository,
    clients,
    runtimeConnections: connections,
    onApplied,
    onUnavailable,
    onPublished,
    onInvalidAuthority,
  });
  return {
    repository,
    complete,
    clients,
    connections,
    prepare,
    onApplied,
    onUnavailable,
    onPublished,
    onInvalidAuthority,
    directory,
  };
}

async function restore(
  directory: ExecutionDirectory,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  await (
    directory as ExecutionDirectory & {
      restore(signal: AbortSignal): Promise<void>;
    }
  ).restore(signal);
}

function binding(configuration: ExecutionConfiguration) {
  return resolveExecutionConfiguration(
    publicExecutionConfiguration(configuration),
    { ...executionIdentity(), organizationId: configuration.organization_id },
    {},
  ).runtime;
}

describe("execution directory warm restoration", () => {
  it("restores the latest full private snapshot without saving or Controller publication", async () => {
    const test = setup();
    const initial = executionConfiguration();
    test.repository.commit(parseExecutionConfiguration(initial));
    const latest = executionConfiguration();
    latest.revision = 2;
    latest.providers[0]!.credential_revision = "credential-2";
    latest.providers[0]!.credential.secret = "synthetic-restored-provider-key";
    latest.agents[0]!.runtime = runtimeConfiguration(2);
    const configuration = parseExecutionConfiguration(latest);
    test.repository.commit(configuration);

    await expect(restore(test.directory)).resolves.toBeUndefined();

    expect(test.repository.loadAuthority).toHaveBeenCalledWith(configuration.organization_id);
    expect(test.repository.save).not.toHaveBeenCalled();
    expect(test.directory.inspect(executionIdentity()).configuration).toEqual(
      publicExecutionConfiguration(configuration),
    );
    await expect(
      test.directory.withAccess(executionIdentity(), ({ configuration: current }) =>
        Promise.resolve(current.revision),
      ),
    ).resolves.toBe(2);
    const reference = binding(configuration);
    expect(() => test.connections.fetchFor(reference)).not.toThrow();
    expect(test.directory.runtimeForCleanup(executionIdentity())).toEqual(reference);
    expect(readdirSync(test.connections.directory)).toEqual([reference.connectionId]);
    const senderDirectory = join(test.connections.directory, reference.connectionId);
    const senderFile = join(senderDirectory, "antnest-runtime");
    expect(statSync(senderDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(senderFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(senderFile, "utf8")).toBe(
      configuration.agents[0]!.runtime!.credential!.token,
    );
    const provider = test.clients.acquire(configuration.organization_id, "provider-1");
    try {
      expect(provider.signal.aborted).toBe(false);
    } finally {
      provider.release();
    }
    expect(test.onApplied).toHaveBeenCalledExactlyOnceWith(
      publicExecutionConfiguration(configuration),
    );
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("keeps legacy and invalid organizations closed while restoring a healthy organization", async () => {
    const test = setup();
    const legacy = parseExecutionConfiguration(executionConfiguration());
    legacy.organization_id = "organization-1-legacy";
    test.repository.records.set(legacy.organization_id, publicExecutionConfiguration(legacy));
    const invalid = parseExecutionConfiguration(executionConfiguration());
    invalid.organization_id = "organization-2-invalid";
    invalid.agents[0]!.runtime = runtimeConfiguration(2);
    test.repository.commit(invalid);
    const healthy = parseExecutionConfiguration(executionConfiguration());
    healthy.organization_id = "organization-3-healthy";
    healthy.agents[0]!.runtime = runtimeConfiguration(3);
    test.repository.commit(healthy);
    test.repository.loadAuthority.mockImplementation((organizationId) => {
      if (organizationId === invalid.organization_id)
        return Promise.reject(new InvalidExecutionAuthorityError());
      return Promise.resolve(
        structuredClone(test.repository.authorities.get(organizationId) ?? null),
      );
    });

    await expect(restore(test.directory)).resolves.toBeUndefined();

    for (const unavailable of [legacy, invalid]) {
      const identity = { ...executionIdentity(), organizationId: unavailable.organization_id };
      expect(() => test.directory.inspect(identity)).toThrow(
        expect.objectContaining({ code: "configuration_not_ready" }),
      );
      expect(test.directory.runtimeForCleanup(identity)).toBeNull();
      expect(() => test.connections.fetchFor(binding(unavailable))).toThrow();
    }
    const identity = { ...executionIdentity(), organizationId: healthy.organization_id };
    expect(test.directory.inspect(identity).configuration).toEqual(
      publicExecutionConfiguration(healthy),
    );
    expect(() => test.connections.fetchFor(binding(healthy))).not.toThrow();
    expect(readdirSync(test.connections.directory)).toEqual([binding(healthy).connectionId]);
    const provider = test.clients.acquire(healthy.organization_id, "provider-1");
    try {
      expect(provider.signal.aborted).toBe(false);
    } finally {
      provider.release();
    }
    expect(test.repository.save).not.toHaveBeenCalled();
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("isolates a cross-organization Runtime connection identity conflict while preserving healthy organizations", async () => {
    const test = setup();
    const first = executionConfiguration();
    first.organization_id = "organization-a";
    const conflicting = executionConfiguration();
    conflicting.organization_id = "organization-b";
    conflicting.agents[0]!.runtime = runtimeConfiguration(2);
    conflicting.agents[0]!.runtime.connection_id = first.agents[0]!.runtime!.connection_id;
    const last = executionConfiguration();
    last.organization_id = "organization-c";
    last.agents[0]!.runtime = runtimeConfiguration(3);
    const configurations = [first, conflicting, last].map(parseExecutionConfiguration);
    for (const configuration of configurations) test.repository.commit(configuration);

    await expect(restore(test.directory)).resolves.toBeUndefined();

    expect(test.prepare.mock.calls.map(([configuration]) => configuration.organization_id)).toEqual(
      [first.organization_id, conflicting.organization_id, last.organization_id],
    );
    expect(test.onInvalidAuthority).toHaveBeenCalledExactlyOnceWith(conflicting.organization_id);
    const denied = { ...executionIdentity(), organizationId: conflicting.organization_id };
    expect(() => test.directory.inspect(denied)).toThrow(
      expect.objectContaining({ code: "configuration_not_ready" }),
    );
    expect(test.directory.runtimeForCleanup(denied)).toBeNull();
    expect(() => test.connections.fetchFor(binding(configurations[1]!))).toThrow();
    expect(() => test.clients.acquire(conflicting.organization_id, "provider-1")).toThrow(
      expect.objectContaining({ code: "provider_unavailable" }),
    );
    for (const configuration of [configurations[0]!, configurations[2]!]) {
      const identity = { ...executionIdentity(), organizationId: configuration.organization_id };
      expect(test.directory.inspect(identity).configuration).toEqual(
        publicExecutionConfiguration(configuration),
      );
      const reference = binding(configuration);
      expect(() => test.connections.fetchFor(reference)).not.toThrow();
      expect(test.directory.runtimeForCleanup(identity)).toEqual(reference);
      expect(
        readFileSync(
          join(test.connections.directory, reference.connectionId, "antnest-runtime"),
          "utf8",
        ),
      ).toBe(configuration.agents[0]!.runtime!.credential!.token);
      const provider = test.clients.acquire(configuration.organization_id, "provider-1");
      try {
        expect(provider.signal.aborted).toBe(false);
      } finally {
        provider.release();
      }
    }
    expect(readdirSync(test.connections.directory).sort()).toEqual(
      [binding(configurations[0]!).connectionId, binding(configurations[2]!).connectionId].sort(),
    );
    expect(test.onPublished.mock.calls).toEqual([[first.organization_id], [last.organization_id]]);
    expect(test.repository.save).not.toHaveBeenCalled();
    expect(test.complete).not.toHaveBeenCalled();
  });

  it.each(["closed", "empty"] as const)(
    "does not make a legitimate %s snapshot executable",
    async (kind) => {
      const test = setup();
      const configuration = parseExecutionConfiguration(executionConfiguration());
      if (kind === "closed") {
        configuration.agents[0] = closedExecutionAgent(configuration.agents[0]!);
      } else {
        configuration.agents = [];
        configuration.models = [];
        configuration.providers = [];
      }
      test.repository.commit(configuration);

      await expect(restore(test.directory)).resolves.toBeUndefined();

      await expect(
        test.directory.withAccess(executionIdentity(), ({ configuration: current }) =>
          Promise.resolve(resolveExecutionConfiguration(current, executionIdentity(), {})),
        ),
      ).rejects.toMatchObject({
        code: kind === "closed" ? "agent_unavailable" : "access_denied",
      });
      expect(test.directory.runtimeForCleanup(executionIdentity())).toBeNull();
      expect(readdirSync(test.connections.directory)).toEqual([]);
      expect(test.repository.save).not.toHaveBeenCalled();
      expect(test.complete).not.toHaveBeenCalled();
    },
  );

  it("propagates global storage failures from organization listing and authority reads", async () => {
    for (const method of ["listOrganizations", "loadAuthority"] as const) {
      const test = setup();
      test.repository.commit(parseExecutionConfiguration(executionConfiguration()));
      const failure = new Error("synthetic storage dependency failed: " + method);
      test.repository[method].mockRejectedValueOnce(failure);

      await expect(restore(test.directory)).rejects.toBe(failure);

      expect(() => test.directory.inspect(executionIdentity())).toThrow(
        expect.objectContaining({ code: "configuration_not_ready" }),
      );
      expect(test.onPublished).not.toHaveBeenCalled();
      expect(readdirSync(test.connections.directory)).toEqual([]);
      expect(test.repository.save).not.toHaveBeenCalled();
      expect(test.complete).not.toHaveBeenCalled();
    }
  });

  it("joins a held authority read after abort without preparing or publishing late authority", async () => {
    const test = setup();
    const configuration = parseExecutionConfiguration(executionConfiguration());
    test.repository.commit(configuration);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ExecutionConfiguration | null>();
    test.repository.loadAuthority.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const stop = new AbortController();
    const aborted = new DOMException("synthetic restoration cancelled", "AbortError");
    let settled = false;
    const result = restore(test.directory, stop.signal)
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error("Restoration settled before its held authority read");
        }),
      ]);
      stop.abort(aborted);
      await nextTurn();
      expect(settled).toBe(false);
      expect(test.prepare).not.toHaveBeenCalled();
      expect(test.onApplied).not.toHaveBeenCalled();
      expect(test.onPublished).not.toHaveBeenCalled();
    } finally {
      stop.abort(aborted);
      release.resolve(configuration);
      await result;
    }

    expect(settled).toBe(true);
    expect(await result).toBe(aborted);
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.onApplied).not.toHaveBeenCalled();
    expect(test.onPublished).not.toHaveBeenCalled();
    expect(() => test.directory.inspect(executionIdentity())).toThrow(
      expect.objectContaining({ code: "configuration_not_ready" }),
    );
    expect(test.directory.runtimeForCleanup(executionIdentity())).toBeNull();
    expect(readdirSync(test.connections.directory)).toEqual([]);
    expect(test.repository.save).not.toHaveBeenCalled();
    expect(test.complete).not.toHaveBeenCalled();
  });

  it.each(["newer", "closed"] as const)(
    "rolls back stale senders when storage changes to a %s revision during publication",
    async (kind) => {
      const test = setup();
      const initial = parseExecutionConfiguration(executionConfiguration());
      test.repository.commit(initial);
      const previous = binding(initial);
      const replacement = structuredClone(initial);
      replacement.revision = 2;
      replacement.agents[0]!.runtime = runtimeConfiguration(2);
      if (kind === "closed") replacement.agents[0] = closedExecutionAgent(replacement.agents[0]!);
      const publishedRevisions: number[] = [];
      test.onPublished.mockImplementation(() => {
        publishedRevisions.push(test.directory.inspect(executionIdentity()).configuration.revision);
      });
      test.onApplied.mockImplementationOnce((configuration) => {
        expect(configuration.revision).toBe(1);
        expect(existsSync(join(test.connections.directory, previous.connectionId))).toBe(true);
        test.repository.commit(replacement);
        return Promise.resolve();
      });

      // The stale organization may remain closed or restore the newer snapshot;
      // neither outcome may publish the original authority.
      await restore(test.directory).then(
        () => null,
        (error: unknown) => error,
      );

      expect(test.onApplied).toHaveBeenCalled();
      expect(test.prepare).toHaveBeenCalledWith(initial);
      expect(publishedRevisions).not.toContain(1);
      expect(test.repository.records.get(initial.organization_id)?.revision).toBe(2);
      expect(existsSync(join(test.connections.directory, previous.connectionId))).toBe(false);
      expect(() => test.connections.fetchFor(previous)).toThrow();
      expect(test.directory.runtimeForCleanup(executionIdentity())).not.toEqual(previous);
      try {
        const restored = test.directory.inspect(executionIdentity());
        expect(restored.configuration.revision).toBe(2);
        if (kind === "closed") expect(restored.agent.accepting_runs).toBe(false);
        else
          expect(restored.agent.runtime?.runtime_revision).toBe(
            replacement.agents[0]!.runtime!.runtime_revision,
          );
      } catch (error) {
        expect(error).toMatchObject({ code: "configuration_not_ready" });
      }
      expect(test.repository.save).not.toHaveBeenCalled();
      expect(test.complete).not.toHaveBeenCalled();
    },
  );
});
