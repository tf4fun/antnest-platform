import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostgresPeerMembership } from "../../../../../services/agent-acp-service/src/adapters/postgres/peer-membership.js";
import { parsePeerMembership } from "../../../../../services/agent-acp-service/src/adapters/peer-authentication.js";
import {
  withDatabase,
  type FencingFixture,
} from "../../support/run-fencing-fixture.js";

const catalog = () => ({
  version: 1,
  cluster_id: randomUUID(),
  members: [
    { member_id: "acp-a", origin: "http://acp-a.internal:8083" },
    { member_id: "acp-b", origin: "http://acp-b.internal:8083" },
  ],
});
const parse = (input: ReturnType<typeof catalog>) =>
  parsePeerMembership(Buffer.from(JSON.stringify(input)), "acp-a");
function hasCode(error: unknown, code: string): boolean {
  return error instanceof AggregateError
    ? error.errors.some((child: unknown) => hasCode(child, code))
    : error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === code;
}

async function holdTable(f: FencingFixture): Promise<() => Promise<void>> {
  const client = await f.observer.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "LOCK TABLE acp_peer_membership IN ACCESS EXCLUSIVE MODE",
    );
  } catch (error) {
    client.release(true);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= (async () => {
      let failure: Error | undefined;
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error("Pin fixture rollback failed");
        throw error;
      } finally {
        client.release(failure);
      }
    })());
}

