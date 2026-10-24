import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComponents } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import { PostgresAgentLeases } from "../src/adapters/postgres/agent-leases.js";
import { PostgresAgentStartup } from "../src/adapters/postgres/agent-startup.js";
import { PostgresExecutionConfiguration } from "../src/adapters/postgres/execution-configuration.js";
import { PostgresOwnerRecovery } from "../src/adapters/postgres/owner-recovery.js";
import { publicExecutionConfiguration } from "../src/domain/execution-configuration.js";
import { executionPublication } from "../src/domain/execution-publication.js";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";
import {
  closedExecutionAgent,
  executionConfiguration,
} from "./fixtures/execution-configuration.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";
import { runtimeConnections } from "./support/runtime-connections.js";

const registration = {
  registration_id: "abcdef01-2345-4abc-8abc-1234567890ab",
  member_id: "acp-a",
  incarnation_id: "abcdef02-2345-4abc-8abc-1234567890ab",
};
const settledInventory = { localUncertain: false, runtimeProtected: false };
function errorsIn(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? error.errors.flatMap((item: unknown) => errorsIn(item))
    : [error];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture() {
  const configuration = executionConfiguration();
  const originalAgent = configuration.agents[0];
  if (originalAgent === undefined) throw new Error("Missing settlement fixture Agent");
  configuration.agents = [
    {
      ...closedExecutionAgent(originalAgent),
      unavailable_reason: "agent_unavailable",
      operation_id: "settlement-operation",
    },
  ];
  vi.spyOn(PostgresExecutionConfiguration.prototype, "load").mockResolvedValue(
    publicExecutionConfiguration(configuration),
  );
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
  const inventory = vi
    .spyOn(PostgresAgentStartup.prototype, "settlement")
    .mockResolvedValue(settledInventory);
  const acquire = vi
    .spyOn(PostgresAgentLeases.prototype, "tryAcquire")
    .mockImplementation((scope, ownerInstanceId) =>
      Promise.resolve({
        fence: { ...scope, ownerInstanceId, epoch: "2" },
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      }),
    );
  // Publish the closed scope without creating a local application generation.
  // The later public settlement must acquire its own real control generation.
  acquire.mockResolvedValueOnce(null);
  const release = vi.spyOn(PostgresAgentLeases.prototype, "release").mockResolvedValue(true);
  const pool = new Pool();
  const connect = vi.spyOn(pool, "connect").mockImplementation(() => {
    throw new Error("Unexpected database connection in owned settlement fixture");
  });
  const query = vi.spyOn(pool, "query").mockImplementation(() => {
    throw new Error("Unexpected database query in owned settlement fixture");
  });
  const config = loadConfig({
    ...testSecurityEnvironment(),
    ANTNEST_ACP_DATABASE_URL: "postgres://unused/unused",
    ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  });
  const connections = runtimeConnections();
  const components = buildComponents(
    pool,
    config,
    NOOP_TELEMETRY,
    vi.fn(),
    new AbortController().signal,
    connections,
    registration,
  );
  async function close(expectedFailure?: Error) {
    const failures: unknown[] = [];
    for (const finish of [
      () => components.owned!.shutdown(),
      () => components.supervisor.shutdown(),
      () => connections.close(),
      () => pool.end(),
      () => config.authentication.workload.close(),
    ]) {
      try {
        await finish();
      } catch (error) {
        failures.push(...errorsIn(error));
      }
    }
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    if (expectedFailure !== undefined) {
      expect(failures.length).toBeGreaterThan(0);
      for (const failure of failures) expect(failure).toBe(expectedFailure);
    } else expect(failures).toEqual([]);
  }
  try {
    await components.directory.apply(configuration);
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Settlement fixture setup and cleanup failed", {
        cause: cleanup,
      });
    }
    throw error;
  }
  const request = {
    organization_id: configuration.organization_id,
    agent_id: originalAgent.agent_id,
    minimum_revision: configuration.revision,
    operation_id: "settlement-operation",
    mode: "wait" as const,
    deadline_at: new Date(Date.now() + 1000).toISOString(),
  };
  return {
    components,
    configuration,
    request,
    inventory,
    acquire,
    release,
    close,
    expected: {
      owner: { ...registration },
      publication: executionPublication(
        components.directory.capturePublication(configuration.organization_id).authority,
      ),
    },
  };
}

