import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { assertPasswordHolderTransaction } from "./password-holder-transaction.mjs";

const holderQuery =
  "SELECT password_hash FROM local_credentials WHERE user_id=$1 FOR UPDATE";

// The row is the actual pg_stat_activity projection used by verifyBusy.
// It proves transaction identity and state, not that a KDF can be restarted.
function fixture() {
  return {
    pid: 647,
    backend_start: "2026-10-21 19:17:07.709959+00",
    xact_start: "2026-10-21 19:18:57.260309+00",
    state: "idle in transaction",
    wait_event_type: null,
    query: holderQuery,
    blockers: [],
  };
}

function acceptsOriginal(before, after) {
  const rows = [after];
  const original = structuredClone({ before, rows });
  assert.equal(assertPasswordHolderTransaction(before, rows), after);
  assert.deepEqual({ before, rows }, original);
}

test("the unchanged holder returns the actual after row without changing either snapshot", () => {
  acceptsOriginal(fixture(), fixture());
});

for (const [prior, current] of [
  [null, "Client"],
  ["Client", null],
])
  test(`the same holder accepts transient wait_event_type ${prior} to ${current}`, () => {
    const before = fixture(),
      after = fixture();
    before.wait_event_type = prior;
    after.wait_event_type = current;
    acceptsOriginal(before, after);
  });

test("the stable holder query compares after trimming and normalizing whitespace", () => {
  const before = fixture(),
    after = fixture();
  before.query =
    "\n SELECT  password_hash FROM\tlocal_credentials WHERE user_id=$1 FOR UPDATE \n";
  after.query =
    " SELECT password_hash FROM local_credentials\n WHERE user_id=$1  FOR UPDATE\t";
  acceptsOriginal(before, after);
});

test("zero or two matching transactions cannot prove the original holder", () => {
  const before = fixture();
  for (const rows of [[], [fixture(), fixture()]]) {
    const original = structuredClone({ before, rows });
    assert.throws(() => assertPasswordHolderTransaction(before, rows));
    assert.deepEqual({ before, rows }, original);
  }
});

for (const [field, changed] of [
  ["pid", 648],
  ["backend_start", "2026-10-21 19:17:08.709959+00"],
  ["xact_start", "2026-10-21 19:18:58.260309+00"],
  [
    "query",
    "SELECT password_hash FROM local_credentials WHERE user_id=$2 FOR UPDATE",
  ],
  ["state", "active"],
  ["blockers", [648]],
])
  test(`a changed holder ${field} remains a blocking failure`, () => {
    const before = fixture(),
      after = { ...fixture(), [field]: changed };
    const original = structuredClone({ before, after });
    assert.throws(() => assertPasswordHolderTransaction(before, [after]));
    assert.deepEqual({ before, after }, original);
  });

test("matching invalid before and after identities cannot establish a held transaction", () => {
  for (const [field, values] of [
    ["pid", [undefined, null, 0, -1, 1.5, "647", NaN]],
    ["backend_start", [undefined, null, "", 123]],
    ["xact_start", [undefined, null, "", 123]],
    ["query", [undefined, null, "", "SELECT 1", 123]],
    ["state", [undefined, "idle", "active"]],
    ["blockers", [undefined, null, {}, [648]]],
  ]) {
    for (const value of values) {
      const before = { ...fixture(), [field]: value };
      const after = structuredClone(before);
      const original = structuredClone({ before, after });
      assert.throws(() => assertPasswordHolderTransaction(before, [after]));
      assert.deepEqual({ before, after }, original);
    }
  }
});

for (const boundary of ["before", "after"])
  test(`invalid ${boundary} query errors do not expose private SQL evidence`, () => {
    const before = fixture(),
      after = fixture();
    const canary = "PRIVATE-HOLDER-QUERY-CANARY";
    const privateQuery = `SELECT '${canary}' FROM private_credentials`;
    (boundary === "before" ? before : after).query = privateQuery;
    const original = structuredClone({ before, after });
    assert.throws(
      () => assertPasswordHolderTransaction(before, [after]),
      (error) => {
        assert(error instanceof Error);
        for (const text of [
          String(error),
          inspect(error, { depth: null }),
          JSON.stringify(error),
        ]) {
          assert(!text.includes(canary));
          assert(!text.includes(privateQuery));
        }
        return true;
      },
    );
    assert.deepEqual({ before, after }, original);
  });
