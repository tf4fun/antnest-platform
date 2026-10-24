import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFencedLegacyAgentRepositories,
  createLegacyAgentRepositories,
  createOwnedAgentRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
async function legacy(f: FencingFixture, agentId = "agent-a") {
  const session = await f.session(scope(agentId));
  const repositories = createLegacyAgentRepositories(
    f.kernelA,
    f.secretBox,
    new AbortController().signal,
  );
  const input = f.input(session);
  await repositories.runs.createRunIntent(input);
  const acceptance = f.acceptance(session, input.runId);
  await repositories.runs.acceptRun(acceptance);
  await repositories.permissions.open({
    runId: input.runId,
    sessionId: session.sessionId,
    call: {
      id: randomUUID(),
      name: "write",
      arguments: { content: "preserve original" },
    },
    tool: {
      source: "runtime",
      sourceId: "runtime",
      name: "write",
      modelName: "write",
      description: "write",
    },
  });
  const temporary = await repositories.temporarySkills.reserve({
    runId: input.runId,
    snapshot: acceptance.snapshot,
    signal: new AbortController().signal,
  });
  return { session, input, repositories, temporary };
}
async function snapshot(f: FencingFixture) {
  const extras = await f.observer.query<{
    value: string;
  }>(`SELECT jsonb_build_object(
    'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.run_id,p.tool_call_id) FROM tool_permissions p),
    'temporary',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.run_id) FROM temporary_skill_scopes t)
  )::text AS value`);
  return JSON.stringify([await f.snapshot(), extras.rows[0]!.value]);
}
async function denied(f: FencingFixture, operation: () => Promise<unknown>) {
  const before = await snapshot(f);
  await expect(operation()).rejects.toBeInstanceOf(AgentOwnershipLostError);
  expect(await snapshot(f)).toBe(before);
}

describe.skipIf(databaseUrl === undefined)(
  "fenced recovery of original legacy records",
  () => {
    it("limits recovery and Temporary cleanup to its Agent and preserves all null owner columns", async () => {
      await withDatabase(async (f) => {
        const a = await legacy(f);
        const b = await legacy(f, "agent-b");
        const owner = await f.owner(a.session.binding);
        const current = createFencedLegacyAgentRepositories(
          f.kernelA,
          f.secretBox,
          owner.authority,
        );
        const origin = await f.origin(a.input.runId);
        expect(Object.values(origin)).toEqual([null, null, null, null]);
        expect(
          await current.executions.listRecoveryWork(a.session.binding),
        ).toEqual([{ id: a.input.runId, kind: "running" }]);
        for (const absentOrForeign of [
          undefined,
          scope("empty-agent"),
          b.session.binding,
        ]) {
          await denied(f, () =>
            current.executions.listRecoveryWork(absentOrForeign),
          );
          await denied(f, () =>
            current.permissions.cancelAbandoned(absentOrForeign),
          );
        }
        await current.permissions.cancelAbandoned(a.session.binding);
        expect(
          (
            await f.observer.query(
              "SELECT decision FROM tool_permissions WHERE run_id=$1",
              [b.input.runId],
            )
          ).rows,
        ).toEqual([{ decision: null }]);
        await current.temporarySkills.authorizeCleanup(
          a.temporary,
          new AbortController().signal,
        );
        await current.temporarySkills.released(a.temporary);
        expect(await f.origin(a.input.runId)).toEqual(origin);
        expect(
          (
            await f.observer.query(
              "SELECT released_at FROM temporary_skill_scopes WHERE run_id=$1",
              [b.input.runId],
            )
          ).rows,
        ).toEqual([{ released_at: null }]);
        await denied(f, () => current.temporarySkills.released(b.temporary));
      });
    });

    it("rejects every delayed legacy writer after an actual successor acquired the Agent", async () => {
      await withDatabase(async (f) => {
        const a = await legacy(f);
        const owner = await f.owner(a.session.binding);
        const old = createFencedLegacyAgentRepositories(
          f.kernelA,
          f.secretBox,
          owner.authority,
        );
        await f.successor(owner);
        await denied(f, () =>
          old.permissions.cancelAbandoned(a.session.binding),
        );
        await denied(f, () =>
          old.runs.requestCancellation(a.input.runId, new Date()),
        );
        await denied(f, () =>
          old.temporarySkills.authorizeCleanup(
            a.temporary,
            new AbortController().signal,
          ),
        );
        await denied(f, () => old.temporarySkills.released(a.temporary));
      });
    });

    it("rechecks the original legacy fence after waiting on the database lease lock", async () => {
      await withDatabase(async (f) => {
        const a = await legacy(f);
        const owner = await f.owner(a.session.binding);
        const current = createFencedLegacyAgentRepositories(
          f.kernelA,
          f.secretBox,
          owner.authority,
        );
        const held = await f.holdLease(owner.authority.fence);
        const before = await snapshot(f);
        const original = f.observe(
          current.permissions.cancelAbandoned(a.session.binding).then(
            () => ({ ok: true }),
            (error: unknown) => ({ error }),
          ),
        );
        await f.waitForBlockedWriter();
        await held.query(
          "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2",
          [a.session.binding.organizationId, a.session.binding.agentId],
        );
        await f.release(held, true);
        expect(await original).toEqual({
          error: expect.any(AgentOwnershipLostError) as unknown,
        });
        expect(await snapshot(f)).toBe(before);
      });
    });

    it("does not reinterpret a current owned Run as legacy recovery", async () => {
      await withDatabase(async (f) => {
        const session = await f.session(scope("owned-agent"));
        const owner = await f.owner(session.binding);
        const repositories = createOwnedAgentRepositories(
          f.kernelA,
          f.secretBox,
          owner.authority,
        );
        const input = f.input(session);
        await repositories.runs.createRunIntent(input);
        const legacy = createFencedLegacyAgentRepositories(
          f.kernelA,
          f.secretBox,
          owner.authority,
        );
        await denied(f, () =>
          legacy.executions.listRecoveryWork(session.binding),
        );
        await denied(f, () =>
          legacy.runs.rejectRun(input.runId, "must not change", new Date()),
        );
      });
    });
  },
);