describe("forwarded owned settlement authority and original cleanup", () => {
  it.each([
    { cancellation: "deadline", failureAt: "inventory" },
    { cancellation: "parent", failureAt: "inventory" },
    { cancellation: "deadline", failureAt: "release" },
    { cancellation: "parent", failureAt: "release" },
  ] as const)(
    "joins and preserves a late $failureAt failure after $cancellation cancellation",
    async ({ cancellation, failureAt }) => {
      const f = await fixture();
      const originalInventory = Promise.withResolvers<typeof settledInventory>();
      const originalRelease = Promise.withResolvers<boolean>();
      void originalInventory.promise.catch(() => {});
      void originalRelease.promise.catch(() => {});
      const sentinel = new Error(`original settlement ${failureAt} failed`);
      const parent = new AbortController();
      if (failureAt === "inventory") f.inventory.mockReturnValueOnce(originalInventory.promise);
      f.release.mockReturnValueOnce(originalRelease.promise);
      const request = { ...f.request, deadline_at: new Date(Date.now() + 50).toISOString() };
      let finished = false;
      const settlement = f.components.settlement.settle(request, parent.signal, f.expected);
      void settlement.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(f.inventory).toHaveBeenCalledExactlyOnceWith({
          organizationId: request.organization_id,
          agentId: request.agent_id,
          ownerInstanceId: registration.incarnation_id,
          epoch: "2",
        });
        if (failureAt === "inventory") expect(f.release).not.toHaveBeenCalled();
        else expect(f.release).toHaveBeenCalledOnce();
        if (cancellation === "deadline") await vi.advanceTimersByTimeAsync(51);
        else {
          parent.abort(new Error("original settlement caller cancelled"));
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(finished).toBe(false);
        if (failureAt === "inventory") {
          originalInventory.reject(sentinel);
          await vi.advanceTimersByTimeAsync(0);
          expect(f.release).toHaveBeenCalledOnce();
          expect(finished).toBe(false);
          originalRelease.resolve(true);
        } else originalRelease.reject(sentinel);
        const [result] = await Promise.allSettled([settlement]);
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(errorsIn(result.reason)).toContain(sentinel);
      } finally {
        // Release the original operations even when the unfixed public result
        // returned early; shutdown still joins their actual lease cleanup.
        if (failureAt === "inventory") {
          originalInventory.reject(sentinel);
          originalRelease.resolve(true);
        } else {
          originalInventory.resolve(settledInventory);
          originalRelease.reject(sentinel);
        }
        await Promise.allSettled([settlement]);
        await f.close(sentinel);
      }
    },
  );

  it.each(["registration_id", "member_id", "incarnation_id", "private publication"] as const)(
    "rejects a mismatched expected %s instead of borrowing this process's generation",
    async (field) => {
      const f = await fixture();
      try {
        const expected = structuredClone(f.expected);
        if (field === "private publication") {
          const changed = structuredClone(f.configuration);
          const provider = changed.providers[0];
          if (provider === undefined) throw new Error("Missing fixture Provider");
          provider.credential = { method: "api_key", secret: "different-private-settlement-key" };
          expect(publicExecutionConfiguration(changed)).toEqual(
            publicExecutionConfiguration(f.configuration),
          );
          expected.publication = executionPublication(changed);
        } else
          expected.owner[field] =
            field === "member_id" ? "acp-b" : "abcdef03-2345-4abc-8abc-1234567890ab";
        await expect(
          f.components.settlement.settle(f.request, undefined, expected),
        ).rejects.toMatchObject({ code: "configuration_unavailable" });
        expect(f.inventory).not.toHaveBeenCalled();
        expect(f.release).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
});
