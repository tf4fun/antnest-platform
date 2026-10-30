import { describe, expect, it, vi } from "vitest";
import { PostgresExecutionAudits } from "../../src/adapters/postgres/execution-audit.js";
import { auditDetailSchema } from "../../src/domain/execution-audit.js";

function auditRow(executionSnapshot: unknown) {
  return {
    run_id: "run-1",
    session_id: "session-1",
    agent_id: "agent-1",
    principal_id: "owner-1",
    state: "completed",
    created_at: "2026-09-14T00:00:00.123456Z",
    updated_at: "2026-09-14T00:00:00.123456Z",
    input: "prompt",
    execution_snapshot: executionSnapshot,
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "none",
    unknown_effect_source: null,
    stop_reason: "end_turn",
    error_class: null,
    budget_reason: null,
    usage_measurements: [],
  };
}

function setup(rows: object[]) {
  const read = vi.fn().mockResolvedValue({ rows });
  return {
    read,
    audits: new PostgresExecutionAudits({ read } as never),
    signal: new AbortController().signal,
  };
}

describe("live model revision audit projection", () => {
  it("exposes the primary admitted revision from the stored snapshot only", async () => {
    const { read, audits, signal } = setup([auditRow({ modelProfileRevision: 7 })]);
    const detail = await audits.get("org-1", "run-1", signal);
    expect(detail?.model_profile_revision).toBe(7);
    expect(read).toHaveBeenCalledWith(expect.any(String), ["org-1", "run-1"], signal);
  });

  it.each([{ modelProfileRevision: null }, {}, { modelProfileId: "profile-1" }])(
    "reports null for a historical snapshot without a usable revision: %j",
    async (snapshot) => {
      const { audits, signal } = setup([auditRow(snapshot)]);
      const detail = await audits.get("org-1", "run-1", signal);
      expect(detail?.model_profile_revision).toBeNull();
    },
  );

  it.each([
    { modelProfileRevision: "7" },
    { modelProfileRevision: 0 },
    { modelProfileRevision: 1.5 },
    { modelProfileRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects a stored snapshot with the invalid revision %j", async (snapshot) => {
    const { audits, signal } = setup([auditRow(snapshot)]);
    await expect(audits.get("org-1", "run-1", signal)).rejects.toThrow();
  });

  it("keeps the revision inside the strict audit detail contract", () => {
    const row = { ...auditRow({}), budget_reason: undefined };
    const valid = auditDetailSchema.parse({
      ...row,
      execution_snapshot: { modelProfileRevision: 7 },
      model_profile_revision: 7,
    });
    expect(valid.model_profile_revision).toBe(7);
    const legacy = auditDetailSchema.parse({ ...row, model_profile_revision: null });
    expect(legacy.model_profile_revision).toBeNull();
    expect(() => auditDetailSchema.parse({ ...row, model_profile_revision: 0 })).toThrow();
  });
});
