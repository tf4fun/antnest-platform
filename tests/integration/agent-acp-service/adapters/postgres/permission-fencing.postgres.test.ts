import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOwnedAgentRepositories,
  createLegacyAgentRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { ToolPermissions } from "../../../../../services/agent-acp-service/src/application/tool-permissions.js";
import { PermissionConnections } from "../../../../../services/agent-acp-service/src/application/permission-connections.js";
import { AccessService } from "../../../../../services/agent-acp-service/src/application/access-service.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { permissionRule } from "../../../../../services/agent-acp-service/src/domain/tool-permissions.js";
import type {
  PermissionRequest,
  PermissionRepository,
} from "../../../../../services/agent-acp-service/src/ports/tool-permissions.js";
import { localExecution } from "../../../../../services/agent-acp-service/test/support/local-execution.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
  type Session,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const selected = { outcome: { outcome: "selected", optionId: "allow_always" } };
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
  await repositories.runs.acceptRun(f.acceptance(session, intent.runId));
  const request: PermissionRequest = {
    runId: intent.runId,
    sessionId: session.sessionId,
    call: {
      id: randomUUID(),
      name: "write",
      arguments: { content: "exact\u0000payload" },
    },
    tool: {
      source: "runtime",
      sourceId: "runtime",
      name: "write",
      modelName: "write",
      description: "write",
    },
  };
  return { session, owner, repositories, request };
}
const decision = (
  request: PermissionRequest,
): Parameters<PermissionRepository["decide"]>[0] => ({
  request: structuredClone(request),
  result: { decision: "allow_always", reason: "client_response" },
  rule: permissionRule(request.tool, "allow_always")!,
});
async function snapshot(f: FencingFixture) {
  const result = await f.observer.query<{ value: string }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.run_id,p.tool_call_id),'[]'::jsonb)::text AS value FROM tool_permissions p`,
  );
  return JSON.stringify([await f.snapshot(), result.rows[0]?.value]);
}
async function denied(f: FencingFixture, operation: () => Promise<unknown>) {
  const before = await snapshot(f);
  await expect(operation()).rejects.toBeInstanceOf(AgentOwnershipLostError);
  expect(await snapshot(f)).toBe(before);
}
async function consumer(
  repository: PermissionRepository,
  session: Session,
  respond: () => Promise<unknown>,
) {
  const { directory } = await localExecution();
  const connections = new PermissionConnections();
  const connection = new AbortController();
  connections.attach({
    binding: session.binding,
    sessionId: session.sessionId,
    signal: connection.signal,
    request: respond,
  });
  return {
    permissions: new ToolPermissions(
      repository,
      connections,
      new AccessService({ directory }),
    ),
    close: () => connection.abort(new Error("fixture closed")),
  };
}

describe.skipIf(databaseUrl === undefined)(
  "original Run-bound permission persistence",
  () => {
    it("refuses a real allow_always reply after takeover without saving permission or Session rules", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const approval = Promise.withResolvers<unknown>();
        let entered = false;
        const actual = await consumer(
          a.repositories.permissions,
          a.session,
          () => {
            entered = true;
            return approval.promise;
          },
        );
        const pending = f.observe(
          actual.permissions
            .request({
              ...a.request,
              signal: new AbortController().signal,
              authoritySignal: new AbortController().signal,
            })
            .then(
              (value) => value,
              (error: unknown) => error,
            ),
        );
        try {
          await expect.poll(() => entered).toBe(true);
          await f.successor(a.owner);
          const before = await snapshot(f);
          approval.resolve(selected);
          expect(await pending).toBeInstanceOf(AgentOwnershipLostError);
          expect(await snapshot(f)).toBe(before);
        } finally {
          approval.resolve(selected);
          await pending;
          actual.close();
        }
      });
    });

    for (const mode of ["stale", "successor", "legacy"] as const) {
      for (const state of ["pending", "decided", "terminal"] as const) {
        it(`rejects ${mode} open/decision on ${state} predecessor identity before noop handling`, async () => {
          await withDatabase(async (f) => {
            const a = await setup(f);
            await a.repositories.permissions.open(a.request);
            if (state === "decided")
              expect(
                await a.repositories.permissions.decide(decision(a.request)),
              ).toBe(true);
            if (state === "terminal")
              await a.repositories.executions.finish({
                runId: a.request.runId,
                terminalClass: "cancelled",
                executorState: "quiescent",
                toolEffectState: "none",
                finishedAt: new Date(),
              });
            const b = await f.successor(a.owner);
            const repositories =
              mode === "stale"
                ? a.repositories
                : mode === "successor"
                  ? createOwnedAgentRepositories(
                      f.kernelB,
                      f.secretBox,
                      b.authority,
                    )
                  : createLegacyAgentRepositories(
                      f.kernelA,
                      f.secretBox,
                      new AbortController().signal,
                    );
            await denied(f, () =>
              repositories.permissions.open({
                ...a.request,
                call: { ...a.request.call, id: randomUUID() },
              }),
            );
            await denied(f, () =>
              repositories.permissions.decide(decision(a.request)),
            );
          });
        });
      }
    }

    it("captures the original consumer authority signal while waiting for a reply", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const approval = Promise.withResolvers<unknown>();
        let entered = false;
        const actual = await consumer(
          a.repositories.permissions,
          a.session,
          () => {
            entered = true;
            return approval.promise;
          },
        );
        const original = new AbortController();
        const input = {
          ...a.request,
          signal: new AbortController().signal,
          authoritySignal: original.signal,
        };
        const pending = f.observe(
          actual.permissions.request(input).then(
            (value) => value,
            (error: unknown) => error,
          ),
        );
        const loss = new Error("original permission authority lost");
        try {
          await expect.poll(() => entered).toBe(true);
          const before = await snapshot(f);
          input.authoritySignal = new AbortController().signal;
          original.abort(loss);
          approval.resolve(selected);
          expect(await pending).toBe(loss);
          expect(await snapshot(f)).toBe(before);
        } finally {
          approval.resolve(selected);
          await pending;
          actual.close();
        }
      });
    });

    for (const kind of ["authority", "run"] as const) {
      it(`keeps the original ${kind} signal after a real row-lock wait`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(f);
          await a.repositories.permissions.open(a.request);
          const signal = new AbortController();
          const input = {
            ...decision(a.request),
            signal: new AbortController().signal,
            authoritySignal: new AbortController().signal,
          };
          if (kind === "authority") input.authoritySignal = signal.signal;
          else input.signal = signal.signal;
          const before = await snapshot(f);
          const held = await f.holdSession(a.session.sessionId);
          const outcome = f.observe(
            a.repositories.permissions.decide(input).then(
              (value) => value,
              (error: unknown) => error,
            ),
          );
          await f.waitForBlockedWriter();
          if (kind === "authority")
            input.authoritySignal = new AbortController().signal;
          else input.signal = new AbortController().signal;
          const loss = new Error("original request aborted");
          signal.abort(loss);
          await f.release(held);
          if (kind === "authority") {
            expect(await outcome).toBe(loss);
            expect(await snapshot(f)).toBe(before);
          } else {
            expect(await outcome).toBe(false);
            expect(
              (
                await f.observer.query(
                  "SELECT decision,reason FROM tool_permissions",
                )
              ).rows,
            ).toEqual([{ decision: "cancelled", reason: "permission_stale" }]);
            expect(
              (
                await a.repositories.sessionConfiguration.get(
                  a.session.sessionId,
                )
              ).configuration,
            ).toEqual({});
          }
        });
      });
    }

    it("captures request, result and rule before waiting for a Session lock", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        await a.repositories.permissions.open(a.request);
        const input = decision(a.request);
        const held = await f.holdSession(a.session.sessionId);
        const pending = f.observe(a.repositories.permissions.decide(input));
        await f.waitForBlockedWriter();
        input.request.call.arguments = { content: "mutated" };
        input.result.decision = "reject_always";
        input.rule!.decision = "deny";
        await f.release(held);
        expect(await pending).toBe(true);
        expect(
          (await a.repositories.sessionConfiguration.get(a.session.sessionId))
            .configuration.toolRules,
        ).toEqual([permissionRule(a.request.tool, "allow_always")]);
      });
    });

    it("refuses owned global cleanup, and legacy cleanup rolls back a mixed pending set", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const legacy = createLegacyAgentRepositories(
          f.kernelA,
          f.secretBox,
          new AbortController().signal,
        );
        const session = await f.session(scope("legacy-agent"));
        const intent = f.input(session);
        await legacy.runs.createRunIntent(intent);
        await legacy.runs.acceptRun(f.acceptance(session, intent.runId));
        await legacy.permissions.open({
          ...a.request,
          runId: intent.runId,
          sessionId: session.sessionId,
        });
        await a.repositories.permissions.open(a.request);
        await denied(f, () => a.repositories.permissions.cancelAbandoned());
        await denied(f, () => legacy.permissions.cancelAbandoned());
      });
    });

    it("legacy cleanup cancels only its locked selection and leaves a later pending request alone", async () => {
      await withDatabase(async (f) => {
        const legacyA = createLegacyAgentRepositories(
          f.kernelA,
          f.secretBox,
          new AbortController().signal,
        );
        const legacyB = createLegacyAgentRepositories(
          f.kernelB,
          f.secretBox,
          new AbortController().signal,
        );
        const requests: PermissionRequest[] = [];
        for (const agent of ["cleanup-first", "cleanup-later"]) {
          const session = await f.session(scope(agent));
          const intent = f.input(session);
          await legacyA.runs.createRunIntent(intent);
          await legacyA.runs.acceptRun(f.acceptance(session, intent.runId));
          requests.push({
            runId: intent.runId,
            sessionId: session.sessionId,
            call: { id: randomUUID(), name: "write", arguments: {} },
            tool: {
              source: "runtime",
              sourceId: "runtime",
              name: "write",
              modelName: "write",
              description: "write",
            },
          });
        }
        const first = requests[0]!;
        const later = requests[1]!;
        await legacyA.permissions.open(first);
        const held = await f.holdSession(first.sessionId);
        await held.query(
          "SELECT run_id FROM tool_permissions WHERE run_id=$1 FOR UPDATE",
          [first.runId],
        );
        const cleanup = f.observe(legacyA.permissions.cancelAbandoned());
        await f.waitForBlockedWriter();
        await legacyB.permissions.open(later);
        await f.release(held);
        await cleanup;
        expect(
          (
            await f.observer.query(
              "SELECT decision FROM tool_permissions WHERE run_id=$1",
              [first.runId],
            )
          ).rows,
        ).toEqual([{ decision: "cancelled" }]);
        expect(
          (
            await f.observer.query(
              "SELECT decision FROM tool_permissions WHERE run_id=$1",
              [later.runId],
            )
          ).rows,
        ).toEqual([{ decision: null }]);
      });
    });

    it("commits a current consumer approval once and rolls back both tables on rule failure", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const actual = await consumer(
          a.repositories.permissions,
          a.session,
          () => Promise.resolve(selected),
        );
        try {
          await expect(
            actual.permissions.request({
              ...a.request,
              signal: new AbortController().signal,
              authoritySignal: new AbortController().signal,
            }),
          ).resolves.toEqual({
            decision: "allow_always",
            reason: "client_response",
          });
          expect(
            await a.repositories.permissions.decide(decision(a.request)),
          ).toBe(false);
          expect(
            await a.repositories.sessionConfiguration.get(a.session.sessionId),
          ).toMatchObject({
            revision: 1,
            configuration: {
              toolRules: [permissionRule(a.request.tool, "allow_always")],
            },
          });
          const next = {
            ...a.request,
            call: { ...a.request.call, id: randomUUID() },
          };
          await a.repositories.permissions.open(next);
          await f.observer
            .query(`CREATE FUNCTION reject_permission_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'permission_rule_rollback'; END $$;
          CREATE TRIGGER reject_permission_rule BEFORE UPDATE ON acp_sessions FOR EACH ROW EXECUTE FUNCTION reject_permission_rule()`);
          const before = await snapshot(f);
          await expect(
            a.repositories.permissions.decide(decision(next)),
          ).rejects.toMatchObject({ message: "permission_rule_rollback" });
          expect(await snapshot(f)).toBe(before);
        } finally {
          actual.close();
        }
      });
    });
  },
);
