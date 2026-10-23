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
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../fixtures/execution-configuration.js";
import { runtimeConnections } from "../support/runtime-connections.js";

function setup() {
  let stored: ExecutionConfiguration | null = null;
  const beforeAck = vi.fn<(configuration: PublicExecutionConfiguration) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const onApplied = vi.fn<(configuration: PublicExecutionConfiguration) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const onUnavailable = vi.fn();
  const dependencies: ExecutionDirectoryDependencies & { beforeAck: typeof beforeAck } = {
    repository: {
      load: () => Promise.resolve(stored === null ? null : publicExecutionConfiguration(stored)),
      loadAuthority: () => Promise.resolve(structuredClone(stored)),
      listOrganizations: () => Promise.resolve(stored === null ? [] : [stored.organization_id]),
      save: (incoming, revision) => {
        if ((stored?.revision ?? null) !== revision) return Promise.resolve(false);
        stored = structuredClone(incoming);
        return Promise.resolve(true);
      },
    },
    clients: new ProviderClients({
      complete: () => Promise.reject(new Error("Unexpected model call")),
    }),
    runtimeConnections: runtimeConnections(),
    onApplied,
    onUnavailable,
    beforeAck,
  };
  return {
    directory: new ExecutionDirectory(dependencies),
    beforeAck,
    onApplied,
    onUnavailable,
    store: (value: ExecutionConfiguration) => {
      stored = structuredClone(value);
    },
  };
}

describe("publication and complete owner acknowledgement", () => {
  it("keeps the complete published snapshot usable when an accepting owner cannot acknowledge", async () => {
    const f = setup();
    const next = executionConfiguration();
    next.agents.push({
      ...structuredClone(next.agents[0]!),
      agent_id: "agent-b",
      runtime: runtimeConfiguration(2),
    });
    f.beforeAck.mockRejectedValue(
      new DomainError("configuration_unavailable", "Agent A is protected"),
    );
    await expect(f.directory.apply(next)).rejects.toMatchObject({
      code: "configuration_unavailable",
    });
    expect(
      f.directory.inspect({ ...executionIdentity(), agentId: "agent-b" }).configuration,
    ).toEqual(publicExecutionConfiguration(next));
    expect(f.beforeAck).toHaveBeenCalledWith(publicExecutionConfiguration(next));
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it("checks same and older revision responses against the complete actual publication", async () => {
    const f = setup();
    const next = executionConfiguration();
    next.revision = 2;
    await f.directory.apply(next);
    f.beforeAck.mockRejectedValue(new DomainError("configuration_unavailable", "Owner lost"));
    for (const incoming of [next, { ...next, revision: 1 }]) {
      await expect(f.directory.apply(incoming)).rejects.toMatchObject({
        code: "configuration_unavailable",
      });
      expect(f.beforeAck).toHaveBeenLastCalledWith(publicExecutionConfiguration(next));
      expect(f.directory.inspect(executionIdentity()).configuration.revision).toBe(2);
    }
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it("does not hold publication while awaiting an owner and rejects a superseded acknowledgement", async () => {
    const f = setup();
    const first = executionConfiguration();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    f.beforeAck.mockImplementationOnce(async () => {
      entered.resolve();
      await released.promise;
    });
    const original = f.directory.apply(first);
    void original.catch(() => undefined);
    try {
      await Promise.race([
        entered.promise,
        original.then(() => {
          throw new Error("Acknowledgement skipped its owner check");
        }),
      ]);
      const newer = structuredClone(first);
      newer.revision = 2;
      newer.agents[0]!.principal_ids = [];
      await expect(f.directory.apply(newer)).resolves.toEqual({
        organization_id: newer.organization_id,
        applied_revision: 2,
      });
      released.resolve();
      await expect(original).rejects.toMatchObject({ code: "configuration_unavailable" });
      expect(() => f.directory.inspect(executionIdentity())).toThrow("Agent access");
      expect(f.onUnavailable).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await Promise.allSettled([original]);
    }
  });

  it("restores local service without pretending to return a Controller acknowledgement", async () => {
    const f = setup();
    const configuration = executionConfiguration();
    f.store(configuration);
    f.beforeAck.mockRejectedValue(new Error("Restore must not request an ACK"));
    await f.directory.restore(new AbortController().signal);
    expect(f.directory.inspect(executionIdentity()).configuration).toEqual(
      publicExecutionConfiguration(configuration),
    );
    expect(f.beforeAck).not.toHaveBeenCalled();
  });
});
