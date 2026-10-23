import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  registration,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const fields = [
  "run_id",
  "receipt_id",
  "organization_id",
  "agent_id",
  "original_registration_id",
  "original_member_id",
  "original_incarnation_id",
  "original_epoch",
  "recovering_registration_id",
  "recovering_member_id",
  "recovering_incarnation_id",
  "recovering_epoch",
  "accepted_at",
] as const;

describe.skipIf(databaseUrl === undefined)(
  "immutable recovery audit binding",
  () => {
    it.each([
      "run_id",
      "organization_id",
      "agent_id",
      "original_registration_id",
      "original_member_id",
      "original_incarnation_id",
      "original_epoch",
      "recovering_registration_id",
      "recovering_member_id",
      "recovering_incarnation_id",
    ] as const)(
      "rejects a wrong %s before immutable evidence is inserted",
      async (field) => {
        await withDatabase(async (f) => {
          const session = await f.session(scope("audit"));
          const owner = await f.owner(session.binding);
          const intent = f.input(session);
          await owner.runs.createRunIntent(intent);
          const otherSession = await f.session(scope("other"));
          const otherOwner = await f.owner(otherSession.binding);
          const other = f.input(otherSession);
          await otherOwner.runs.createRunIntent(other);
          let next = await f.successor(owner);
          if (field === "original_epoch") {
            expect(await f.leasesB.release(next.authority.fence)).toBe(true);
            next = await f.owner(session.binding, registration("acp-third"));
          }
          const old = owner.authority.registration;
          const current = next.authority.registration;
          const proof = {
            ...old,
            state: "stopped",
            stop_receipt: {
              receipt_id: randomUUID(),
              reason: "container_stopped",
              observed_at: "2026-10-24T00:00:00.123456789Z",
            },
          };
          await f.observer.query(
            "INSERT INTO owner_stop_receipts(receipt_id,registration_id,inspection,accepted_at) VALUES($1,$2,$3::jsonb,now())",
            [
              proof.stop_receipt.receipt_id,
              old.registration_id,
              JSON.stringify(proof),
            ],
          );
          const valid: Array<string | Date> = [
            intent.runId,
            proof.stop_receipt.receipt_id,
            session.binding.organizationId,
            session.binding.agentId,
            old.registration_id,
            old.member_id,
            old.incarnation_id,
            owner.authority.fence.epoch,
            current.registration_id,
            current.member_id,
            current.incarnation_id,
            next.authority.fence.epoch,
            new Date(),
          ];
          const invalid = [...valid];
          const changed =
            field === "run_id"
              ? other.runId
              : field === "original_epoch"
                ? "2"
                : field.startsWith("recovering_")
                  ? "INVALID identity"
                  : field.endsWith("registration_id") ||
                      field.endsWith("incarnation_id")
                    ? randomUUID()
                    : "wrong-scope";
          invalid[fields.indexOf(field)] = changed;
          const sql = `INSERT INTO run_owner_recoveries(${fields.join(",")}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(",")})`;
          await expect(f.observer.query(sql, invalid)).rejects.toMatchObject({
            code: expect.stringMatching(/^23/u),
          });
          expect(
            (await f.observer.query("SELECT * FROM run_owner_recoveries")).rows,
          ).toHaveLength(0);
          await f.observer.query(sql, valid);
          expect(
            (await f.observer.query("SELECT run_id FROM run_owner_recoveries"))
              .rows,
          ).toEqual([{ run_id: intent.runId }]);
        });
      },
    );
  },
);