describe.skipIf(process.env.ANTNEST_ACP_TEST_DATABASE_URL === undefined)(
  "immutable ACP peer membership",
  () => {
    it("keeps the unconfigured legacy path empty, and pins an identical catalog once across restarts", async () => {
      await withDatabase(async (f) => {
        const a = new PostgresPeerMembership(f.kernelA),
          b = new PostgresPeerMembership(f.kernelB);
        await a.assertPinned();
        expect(
          (await f.observer.query("SELECT * FROM acp_peer_membership")).rows,
        ).toEqual([]);
        const input = catalog();
        await a.assertPinned(parse(input));
        const before = (
          await f.observer.query("SELECT * FROM acp_peer_membership")
        ).rows;
        expect(before).toHaveLength(1);
        input.members.reverse();
        await b.assertPinned(parse(input));
        expect(
          (await f.observer.query("SELECT * FROM acp_peer_membership")).rows,
        ).toEqual(before);
      });
    });

    it.each(["cluster", "remove-member", "origin", "disabled"])(
      "refuses %s without rewriting the original row",
      async (kind) => {
        await withDatabase(async (f) => {
          const input = catalog(),
            store = new PostgresPeerMembership(f.kernelA);
          await store.assertPinned(parse(input));
          const before = (
            await f.observer.query("SELECT * FROM acp_peer_membership")
          ).rows;
          if (kind === "cluster") input.cluster_id = randomUUID();
          if (kind === "remove-member") input.members.pop();
          if (kind === "origin")
            input.members[1]!.origin = "http://replacement.internal:8083";
          await expect(
            new PostgresPeerMembership(f.kernelB).assertPinned(
              kind === "disabled" ? undefined : parse(input),
            ),
          ).rejects.toThrow("acp_peer_membership_conflict");
          expect(
            (await f.observer.query("SELECT * FROM acp_peer_membership")).rows,
          ).toEqual(before);
        });
      },
    );

    it.each([true, false])(
      "serializes simultaneous first pin with identical=%s using the singleton",
      async (same) => {
        await withDatabase(async (f) => {
          const first = parse(catalog()),
            second = same ? first : parse(catalog());
          const release = await holdTable(f);
          const operations = [
            new PostgresPeerMembership(f.kernelA).assertPinned(first),
            new PostgresPeerMembership(f.kernelB).assertPinned(second),
          ];
          const outcomes = f.observe(Promise.allSettled(operations));
          try {
            await f.waitForBlockedWriter(f.nameA);
            await f.waitForBlockedWriter(f.nameB);
          } finally {
            await release();
          }
          const results = await outcomes;
          expect(
            results.filter((result) => result.status === "fulfilled"),
          ).toHaveLength(same ? 2 : 1);
          const rows = (
            await f.observer.query<{ membership_sha256: string }>(
              "SELECT * FROM acp_peer_membership",
            )
          ).rows;
          expect(rows).toHaveLength(1);
          const row = rows[0];
          if (row === undefined) throw new Error("peer membership pin missing");
          expect([first.sha256, second.sha256]).toContain(
            row.membership_sha256,
          );
        });
      },
    );

    it("captures the complete caller catalog before waiting and rejects a fabricated digest", async () => {
      await withDatabase(async (f) => {
        const parsed = parse(catalog()),
          store = new PostgresPeerMembership(f.kernelA);
        await expect(
          store.assertPinned({ ...parsed, sha256: "0".repeat(64) }),
        ).rejects.toThrow("acp_peer_configuration_invalid");
        expect(
          (await f.observer.query("SELECT * FROM acp_peer_membership")).rows,
        ).toEqual([]);
        const input = {
          ...parsed,
          members: parsed.members.map((member) => ({ ...member })),
        };
        const release = await holdTable(f);
        const operation = f.observe(store.assertPinned(input));
        const outcome = operation.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await f.waitForBlockedWriter(f.nameA);
          input.members[1]!.origin = "http://changed.internal:8083";
          input.clusterId = randomUUID();
        } finally {
          try {
            await release();
          } finally {
            await outcome;
          }
        }
        await operation;
        await store.assertPinned(parsed);
      });
    });

    it("rolls back a failed first transaction and retains a real commit after a lost completion", async () => {
      await withDatabase(async (f) => {
        const store = new PostgresPeerMembership(f.kernelA);
        const input = parse(catalog());
        const original = f.kernelA.transaction.bind(f.kernelA);
        const rollback = new Error("injected before commit");
        const spy = vi.spyOn(f.kernelA, "transaction");
        try {
          spy.mockImplementationOnce((operation, options) =>
            original(async (client) => {
              await operation(client);
              throw rollback;
            }, options),
          );
          await expect(store.assertPinned(input)).rejects.toBe(rollback);
          expect(
            (await f.observer.query("SELECT * FROM acp_peer_membership")).rows,
          ).toEqual([]);
          const lost = new Error("completion lost after real commit");
          spy.mockImplementationOnce(async (operation, options) => {
            await original(operation, options);
            throw lost;
          });
          await expect(store.assertPinned(input)).rejects.toBe(lost);
        } finally {
          spy.mockRestore();
        }
        const before = (
          await f.observer.query("SELECT * FROM acp_peer_membership")
        ).rows;
        expect(before).toHaveLength(1);
        await new PostgresPeerMembership(f.kernelB).assertPinned(input);
        await expect(store.assertPinned(parse(catalog()))).rejects.toThrow(
          "acp_peer_membership_conflict",
        );
        expect(
          (await f.observer.query("SELECT * FROM acp_peer_membership")).rows,
        ).toEqual(before);
      });
    });

    it("rejects SQL updates, deletes and truncation of a committed pin", async () => {
      await withDatabase(async (f) => {
        await new PostgresPeerMembership(f.kernelA).assertPinned(
          parse(catalog()),
        );
        const before = (
          await f.observer.query("SELECT * FROM acp_peer_membership")
        ).rows;
        for (const [sql, code] of [
          [
            "UPDATE acp_peer_membership SET membership_sha256=repeat('0',64)",
            "23514",
          ],
          ["DELETE FROM acp_peer_membership", "23514"],
          ["TRUNCATE acp_peer_membership", "0A000"],
          ["TRUNCATE acp_peer_membership CASCADE", "23514"],
        ] as const)
          await expect(f.b.query(sql)).rejects.toHaveProperty("code", code);
        expect(
          (await f.observer.query("SELECT * FROM acp_peer_membership")).rows,
        ).toEqual(before);
      });
    });

    it("expires a blocked original transaction while the database lock is still held", async () => {
      await withDatabase(async (f) => {
        const store = new PostgresPeerMembership(f.kernelA),
          input = parse(catalog());
        await store.assertPinned(input);
        const release = await holdTable(f);
        let complete = false;
        const result = store
          .assertPinned(input, { timeoutMs: 500 })
          .catch((error: unknown) => error)
          .finally(() => {
            complete = true;
          });
        try {
          await f.waitForBlockedWriter(f.nameA);
          await expect.poll(() => complete, { timeout: 2000 }).toBe(true);
          expect(hasCode(await result, "25P04")).toBe(true);
        } finally {
          try {
            await release();
          } finally {
            await result;
          }
        }
        await new PostgresPeerMembership(f.kernelB).assertPinned(input);
      });
    });
  },
);
