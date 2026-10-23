import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createOwnedAgentRepositories,
  createLegacyAgentRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { TemporarySkills } from "../../../../../services/agent-acp-service/src/application/temporary-skills.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type {
  TemporarySkillRuntime,
  TemporarySkillStore,
} from "../../../../../services/agent-acp-service/src/ports/temporary-skills.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const signal = () => new AbortController().signal;
const loaded = {
  skillText: "instruction",
  contentDigest: `sha256:${"a".repeat(64)}`,
  artifactDigest: `sha256:${"b".repeat(64)}`,
  requiresRuntimeDelivery: true,
};
async function setup(f: FencingFixture) {
  const session = await f.session(scope("agent-1"));
  const owner = await f.owner(session.binding);
  const repositories = createOwnedAgentRepositories(
    f.kernelA,
    f.secretBox,
    owner.authority,
  );
  const intent = f.input(session);
  await repositories.runs.createRunIntent(intent);
  const acceptance = f.acceptance(session, intent.runId);
  await repositories.runs.acceptRun(acceptance);
  const input = {
    runId: intent.runId,
    snapshot: acceptance.snapshot,
    signal: signal(),
  };
  const record = await repositories.temporarySkills.reserve(input);
  return { session, owner, repositories, input, record };
}
function consumer(store: TemporarySkillStore) {
  const runtime = {
    install: vi.fn<TemporarySkillRuntime["install"]>(() =>
      Promise.resolve({
        path: "/workspace/package",
        unpacked_size: 1,
      }),
    ),
    cleanup: vi.fn<TemporarySkillRuntime["cleanup"]>(() => Promise.resolve()),
  };
  return { runtime, service: new TemporarySkills(store, runtime) };
}
async function snapshot(f: FencingFixture) {
  const result = await f.observer.query<{
    value: string;
  }>(`SELECT jsonb_build_object(
    'temporary',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.run_id),'[]'::jsonb) FROM temporary_skill_scopes t),
    'barriers',(SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.barrier_id),'[]'::jsonb) FROM runtime_barrier_cycles b),
    'permissions',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.run_id,p.tool_call_id),'[]'::jsonb) FROM tool_permissions p)
  )::text AS value`);
  return JSON.stringify([await f.snapshot(), result.rows[0]!.value]);
}
async function denied(f: FencingFixture, operation: () => Promise<unknown>) {
  const before = await snapshot(f);
  await expect(operation()).rejects.toBeInstanceOf(AgentOwnershipLostError);
  expect(await snapshot(f)).toBe(before);
}
async function protectedRun(
  f: FencingFixture,
  a: Awaited<ReturnType<typeof setup>>,
  ordinary = false,
) {
  const call = randomUUID();
  await a.repositories.events.startToolAttempt({
    id: randomUUID(),
    runId: a.input.runId,
    toolCallId: call,
    tool: {
      source: "agent",
      sourceId: "skill_registry",
      name: "load_skill",
      modelName: "load_skill",
      description: "load",
      inputSchema: {},
    },
    arguments: {},
    requestDigest: "digest",
    createdAt: new Date(),
  });
  await a.repositories.events.finishToolAttempt({
    id: randomUUID(),
    runId: a.input.runId,
    toolCallId: call,
    status: "failed",
    content: [],
    resultSummary: [],
    toolEffectState: "unknown",
    runtimeCallStopped: false,
    createdAt: new Date(),
  });
  if (ordinary)
    await f.observer.query(
      `INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,state,tool_effect_state,created_at,updated_at,started_at,finished_at,result_summary)
    VALUES($1,$2,$1,'runtime','runtime','bash','digest','failed','unknown',now(),now(),now(),now(),'[]'::jsonb)`,
      [randomUUID(), a.input.runId],
    );
  await a.repositories.executions.finish({
    runId: a.input.runId,
    terminalClass: "unresolved",
    executorState: "quiescent",
    toolEffectState: "unknown",
    unknownEffectSource: "runtime_mcp",
    errorClass: "runtime_outcome_unknown",
    finishedAt: new Date(),
  });
  expect(
    (
      await f.observer.query(
        "SELECT barrier_id FROM runtime_barrier_cycles WHERE retired_at IS NULL",
      )
    ).rowCount,
  ).toBe(1);
}

