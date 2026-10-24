import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresAgentStartup } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-startup.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { withDatabase, scope } from "../../support/run-fencing-fixture.js";
import {
  run,
  permission,
  pendingLearning,
  unchanged,
} from "../../support/startup-recovery-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "fenced lifecycle settlement inventory",
  () => {
    it.each(["pristine", "budget", "evidence"] as const)(
      "does not lose %s legacy pending Learning",
      async (kind) => {
        await withDatabase(async (f) => {
          const target = scope("legacy-settlement");
          const task = await pendingLearning(
            f,
            target,
            new AbortController().signal,
            false,
          );
          if (kind === "budget")
            await f.observer.query(
              "UPDATE learning_tasks SET model_calls=1 WHERE id=$1",
              [task.taskId],
            );
          if (kind === "evidence")
            await f.observer.query(
              "INSERT INTO learning_evidence_snapshots(task_id,source_run_id,claim_id,generation,digest,truncated) VALUES($1,$2,$3,1,$4,false)",
              [
                task.taskId,
                task.source.input.runId,
                randomUUID(),
                "a".repeat(64),
              ],
            );
          const owner = await f.owner(target);
          const before = await unchanged(f);
          expect(
            await new PostgresAgentStartup(f.kernelA).settlement(
              owner.authority.fence,
            ),
          ).toEqual({
            localUncertain: kind !== "pristine",
            runtimeProtected: false,
          });
          expect(await unchanged(f)).toEqual(before);
        });
      },
    );

    it("reads an empty owned scope without changing facts and rejects the stale fence", async () => {
      await withDatabase(async (f) => {
        const owner = await f.owner(scope("empty-settlement"));
        const inventory = new PostgresAgentStartup(f.kernelA);
        const before = await unchanged(f);
        expect(await inventory.settlement(owner.authority.fence)).toEqual({
          localUncertain: false,
          runtimeProtected: false,
        });
        expect(await unchanged(f)).toEqual(before);
        await f.successor(owner);
        await expect(
          inventory.settlement(owner.authority.fence),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
      });
    });

    for (const variant of [
      "active",
      "no-proof",
      "stopped",
      "foreign-proof",
      "permission",
      "temporary",
      "foreign-temporary",
      "bad-runtime",
    ] as const) {
      it(`classifies ${variant} by original Run identity and proof, without rewriting facts`, async () => {
        await withDatabase(async (f) => {
          const value = await run(
            f,
            scope("settlement-run"),
            new AbortController().signal,
            true,
          );
          const owner = value.owner!;
          if (variant === "permission") await permission(value);
          if (variant === "temporary" || variant === "foreign-temporary") {
            await value.repositories.temporarySkills.reserve({
              runId: value.input.runId,
              snapshot: f.acceptance(value.session, value.input.runId).snapshot,
              signal: new AbortController().signal,
            });
            if (variant === "foreign-temporary")
              await f.observer.query(
                "UPDATE temporary_skill_scopes SET agent_id='foreign' WHERE run_id=$1",
                [value.input.runId],
              );
          } else {
            await value.repositories.events.startToolAttempt({
              id: randomUUID(),
              runId: value.input.runId,
              toolCallId: "runtime-1",
              tool: {
                source: "runtime",
                sourceId: "runtime",
                name: "write",
                modelName: "write",
                description: "write",
              },
              arguments: {},
              requestDigest: "digest",
              createdAt: new Date(),
            });
          }
          if (variant !== "active") {
            await value.repositories.executions.finish({
              runId: value.input.runId,
              terminalClass: "unresolved",
              executorState: "quiescent",
              toolEffectState: "unknown",
              unknownEffectSource: "runtime_mcp",
              errorClass: "fixture",
              finishedAt: new Date(),
            });
            if (variant === "permission")
              await f.observer.query(
                "UPDATE tool_permissions SET decision=NULL,reason=NULL,decided_at=NULL WHERE run_id=$1",
                [value.input.runId],
              );
          }
          const next = await f.successor(owner);
          if (variant === "bad-runtime")
            await f.observer.query(
              "UPDATE runs SET execution_snapshot=jsonb_set(execution_snapshot,'{runtime}','null'::jsonb) WHERE id=$1",
              [value.input.runId],
            );
          if (variant !== "no-proof") {
            const proof = {
              ...owner.authority.registration,
              state: "stopped",
              stop_receipt: {
                receipt_id: randomUUID(),
                reason: "container_stopped",
                observed_at: "2026-10-24T01:02:03.123456789Z",
              },
            };
            if (variant === "foreign-proof") proof.member_id = "other-member";
            await f.observer.query(
              "INSERT INTO owner_stop_receipts(receipt_id,registration_id,inspection,accepted_at) VALUES($1,$2,$3::jsonb,$4)",
              [
                proof.stop_receipt.receipt_id,
                proof.registration_id,
                JSON.stringify(proof),
                new Date(),
              ],
            );
          }
          const before = await unchanged(f);
          expect(
            await new PostgresAgentStartup(f.kernelB).settlement(
              next.authority.fence,
            ),
          ).toEqual({
            localUncertain: !["stopped", "temporary"].includes(variant),
            runtimeProtected: true,
          });
          expect(await unchanged(f)).toEqual(before);
        });
      });
    }
  },
);
