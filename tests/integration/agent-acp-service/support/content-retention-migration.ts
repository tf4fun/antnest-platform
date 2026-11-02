import type { Pool } from "pg";
import { expect } from "vitest";

export async function contentRetentionFacts(pool: Pool) {
  const rows = (
    await pool.query<{
      id: string;
      state: string;
      deleted_at: Date | null;
      valid: boolean;
    }>(
      "SELECT id,state,deleted_at,((state='deleted')=(deleted_at IS NOT NULL)) AS valid FROM acp_sessions ORDER BY id",
    )
  ).rows;
  for (const row of rows) expect(row.valid).toBe(true);
  return rows;
}
