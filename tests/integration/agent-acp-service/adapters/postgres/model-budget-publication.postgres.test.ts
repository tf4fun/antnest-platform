import { describe, expect, it } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { withDatabase } from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const policy = {
  revision: 2,
  unknown_cost: "deny" as const,
  run_caps: {},
  daily: { hard_cost_usd_micros: 10 },
  monthly: {},
};

describe.skipIf(databaseUrl === undefined)(
  "monotonic organization model budget publication",
  () => {
    it("rejects a newer execution publication carrying older, changed or omitted budget authority", async () => {
      await withDatabase(async (fixture) => {
        const writer = new PostgresExecutionConfiguration(
          fixture.kernelA,
          fixture.secretBox,
        );
        const other = new PostgresExecutionConfiguration(
          fixture.kernelB,
          fixture.secretBox,
        );
        const original = {
          ...executionConfiguration(),
          organization_budget: structuredClone(policy),
        };
        expect(await writer.save(original, null)).toBe(true);
        const before = await other.loadAuthority(original.organization_id);
        const stale = {
          ...original,
          revision: 2,
          organization_budget: { ...policy, revision: 1 },
        };
        const changed = {
          ...original,
          revision: 2,
          organization_budget: {
            ...policy,
            daily: { hard_cost_usd_micros: 100 },
          },
        };
        const omitted = { ...executionConfiguration(), revision: 2 };
        for (const incoming of [stale, changed, omitted]) {
          await expect(other.save(incoming, 1)).rejects.toMatchObject({
            code: "configuration_conflict",
            retryable: false,
          });
          expect(await writer.loadAuthority(original.organization_id)).toEqual(
            before,
          );
        }
        expect(await other.save({ ...original, revision: 2 }, 1)).toBe(true);
        const tightened = {
          ...original,
          revision: 3,
          organization_budget: {
            ...policy,
            revision: 3,
            daily: { hard_cost_usd_micros: 5 },
          },
        };
        expect(await writer.save(tightened, 2)).toBe(true);
        expect(await other.load(original.organization_id)).toMatchObject({
          revision: 3,
          organization_budget: tightened.organization_budget,
        });
      });
    });
  },
);
