import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionDirectory,
  type ExecutionDirectoryDependencies,
} from "../../src/application/execution-directory.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import {
  publicExecutionConfiguration,
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

function setup() {
  const repository = new StoredConfigurations();
  const complete = vi.fn(() =>
    Promise.reject(new Error("Ownership refresh must not call a model")),
  );
  const clients = new ProviderClients({ complete });
  const connections = runtimeConnections();
  const applyClients = vi.spyOn(clients, "apply");
  const prepareConnections = vi.spyOn(connections, "prepare");
  const revokeConnections = vi.spyOn(connections, "revokePublication");
  const onApplied = vi.fn<ExecutionDirectoryDependencies["onApplied"]>(() => Promise.resolve());
  const onPublished = vi.fn<(organizationId: string) => void>();
  const onUnavailable = vi.fn<(organizationId: string) => void>();
  const onOwnershipRefreshed = vi.fn<(organizationId: string) => void>();
  const directory = new ExecutionDirectory({
    repository,
    clients,
    runtimeConnections: connections,
    onApplied,
    onPublished,
    onUnavailable,
    onOwnershipRefreshed,
  });
  const clear = () => {
    for (const mock of [
      repository.load,
      repository.loadAuthority,
      repository.listOrganizations,
      repository.save,
      applyClients,
      prepareConnections,
      revokeConnections,
      onApplied,
      onPublished,
      onUnavailable,
      onOwnershipRefreshed,
    ])
      mock.mockClear();
  };
  return {
    repository,
    complete,
    clients,
    connections,
    applyClients,
    prepareConnections,
    revokeConnections,
    onApplied,
    onPublished,
    onUnavailable,
    onOwnershipRefreshed,
    directory,
    clear,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("execution ownership refresh without republishing", () => {
  it("reconciles the original capture without invalidating connections or publishing it again", async () => {
    const f = setup();
    const initial = executionConfiguration();
    await f.directory.apply(initial);
    const capture = f.directory.capturePublication(initial.organization_id);
    const binding = f.directory.runtimeForCleanup(executionIdentity());
    const provider = f.clients.acquire(initial.organization_id, "provider-1");
    const invalidated = vi.fn();
    const unsubscribe = f.directory.subscribe(initial.organization_id, invalidated);
    f.clear();
    try {
      await f.directory.reconcileOwnership(new AbortController().signal);
      expect(f.onApplied).toHaveBeenCalledExactlyOnceWith(capture.configuration);
      expect(f.onApplied.mock.calls[0]![0]).toBe(capture.configuration);
      expect(f.repository.loadAuthority).toHaveBeenCalledTimes(2);
      expect(f.onOwnershipRefreshed).toHaveBeenCalledExactlyOnceWith(initial.organization_id);
      expect(f.directory.capturePublication(initial.organization_id)).toBe(capture);
      expect(() => capture.assertCurrent()).not.toThrow();
      expect(f.directory.runtimeForCleanup(executionIdentity())).toEqual(binding);
      expect(provider.signal.aborted).toBe(false);
      expect(invalidated).not.toHaveBeenCalled();
      expect(f.onPublished).not.toHaveBeenCalled();
      expect(f.onUnavailable).not.toHaveBeenCalled();
      expect(f.repository.save).not.toHaveBeenCalled();
      expect(f.applyClients).not.toHaveBeenCalled();
      expect(f.prepareConnections).not.toHaveBeenCalled();
      expect(f.revokeConnections).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      provider.release();
    }
  });

  it("refreshes a selected organization or all local publications and ignores database-only organizations", async () => {
    const f = setup();
    const first = executionConfiguration();
    const second = executionConfiguration();
    second.organization_id = "organization-2";
    second.agents[0]!.runtime = runtimeConfiguration(2);
    const unpublished = executionConfiguration();
    unpublished.organization_id = "organization-3";
    unpublished.agents[0]!.runtime = runtimeConfiguration(3);
    f.repository.commit(unpublished);
    await f.directory.apply(first);
    await f.directory.apply(second);
    const captures = [first, second].map((configuration) =>
      f.directory.capturePublication(configuration.organization_id),
    );
    f.clear();

    await f.directory.reconcileOwnership(new AbortController().signal, first.organization_id);
    expect(f.onApplied).toHaveBeenCalledExactlyOnceWith(captures[0]!.configuration);
    expect(f.onOwnershipRefreshed).toHaveBeenCalledExactlyOnceWith(first.organization_id);
    expect(f.repository.loadAuthority.mock.calls.map(([organizationId]) => organizationId)).toEqual(
      [first.organization_id, first.organization_id],
    );
    f.clear();

    await f.directory.reconcileOwnership(new AbortController().signal);
    expect(
      f.onApplied.mock.calls.map(([configuration]) => configuration.organization_id).sort(),
    ).toEqual([first.organization_id, second.organization_id]);
    expect(
      f.onOwnershipRefreshed.mock.calls.map(([organizationId]) => organizationId).sort(),
    ).toEqual([first.organization_id, second.organization_id]);
    expect(
      f.repository.loadAuthority.mock.calls.map(([organizationId]) => organizationId).sort(),
    ).toEqual([
      first.organization_id,
      first.organization_id,
      second.organization_id,
      second.organization_id,
    ]);
    expect(f.repository.listOrganizations).not.toHaveBeenCalled();
    for (const [index, configuration] of [first, second].entries())
      expect(f.directory.capturePublication(configuration.organization_id)).toBe(captures[index]);
    f.clear();

    await f.directory.reconcileOwnership(new AbortController().signal, unpublished.organization_id);
    expect(f.repository.loadAuthority).not.toHaveBeenCalled();
    expect(f.onApplied).not.toHaveBeenCalled();
    expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
    expect(f.onPublished).not.toHaveBeenCalled();
  });

  it.each(["missing", "provider secret", "Runtime token"] as const)(
    "skips an old capture when its stored sealed authority differs in %s",
    async (difference) => {
      const f = setup();
      const initial = executionConfiguration();
      await f.directory.apply(initial);
      const capture = f.directory.capturePublication(initial.organization_id);
      if (difference === "missing") f.repository.authorities.delete(initial.organization_id);
      else {
        const changed = structuredClone(initial);
        if (difference === "provider secret") changed.providers[0]!.credential.secret += "-changed";
        else
          changed.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 9).toString("base64url");
        expect(publicExecutionConfiguration(changed)).toEqual(capture.configuration);
        f.repository.commit(changed);
      }
      const invalidated = vi.fn();
      const unsubscribe = f.directory.subscribe(initial.organization_id, invalidated);
      f.clear();
      try {
        await expect(
          f.directory.reconcileOwnership(new AbortController().signal),
        ).resolves.toBeUndefined();
        expect(f.onApplied).not.toHaveBeenCalled();
        expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
        expect(f.onPublished).not.toHaveBeenCalled();
        expect(f.onUnavailable).not.toHaveBeenCalled();
        expect(invalidated).not.toHaveBeenCalled();
        expect(f.directory.capturePublication(initial.organization_id)).toBe(capture);
        expect(() => capture.assertCurrent()).not.toThrow();
      } finally {
        unsubscribe();
      }
    },
  );

  it("rechecks sealed authority after the original prepare before announcing refreshed ownership", async () => {
    const f = setup();
    const initial = executionConfiguration();
    await f.directory.apply(initial);
    const capture = f.directory.capturePublication(initial.organization_id);
    f.clear();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.onApplied.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    let refreshing: Promise<void> | undefined;
    try {
      refreshing = f.directory.reconcileOwnership(new AbortController().signal);
      void refreshing.catch(() => undefined);
      await Promise.race([
        entered.promise,
        refreshing.then(() => {
          throw new Error("Ownership refresh bypassed original prepare");
        }),
      ]);
      const changed = structuredClone(initial);
      changed.providers[0]!.credential.secret += "-changed-while-preparing";
      expect(publicExecutionConfiguration(changed)).toEqual(capture.configuration);
      f.repository.commit(changed);
      expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
      release.resolve();
      // A post-prepare mismatch may skip or reject the refresh, but it must
      // never start the graph against authority different from its capture.
      await Promise.allSettled([refreshing]);
      expect(f.repository.loadAuthority).toHaveBeenCalledTimes(2);
      expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
      expect(f.onPublished).not.toHaveBeenCalled();
      expect(f.onUnavailable).toHaveBeenCalledWith(initial.organization_id);
      expect(() => f.directory.capturePublication(initial.organization_id)).toThrow();
      expect(() => capture.assertCurrent()).toThrow();
    } finally {
      release.resolve();
      await Promise.allSettled([refreshing]);
    }
  });

  it.each(["changed", "unchanged"] as const)(
    "joins failed prepare and retains its original error when sealed authority is %s",
    async (authority) => {
      const f = setup();
      const initial = executionConfiguration();
      await f.directory.apply(initial);
      const capture = f.directory.capturePublication(initial.organization_id);
      const binding = f.directory.runtimeForCleanup(executionIdentity());
      const provider = f.clients.acquire(initial.organization_id, "provider-1");
      const invalidated = vi.fn();
      const unsubscribe = f.directory.subscribe(initial.organization_id, invalidated);
      f.clear();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const sentinel = new Error("Original ownership prepare failed after partial graph creation");
      let originalFinished = false;
      let returned = false;
      f.onApplied.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        originalFinished = true;
        throw sentinel;
      });
      const retainsOriginal = (error: unknown): boolean => {
        if (error === sentinel) return true;
        if (error instanceof AggregateError && error.errors.some(retainsOriginal)) return true;
        return error instanceof Error && error.cause !== undefined && retainsOriginal(error.cause);
      };
      let refreshing: Promise<void> | undefined;
      try {
        refreshing = f.directory.reconcileOwnership(new AbortController().signal).finally(() => {
          returned = true;
        });
        void refreshing.catch(() => undefined);
        await Promise.race([
          entered.promise,
          refreshing.then(() => {
            throw new Error("Ownership refresh bypassed failed original prepare");
          }),
        ]);
        if (authority === "changed") {
          const changed = structuredClone(initial);
          changed.providers[0]!.credential.secret += "-changed-before-prepare-failed";
          expect(publicExecutionConfiguration(changed)).toEqual(capture.configuration);
          f.repository.commit(changed);
        }
        await nextTurn();
        expect(originalFinished).toBe(false);
        expect(returned).toBe(false);
        expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
        expect(f.onUnavailable).not.toHaveBeenCalled();
        expect(invalidated).not.toHaveBeenCalled();
        release.resolve();
        const [outcome] = await Promise.allSettled([refreshing]);
        expect(originalFinished).toBe(true);
        expect(returned).toBe(true);
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(retainsOriginal(outcome.reason)).toBe(true);
        expect(f.repository.loadAuthority).toHaveBeenCalledTimes(2);
        expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
        expect(f.onPublished).not.toHaveBeenCalled();
        expect(f.repository.save).not.toHaveBeenCalled();
        expect(f.applyClients).not.toHaveBeenCalled();
        expect(f.prepareConnections).not.toHaveBeenCalled();
        if (authority === "changed") {
          expect(f.onUnavailable).toHaveBeenCalledExactlyOnceWith(initial.organization_id);
          expect(f.revokeConnections).toHaveBeenCalledExactlyOnceWith(initial.organization_id);
          expect(invalidated).toHaveBeenCalledOnce();
          expect(() => f.directory.capturePublication(initial.organization_id)).toThrow();
          expect(() => capture.assertCurrent()).toThrow();
        } else {
          expect(f.onUnavailable).not.toHaveBeenCalled();
          expect(f.revokeConnections).not.toHaveBeenCalled();
          expect(invalidated).not.toHaveBeenCalled();
          expect(f.directory.capturePublication(initial.organization_id)).toBe(capture);
          expect(() => capture.assertCurrent()).not.toThrow();
          expect(f.directory.runtimeForCleanup(executionIdentity())).toEqual(binding);
          expect(provider.signal.aborted).toBe(false);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([refreshing]);
        unsubscribe();
        provider.release();
      }
    },
  );

  it("waits for the original prepare to finish after abort before rejecting and releases its queue", async () => {
    const f = setup();
    const initial = executionConfiguration();
    await f.directory.apply(initial);
    const capture = f.directory.capturePublication(initial.organization_id);
    f.clear();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let originalFinished = false;
    let returned = false;
    f.onApplied.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      originalFinished = true;
    });
    const abort = new AbortController();
    const reason = new Error("cancel ownership refresh");
    let refreshing: Promise<void> | undefined;
    try {
      refreshing = f.directory.reconcileOwnership(abort.signal).finally(() => {
        returned = true;
      });
      void refreshing.catch(() => undefined);
      await Promise.race([
        entered.promise,
        refreshing.then(() => {
          throw new Error("Ownership refresh bypassed held original prepare");
        }),
      ]);
      abort.abort(reason);
      await nextTurn();
      expect(originalFinished).toBe(false);
      expect(returned).toBe(false);
      expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
      release.resolve();
      await expect(refreshing).rejects.toBe(reason);
      expect(originalFinished).toBe(true);
      expect(f.onPublished).not.toHaveBeenCalled();
      expect(f.onUnavailable).not.toHaveBeenCalled();
      expect(f.directory.capturePublication(initial.organization_id)).toBe(capture);
      expect(() => capture.assertCurrent()).not.toThrow();
      await f.directory.reconcileOwnership(new AbortController().signal);
      expect(f.onOwnershipRefreshed).toHaveBeenCalledExactlyOnceWith(initial.organization_id);
    } finally {
      release.resolve();
      await Promise.allSettled([refreshing]);
    }
  });

  it.each(["refresh", "publication"] as const)(
    "takes the current capture inside the organization queue when %s starts first",
    async (first) => {
      const f = setup();
      const initial = executionConfiguration();
      await f.directory.apply(initial);
      const newer = structuredClone(initial);
      newer.revision = 2;
      const invalidated = vi.fn();
      const unsubscribe = f.directory.subscribe(initial.organization_id, invalidated);
      f.clear();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.onApplied.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      let refreshing: Promise<void> | undefined;
      let publishing: ReturnType<ExecutionDirectory["apply"]> | undefined;
      try {
        const original =
          first === "refresh"
            ? (refreshing = f.directory.reconcileOwnership(new AbortController().signal))
            : (publishing = f.directory.apply(newer));
        void original.catch(() => undefined);
        await Promise.race([
          entered.promise,
          original.then(() => {
            throw new Error("Original queue operation bypassed held prepare");
          }),
        ]);
        if (first === "refresh") publishing = f.directory.apply(newer);
        else refreshing = f.directory.reconcileOwnership(new AbortController().signal);
        void publishing?.catch(() => undefined);
        void refreshing?.catch(() => undefined);
        await nextTurn();
        expect(f.onApplied).toHaveBeenCalledOnce();
        expect(f.onOwnershipRefreshed).not.toHaveBeenCalled();
        expect(f.onPublished).not.toHaveBeenCalled();
        expect(f.directory.inspect(executionIdentity()).configuration.revision).toBe(1);
        release.resolve();
        await expect(refreshing).resolves.toBeUndefined();
        await expect(publishing).resolves.toEqual({
          organization_id: initial.organization_id,
          applied_revision: 2,
        });
        expect(f.onApplied.mock.calls.map(([configuration]) => configuration.revision)).toEqual(
          first === "refresh" ? [1, 2] : [2, 2],
        );
        expect(f.onOwnershipRefreshed).toHaveBeenCalledExactlyOnceWith(initial.organization_id);
        expect(f.onPublished).toHaveBeenCalledExactlyOnceWith(initial.organization_id);
        expect(invalidated).toHaveBeenCalledOnce();
        expect(f.repository.save).toHaveBeenCalledOnce();
        expect(f.directory.capturePublication(initial.organization_id).authority).toEqual(newer);
        expect(f.directory.inspect(executionIdentity()).configuration.revision).toBe(2);
      } finally {
        release.resolve();
        await Promise.allSettled([refreshing, publishing]);
        unsubscribe();
      }
    },
  );
});