describe.skipIf(databaseUrl === undefined)(
  "original Run-bound temporary Skill effects",
  () => {
    for (const mode of [
      "stale",
      "successor",
      "same-incarnation",
      "legacy",
    ] as const) {
      it(`rejects ${mode} duplicate install, cleanup dispatch and cleanup receipts`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(f);
          const b = await f.successor(
            a.owner,
            mode === "same-incarnation"
              ? a.owner.authority.registration
              : undefined,
          );
          const repositories =
            mode === "stale"
              ? a.repositories
              : mode === "legacy"
                ? createLegacyAgentRepositories(
                    f.kernelA,
                    f.secretBox,
                    signal(),
                  )
                : createOwnedAgentRepositories(
                    f.kernelB,
                    f.secretBox,
                    b.authority,
                  );
          const actual = consumer(repositories.temporarySkills);
          await denied(f, () => actual.service.install(a.input, loaded));
          expect(actual.runtime.install).not.toHaveBeenCalled();
          await denied(f, () =>
            actual.service.releaseRun(a.input.runId, signal()),
          );
          expect(actual.runtime.cleanup).not.toHaveBeenCalled();
          await denied(f, () =>
            repositories.temporarySkills.released(a.record),
          );
        });
      });
    }
    for (const [field, value] of Object.entries({
      organizationId: "foreign",
      agentId: "foreign",
      revision: `rtv_${"f".repeat(32)}`,
      connectionId: `rci_${"f".repeat(32)}`,
      executionId: "foreign",
      mcpEndpoint: "http://foreign:8093/mcp",
      runId: "foreign",
    })) {
      it(`rejects substituted ${field} before cleanup RPC`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(f),
            actual = consumer(a.repositories.temporarySkills),
            before = await snapshot(f);
          await expect(
            actual.service.release({ ...a.record, [field]: value }, signal()),
          ).rejects.toThrow();
          expect(actual.runtime.cleanup).not.toHaveBeenCalled();
          expect(await snapshot(f)).toBe(before);
        });
      });
    }
    it("joins a held cleanup after takeover but preserves temporary, stopping and barrier facts", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        await protectedRun(f, a);
        const actual = consumer(a.repositories.temporarySkills),
          held = Promise.withResolvers<void>();
        actual.runtime.cleanup.mockImplementation(() => held.promise);
        let settled = false;
        const operation = f.observe(
          actual.service.release(a.record, signal()).then(
            () => {
              settled = true;
              return null;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          ),
        );
        try {
          await expect
            .poll(() => actual.runtime.cleanup.mock.calls.length)
            .toBe(1);
          await f.successor(a.owner); // Must not be blocked by a transaction held across RPC.
          const before = await snapshot(f);
          expect(settled).toBe(false);
          held.resolve();
          expect(await operation).toBeInstanceOf(AgentOwnershipLostError);
          expect(await snapshot(f)).toBe(before);
        } finally {
          held.resolve();
          await operation;
        }
      });
    });
    it("captures cleanup identity before awaiting the Runtime receipt", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f),
          actual = consumer(a.repositories.temporarySkills),
          held = Promise.withResolvers<void>();
        const original = { ...a.record },
          caller = { ...a.record };
        actual.runtime.cleanup.mockImplementation(() => held.promise);
        const operation = f.observe(
          actual.service.release(caller, signal()).then(
            () => null,
            (error: unknown) => error,
          ),
        );
        try {
          await expect
            .poll(() => actual.runtime.cleanup.mock.calls.length)
            .toBe(1);
          caller.runId = "foreign";
          caller.executionId = "foreign";
          expect(actual.runtime.cleanup.mock.calls[0]![0]).toEqual(original);
          held.resolve();
          expect(await operation).toBeNull();
          expect(
            await a.repositories.temporarySkills.forRun(
              original.runId,
              signal(),
            ),
          ).toBeNull();
        } finally {
          held.resolve();
          await operation;
        }
      });
    });
    for (const ordinary of [false, true]) {
      it(`allows original-owner terminal/deleted cleanup while preserving ordinary effects (${ordinary})`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(f);
          await protectedRun(f, a, ordinary);
          await a.repositories.sessions.delete(a.session.sessionId, new Date());
          const actual = consumer(a.repositories.temporarySkills);
          await actual.service.releaseRun(a.input.runId, signal());
          expect(actual.runtime.cleanup).toHaveBeenCalledTimes(1);
          expect(
            await a.repositories.temporarySkills.forRun(
              a.input.runId,
              signal(),
            ),
          ).toBeNull();
          const attempts = (
            await f.observer.query(
              "SELECT tool_name,runtime_call_stopped FROM tool_attempts ORDER BY tool_name",
            )
          ).rows;
          expect(attempts).toEqual(
            ordinary
              ? [
                  { tool_name: "bash", runtime_call_stopped: false },
                  { tool_name: "load_skill", runtime_call_stopped: true },
                ]
              : [{ tool_name: "load_skill", runtime_call_stopped: true }],
          );
          expect(
            (
              await f.observer.query(
                "SELECT barrier_id FROM runtime_barrier_cycles WHERE retired_at IS NULL",
              )
            ).rowCount,
          ).toBe(ordinary ? 1 : 0);
          expect(
            (
              await f.observer.query(
                "SELECT state,tool_effect_state FROM runs WHERE id=$1",
                [a.input.runId],
              )
            ).rows[0],
          ).toEqual({ state: "unresolved", tool_effect_state: "unknown" });
        });
      });
    }
    for (const table of ["tool_attempts", "runtime_barrier_cycles"])
      it(`rolls back all cleanup receipts on a ${table} write failure`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(f);
          await protectedRun(f, a);
          await f.observer
            .query(`CREATE FUNCTION reject_temporary_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'temporary receipt failure'; END $$;
        CREATE TRIGGER reject_temporary_receipt BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_temporary_receipt()`);
          const actual = consumer(a.repositories.temporarySkills),
            before = await snapshot(f);
          await expect(
            actual.service.release(a.record, signal()),
          ).rejects.toThrow("temporary receipt failure");
          expect(actual.runtime.cleanup).toHaveBeenCalledTimes(1);
          expect(await snapshot(f)).toBe(before);
        });
      });
    it("does not treat a global legacy cleanup candidate as permission to dispatch", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        await protectedRun(f, a);
        const legacy = createLegacyAgentRepositories(
            f.kernelA,
            f.secretBox,
            signal(),
          ),
          actual = consumer(legacy.temporarySkills);
        const candidate = await actual.service.next(null, signal());
        expect(candidate).toEqual(a.record);
        await denied(f, () => actual.service.release(candidate!, signal()));
        expect(actual.runtime.cleanup).not.toHaveBeenCalled();
      });
    });
  },
);
