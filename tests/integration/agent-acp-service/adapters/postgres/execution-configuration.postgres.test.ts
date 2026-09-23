import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { ExecutionDirectory } from "../../../../../services/agent-acp-service/src/application/execution-directory.js";
import { ProviderClients } from "../../../../../services/agent-acp-service/src/application/provider-clients.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "private execution configuration storage",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const repository = new PostgresExecutionConfiguration(
      new PostgresKernel(pool),
    );
    const organizations: string[] = [];

    function configuration() {
      const input = executionConfiguration();
      input.organization_id = randomUUID();
      organizations.push(input.organization_id);
      return publicExecutionConfiguration(parseExecutionConfiguration(input));
    }

    beforeAll(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
    });
    afterAll(async () => {
      try {
        await pool.query(
          "DELETE FROM execution_configurations WHERE organization_id = ANY($1::text[])",
          [organizations],
        );
      } finally {
        await pool.end();
      }
    });

    it("round-trips the current non-secret snapshot without another service's tables", async () => {
      const input = configuration();
      expect(await repository.load(input.organization_id)).toBeNull();
      expect(await repository.save(input, null)).toBe(true);
      expect(await repository.load(input.organization_id)).toEqual(input);
      const raw = await pool.query<{ configuration: unknown }>(
        "SELECT configuration FROM execution_configurations WHERE organization_id = $1",
        [input.organization_id],
      );
      expect(JSON.stringify(raw.rows)).not.toContain("synthetic-provider-key");
    });

    it("uses compare-and-set for both first creation and replacement", async () => {
      const first = configuration();
      expect(await repository.save(first, null)).toBe(true);
      expect(await repository.save({ ...first, revision: 2 }, null)).toBe(
        false,
      );
      expect(await repository.save({ ...first, revision: 2 }, 1)).toBe(true);
      expect(await repository.save({ ...first, revision: 3 }, 1)).toBe(false);
      expect((await repository.load(first.organization_id))?.revision).toBe(2);
    });

    it("restores opaque identity from its own stored projection without aliasing similar principals", async () => {
      const input = executionConfiguration();
      input.organization_id = `${randomUUID()}+division@example.org`;
      organizations.push(input.organization_id);
      input.agents[0]!.agent_id = "agent/department+1";
      input.agents[0]!.principal_ids = ["owner+team@example.org"];
      const directory = executionDirectory();
      await directory.apply(input);
      expect(await repository.load(input.organization_id)).toEqual(
        publicExecutionConfiguration(input),
      );
      const restarted = executionDirectory();
      const identity = {
        organizationId: input.organization_id,
        agentId: input.agents[0]!.agent_id,
        principalId: input.agents[0]!.principal_ids[0]!,
      };
      expect(() => restarted.inspect(identity)).toThrow("not ready");
      await restarted.apply(input);
      expect(restarted.inspect(identity).agent.agent_id).toBe(identity.agentId);
      for (const principalId of [
        "OWNER+team@example.org",
        "owner team@example.org",
        "owner%2Bteam@example.org",
      ]) {
        expect(() => restarted.inspect({ ...identity, principalId })).toThrow(
          "access",
        );
      }
      const closed = structuredClone(input);
      closed.revision = 2;
      closed.agents[0]!.accepting_runs = false;
      closed.agents[0]!.unavailable_reason = "rebuilding";
      closed.agents[0]!.operation_id = "operation+rebuild@example.org";
      await restarted.apply(closed);
      const operation = {
        organizationId: identity.organizationId,
        agentId: identity.agentId,
        minimumRevision: 2,
        operationId: closed.agents[0]!.operation_id,
      };
      expect(restarted.closedAgent(operation).revision).toBe(2);
      expect(() =>
        restarted.closedAgent({
          ...operation,
          operationId: "operation rebuild@example.org",
        }),
      ).toThrow("changed");
    });

    it("does not publish or acknowledge a snapshot PostgreSQL cannot represent", async () => {
      const input = executionConfiguration();
      input.organization_id = randomUUID();
      organizations.push(input.organization_id);
      const onApplied = vi.fn(() => Promise.resolve());
      const directory = executionDirectory(onApplied);
      await directory.apply(input);
      onApplied.mockClear();
      const invalid = structuredClone(input);
      invalid.revision = 2;
      invalid.agents[0]!.principal_ids = ["principal\u0000invalid"];
      await expect(directory.apply(invalid)).rejects.toThrow();
      expect(onApplied).not.toHaveBeenCalled();
      expect(await repository.load(input.organization_id)).toEqual(
        publicExecutionConfiguration(input),
      );
      expect(
        directory.inspect({
          organizationId: input.organization_id,
          agentId: "agent-1",
          principalId: "principal-1",
        }).configuration.revision,
      ).toBe(1);
      await expect(
        directory.apply({ ...input, revision: 2 }),
      ).resolves.toHaveProperty("applied_revision", 2);
    });

    function executionDirectory(onApplied = vi.fn(() => Promise.resolve())) {
      return new ExecutionDirectory({
        repository,
        clients: new ProviderClients({
          complete: () => Promise.reject(new Error("No model call")),
        }),
        onApplied,
        onUnavailable: () => undefined,
      });
    }

    it("does not permit an equal or older revision to replace the stored payload", async () => {
      const input = { ...configuration(), revision: 2 };
      await repository.save(input, null);
      expect(await repository.save({ ...input, revision: 1 }, 2)).toBe(false);
      expect(await repository.save({ ...input, agents: [] }, 2)).toBe(false);
      expect(await repository.load(input.organization_id)).toEqual(input);
    });

    it("rejects a secret-bearing value even if a caller bypasses the static port type", async () => {
      const fixture = executionConfiguration();
      fixture.organization_id = randomUUID();
      organizations.push(fixture.organization_id);
      await expect(repository.save(fixture, null)).rejects.toThrow(
        "stored execution configuration",
      );
      expect(await repository.load(fixture.organization_id)).toBeNull();
    });

    it("isolates organizations and persists an empty revocation snapshot", async () => {
      const first = configuration();
      const second = configuration();
      await repository.save(first, null);
      await repository.save(second, null);
      const cleared = {
        organization_id: first.organization_id,
        revision: 2,
        agents: [],
        models: [],
        providers: [],
      };
      expect(await repository.save(cleared, 1)).toBe(true);
      expect(await repository.load(first.organization_id)).toEqual(cleared);
      expect(await repository.load(second.organization_id)).toEqual(second);
    });

    it("enforces stored snapshot identity and revision consistency in PostgreSQL", async () => {
      const input = configuration();
      await repository.save(input, null);
      await expect(
        pool.query(
          "UPDATE execution_configurations SET revision = 0 WHERE organization_id = $1",
          [input.organization_id],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          "UPDATE execution_configurations SET configuration = jsonb_set(configuration, '{organization_id}', '\"other\"') WHERE organization_id = $1",
          [input.organization_id],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          "UPDATE execution_configurations SET revision = 2 WHERE organization_id = $1",
          [input.organization_id],
        ),
      ).rejects.toThrow();
    });

    it.each([2, 3])(
      "publishes revision %s after PostgreSQL commits without a usable acknowledgement",
      async (nextRevision) => {
        const initial = executionConfiguration();
        initial.organization_id = randomUUID();
        organizations.push(initial.organization_id);
        const identity = {
          organizationId: initial.organization_id,
          agentId: "agent-1",
          principalId: "principal-1",
        };
        const directory = new ExecutionDirectory({
          repository,
          clients: new ProviderClients({
            complete: () => Promise.reject(new Error("No model call")),
          }),
          onApplied: () => Promise.resolve(),
          onUnavailable: () => undefined,
        });
        await directory.apply(initial);
        const committed = { ...initial, revision: 2 };
        const save = repository.save.bind(repository);
        vi.spyOn(repository, "save").mockImplementationOnce(
          async (input, expected) => {
            await save(input, expected);
            throw new Error("acknowledgement lost");
          },
        );
        await expect(directory.apply(committed)).rejects.toThrow(
          "acknowledgement",
        );
        expect((await repository.load(initial.organization_id))?.revision).toBe(
          2,
        );
        await expect(
          directory.withAccess(identity, ({ configuration }) =>
            Promise.resolve(configuration.revision),
          ),
        ).resolves.toBe(1);
        await expect(
          directory.apply({ ...committed, revision: nextRevision }),
        ).resolves.toHaveProperty("applied_revision", nextRevision);
        await expect(
          directory.withAccess(identity, ({ configuration }) =>
            Promise.resolve(configuration.revision),
          ),
        ).resolves.toBe(nextRevision);
      },
    );
  },
);
