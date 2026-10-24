import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionDirectory,
  type ExecutionDirectoryDependencies,
  type LocalExecutionPublication,
} from "../../src/application/execution-directory.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import {
  publicExecutionConfiguration,
  type ExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { executionPublication } from "../../src/domain/execution-publication.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import { runtimeConnections } from "../support/runtime-connections.js";

function setup(confirm: (capture: LocalExecutionPublication, deadline: Date) => Promise<void>) {
  let stored: ExecutionConfiguration | null = null;
  const onApplied = vi.fn<ExecutionDirectoryDependencies["onApplied"]>(() => Promise.resolve());
  const directory = new ExecutionDirectory({
    repository: {
      load: () => Promise.resolve(stored === null ? null : publicExecutionConfiguration(stored)),
      loadAuthority: () => Promise.resolve(structuredClone(stored)),
      listOrganizations: () => Promise.resolve(stored === null ? [] : [stored.organization_id]),
      save: (next) => {
        stored = structuredClone(next);
        return Promise.resolve(true);
      },
    },
    clients: new ProviderClients({ complete: () => Promise.reject(new Error("Unexpected model")) }),
    runtimeConnections: runtimeConnections(),
    onApplied,
    onUnavailable: vi.fn(),
    beforePeerAck: confirm,
  });
  return {
    directory,
    onApplied,
    store: (next: ExecutionConfiguration) => {
      stored = structuredClone(next);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("production peer publication entry", () => {
  it("passes the frozen private publication and the original entry deadline outside the queue", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const confirmation = vi.fn((capture: LocalExecutionPublication, deadline: Date) => {
      capture.assertCurrent();
      expect(deadline.getTime()).toBe(1_800_000_010_000);
      expect(capture.authority).toEqual(original);
      const provider = capture.authority.providers[0]!;
      if (!("credential" in provider)) throw new Error("Expected provider credential");
      expect(Object.isFrozen(provider.credential)).toBe(true);
      expect(capture.configuration).toBe(f.directory.inspect(executionIdentity()).configuration);
      return Promise.resolve();
    });
    const f = setup(confirmation);
    const original = executionConfiguration();
    f.onApplied.mockImplementation(() => {
      now += 4000;
      return Promise.resolve();
    });
    await f.directory.apply(original);
    expect(confirmation).toHaveBeenCalledOnce();
    original.providers[0]!.credential.secret += "-caller-mutation";
    const provider = confirmation.mock.calls[0]![0].authority.providers[0]!;
    if (!("credential" in provider)) throw new Error("Expected provider credential");
    expect(provider.credential.secret).not.toBe(original.providers[0]!.credential.secret);
  });

  it("confirms the actually restored newer publication on stale replay", async () => {
    const confirmation = vi.fn(() => Promise.resolve());
    const f = setup(confirmation);
    const newer = executionConfiguration();
    newer.revision = 2;
    newer.providers[0]!.credential.secret += "-newer";
    f.store(newer);
    await f.directory.restore(new AbortController().signal);
    expect(confirmation).not.toHaveBeenCalled();
    await expect(f.directory.apply(executionConfiguration())).resolves.toMatchObject({
      applied_revision: 2,
    });
    expect(confirmation).toHaveBeenCalledOnce();
    expect(confirmation.mock.calls[0]).toEqual([
      expect.objectContaining({ authority: newer }),
      expect.any(Date),
    ]);
  });

  it("allows a later revision to publish while ACK waits and rejects the superseded ACK", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = setup(async (capture) => {
      capture.assertCurrent();
      if (capture.configuration.revision === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const original = f.directory.apply(executionConfiguration());
    void original.catch(() => undefined);
    try {
      await Promise.race([
        entered.promise,
        original.then(() => {
          throw new Error("Peer ACK hook was bypassed");
        }),
      ]);
      const newer = executionConfiguration();
      newer.revision = 2;
      await expect(f.directory.apply(newer)).resolves.toMatchObject({ applied_revision: 2 });
      release.resolve();
      await expect(original).rejects.toMatchObject({ code: "configuration_unavailable" });
    } finally {
      release.resolve();
      await Promise.allSettled([original]);
    }
  });

  it("keeps the peer leaf free of aggregation and persistence", async () => {
    const confirmation = vi.fn(() => Promise.reject(new Error("Recursive aggregation")));
    const f = setup(confirmation);
    const original = executionConfiguration();
    f.store(original);
    const captured = await f.directory.applyPeerPublication(executionPublication(original));
    captured.assertCurrent();
    expect(captured.authority).toEqual(original);
    expect(confirmation).not.toHaveBeenCalled();
  });
});
