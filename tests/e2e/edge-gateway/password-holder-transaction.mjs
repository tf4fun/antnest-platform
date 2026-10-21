import assert from "node:assert/strict";

const holderQuery =
  "SELECT password_hash FROM local_credentials WHERE user_id=$1 FOR UPDATE";

function assertHolder(row) {
  assert(row !== null && typeof row === "object", "holder row is missing");
  assert(Number.isSafeInteger(row.pid) && row.pid > 0, "invalid holder PID");
  for (const field of ["backend_start", "xact_start"])
    assert(
      typeof row[field] === "string" && row[field].length > 0,
      "holder transaction identity is missing",
    );
  assert(row.state === "idle in transaction", "holder is no longer in Verify");
  assert(
    Array.isArray(row.blockers) && row.blockers.length === 0,
    "holder transaction is blocked",
  );
  assert(
    typeof row.query === "string" &&
      row.query.replace(/\s+/gu, " ").trim() === holderQuery,
    "holder transaction advanced during targets",
  );
}

export function assertPasswordHolderTransaction(before, rows) {
  assert(
    Array.isArray(rows) && rows.length === 1,
    "holder left Verify before target completion",
  );
  assertHolder(before);
  const after = rows[0];
  assertHolder(after);
  // PostgreSQL samples wait metadata independently of transaction state.
  // Compare the original backend and transaction, preserving both raw rows.
  for (const field of ["pid", "backend_start", "xact_start"])
    assert(
      before[field] === after[field],
      "holder transaction identity changed",
    );
  return after;
}
