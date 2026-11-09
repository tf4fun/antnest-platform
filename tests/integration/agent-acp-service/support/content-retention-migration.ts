import type { Pool } from "pg";
import { expect } from "vitest";

export async function contentRetentionFacts(pool: Pool) {
  const rows = (
    await pool.query<{
      id: string;
      state: string;
      deleted_at: Date | null;
      receipt_retained_after_append_version: string | null;
      valid: boolean;
    }>(
      "SELECT id,state,deleted_at,receipt_retained_after_append_version,((state='deleted')=(deleted_at IS NOT NULL)) AS valid FROM acp_sessions ORDER BY id",
    )
  ).rows;
  for (const row of rows) expect(row.valid).toBe(true);
  return rows;
}
