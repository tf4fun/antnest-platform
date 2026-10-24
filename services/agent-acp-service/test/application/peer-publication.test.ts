import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ExecutionDirectory } from "../../src/application/execution-directory.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import {
  publicExecutionConfiguration,
  type ExecutionConfiguration,
  type PublicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import { runtimeConnections } from "../support/runtime-connections.js";

// Independent wire fixture: JSON objects are sorted recursively, arrays retain order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const publication = (configuration: ExecutionConfiguration) => ({
  organization_id: configuration.organization_id,
  revision: configuration.revision,
  authority_sha256: createHash("sha256").update(canonical(configuration)).digest("hex"),
});

function setup() {
  let stored: ExecutionConfiguration | null = executionConfiguration();
  const beforeAck = vi.fn(() => Promise.reject(new Error("Peer leaf recursively aggregated")));
  const onApplied = vi.fn<(configuration: PublicExecutionConfiguration) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const save = vi.fn(() => Promise.reject(new Error("Peer must not overwrite stored authority")));
  const onUnavailable = vi.fn();
  const directory = new ExecutionDirectory({
    repository: {
      load: () => Promise.resolve(stored === null ? null : publicExecutionConfiguration(stored)),
      loadAuthority: () => Promise.resolve(structuredClone(stored)),
      listOrganizations: () => Promise.resolve(stored === null ? [] : [stored.organization_id]),
      save,
    },
    clients: new ProviderClients({ complete: () => Promise.reject(new Error("Unexpected model")) }),
    runtimeConnections: runtimeConnections(),
    beforeAck,
    onApplied,
    onUnavailable,
  });
  return {
    directory,
    beforeAck,
    onApplied,
    onUnavailable,
    save,
    store: (value: ExecutionConfiguration | null) => {
      stored = structuredClone(value);
    },
  };
}

describe("peer local publication from authenticated storage", () => {
  it("publishes locally without recursively aggregating or saving the peer request", async () => {
    const f = setup();
    const configuration = executionConfiguration();
    const captured = await f.directory.applyPeerPublication(publication(configuration));
    expect(captured.configuration).toEqual(publicExecutionConfiguration(configuration));
    expect(captured.authority).toEqual(configuration);
    expect(Object.isFrozen(captured.configuration.agents[0])).toBe(true);
    captured.assertCurrent();
    expect(f.directory.inspect(executionIdentity()).configuration).toBe(captured.configuration);
    expect(f.beforeAck).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.onApplied).toHaveBeenCalledOnce();
  });

  it("binds the receipt to private credentials even when the public projection is identical", async () => {
    const f = setup();
    const original = executionConfiguration();
    const changed = executionConfiguration();
    changed.providers[0]!.credential.secret += "-rotated";
    expect(publicExecutionConfiguration(changed)).toEqual(publicExecutionConfiguration(original));
    f.store(changed);
    await expect(f.directory.applyPeerPublication(publication(original))).rejects.toMatchObject({
      code: "configuration_unavailable",
    });
    expect(f.onApplied).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each(["missing", "newer", "different-organization"] as const)(
    "rejects %s stored authority without creating a publication",
    async (kind) => {
      const f = setup();
      const expected = executionConfiguration();
      const actual = structuredClone(expected);
      if (kind === "newer") actual.revision += 1;
      if (kind === "different-organization") actual.organization_id = "another-org";
      f.store(kind === "missing" ? null : actual);
      await expect(f.directory.applyPeerPublication(publication(expected))).rejects.toMatchObject({
        code: "configuration_unavailable",
      });
      expect(f.onApplied).not.toHaveBeenCalled();
    },
  );

  it("rejects a DB-only authority change during local preparation", async () => {
    const f = setup();
    const expected = executionConfiguration();
    f.onApplied.mockImplementationOnce(() => {
      const changed = executionConfiguration();
      changed.providers[0]!.credential.secret += "-changed-during-prepare";
      f.store(changed);
      return Promise.resolve();
    });
    await expect(f.directory.applyPeerPublication(publication(expected))).rejects.toMatchObject({
      code: "configuration_unavailable",
    });
    expect(() => f.directory.inspect(executionIdentity())).toThrow();
    expect(f.save).not.toHaveBeenCalled();
  });

  it("keeps the original publication usable on a pre-publication mismatched peer request", async () => {
    const f = setup();
    const expected = executionConfiguration();
    const captured = await f.directory.applyPeerPublication(publication(expected));
    await expect(
      f.directory.applyPeerPublication({
        ...publication(expected),
        authority_sha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "configuration_unavailable" });
    captured.assertCurrent();
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it("invalidates an old receipt as soon as a newer local publication is queued", async () => {
    const f = setup();
    const original = executionConfiguration();
    const captured = await f.directory.applyPeerPublication(publication(original));
    const newer = executionConfiguration();
    newer.revision += 1;
    f.store(newer);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.onApplied.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = f.directory.applyPeerPublication(publication(newer));
    void pending.catch(() => undefined);
    try {
      await entered.promise;
      expect(() => captured.assertCurrent()).toThrow();
      release.resolve();
      const current = await pending;
      current.assertCurrent();
      expect(current.configuration.revision).toBe(2);
      expect(() => captured.assertCurrent()).toThrow();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("cannot mutate the captured private authority used by final aggregate confirmation", async () => {
    const f = setup();
    const captured = await f.directory.applyPeerPublication(publication(executionConfiguration()));
    expect(() => {
      captured.authority.providers.length = 0;
    }).toThrow();
    expect(captured.authority.providers).toHaveLength(1);
  });
});
