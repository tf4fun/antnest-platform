import { describe, expect, it, vi } from "vitest";
import { ExecutionAudits } from "../../src/application/execution-audit.js";
import type { AuditPrincipal, AuditSummary } from "../../src/domain/execution-audit.js";
import type { ExecutionAuditRepository } from "../../src/ports/execution-audit.js";

const admin: AuditPrincipal = {
  principalId: "admin-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  systemRole: "user",
  organizationRole: "admin",
};
const record: AuditSummary = {
  run_id: "run-1",
  session_id: "session-1",
  agent_id: "deleted-agent",
  principal_id: "owner-1",
  state: "failed",
  created_at: "2026-09-14T00:00:00.123456Z",
  updated_at: "2026-09-14T00:00:00.123456Z",
};
function setup() {
  const repository = {
    list: vi.fn<ExecutionAuditRepository["list"]>().mockResolvedValue([]),
    get: vi.fn<ExecutionAuditRepository["get"]>().mockResolvedValue(null),
    events: vi.fn<ExecutionAuditRepository["events"]>().mockResolvedValue([]),
    permissions: vi.fn<ExecutionAuditRepository["permissions"]>().mockResolvedValue([]),
  };
  return {
    repository,
    service: new ExecutionAudits(repository),
    signal: new AbortController().signal,
  };
}

describe("administrative execution audit queries", () => {
  it("rejects an ordinary owner before touching storage", async () => {
    const { repository, service, signal } = setup();
    const owner = { ...admin, organizationRole: "member" as const };
    await expect(service.list(owner, {}, signal)).rejects.toMatchObject({ code: "access_denied" });
    await expect(service.get(owner, { run_id: "run-1" }, signal)).rejects.toMatchObject({
      code: "access_denied",
    });
    await expect(service.events(owner, { run_id: "run-1" }, signal)).rejects.toMatchObject({
      code: "access_denied",
    });
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });

  it("keeps system administrators within their verified organization", async () => {
    const { repository, service, signal } = setup();
    await service.list({ ...admin, systemRole: "admin", organizationRole: "member" }, {}, signal);
    expect(repository.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", limit: 51 }),
      signal,
    );
    await expect(service.list(admin, { organization_id: "org-2" }, signal)).rejects.toThrow();
    expect(repository.list).toHaveBeenCalledOnce();
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { created_from: "bad" },
    { created_from: "2026-09-15T00:00:00Z", created_until: "2026-09-14T00:00:00Z" },
    { cursor: "not-a-cursor" },
  ])("rejects malformed queries %j", async (input) => {
    const { repository, service, signal } = setup();
    await expect(service.list(admin, input, signal)).rejects.toThrow();
    expect(repository.list).not.toHaveBeenCalled();
  });

  it("binds pagination to organization and filters without losing timestamp precision", async () => {
    const { repository, service, signal } = setup();
    repository.list.mockResolvedValueOnce([record, { ...record, run_id: "run-0" }]);
    const first = await service.list(admin, { agent_id: "deleted-agent", limit: 1 }, signal);
    expect(first.items).toEqual([record]);
    expect(first.next_cursor).toEqual(expect.any(String));
    await service.list(
      admin,
      { agent_id: "deleted-agent", limit: 2, cursor: first.next_cursor },
      signal,
    );
    expect(repository.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: { kind: "time", at: record.created_at, id: record.run_id },
        limit: 3,
      }),
      signal,
    );
    await expect(
      service.list(
        { ...admin, organizationId: "org-2" },
        { agent_id: "deleted-agent", cursor: first.next_cursor },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      service.list(admin, { agent_id: "other", cursor: first.next_cursor }, signal),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(repository.list).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["2026-09-14T00:00:00.123000Z", "2026-09-14T00:00:00.123999Z"],
    ["2026-09-14T00:00:00.123Z", "2026-09-14T00:00:00.123001Z"],
    ["2026-09-14T00:00:00Z", "2026-09-14T00:00:00.000001Z"],
  ])("preserves sub-millisecond interval %s to %s", async (created_from, created_until) => {
    const { repository, service, signal } = setup();
    await service.list(admin, { created_from, created_until }, signal);
    expect(repository.list).toHaveBeenCalledWith(
      expect.objectContaining({ created_from, created_until }),
      signal,
    );
    await expect(
      service.list(admin, { created_from: created_until, created_until: created_from }, signal),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.list).toHaveBeenCalledOnce();
  });

  it("rejects equal instants represented with different precision", async () => {
    const { repository, service, signal } = setup();
    await expect(
      service.list(
        admin,
        {
          created_from: "2026-09-14T00:00:00.123Z",
          created_until: "2026-09-14T00:00:00.123000Z",
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it("round-trips opaque provider tool IDs in permission cursors", async () => {
    const { repository, service, signal } = setup();
    const permission = {
      tool_call_id: "call+外部=" + "x".repeat(4000),
      request: {},
      decision: null,
      reason: null,
      created_at: record.created_at,
      decided_at: null,
    };
    repository.permissions.mockResolvedValueOnce([
      permission,
      { ...permission, tool_call_id: "next" },
    ]);
    const first = await service.events(
      admin,
      { run_id: "run-1", stream: "permissions", limit: 1 },
      signal,
    );
    await service.events(
      admin,
      { run_id: "run-1", stream: "permissions", cursor: first.next_cursor },
      signal,
    );
    expect(repository.permissions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: { kind: "time", at: record.created_at, id: permission.tool_call_id },
      }),
      signal,
    );
  });

  it("reads historical records without a configuration or session activation dependency", async () => {
    const { repository, service, signal } = setup();
    const detail = {
      ...record,
      input: [{ type: "text", text: "original trigger" }],
      execution_snapshot: null,
      terminal_class: null,
      executor_state: null,
      tool_effect_state: null,
      stop_reason: null,
      error_class: "provider_unavailable",
      usage_measurements: [],
    };
    repository.get.mockResolvedValue(detail);
    expect(await service.get(admin, { run_id: record.run_id }, signal)).toEqual(detail);
    expect(repository.get).toHaveBeenCalledWith("org-1", "run-1", signal);
  });

  it("does not mistake unavailable storage for empty history", async () => {
    const { repository, service, signal } = setup();
    repository.list.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(service.list(admin, {}, signal)).rejects.toThrow("Storage unavailable");
    await expect(service.get(admin, { run_id: "missing" }, signal)).rejects.toMatchObject({
      code: "audit_not_found",
    });
  });

  it("does not mix permission cursors with execution sequences", async () => {
    const { repository, service, signal } = setup();
    repository.get.mockResolvedValue({
      ...record,
      input: [],
      execution_snapshot: null,
      terminal_class: null,
      executor_state: null,
      tool_effect_state: null,
      stop_reason: null,
      error_class: null,
      usage_measurements: [],
    });
    repository.events.mockResolvedValueOnce([
      {
        id: "m1",
        sequence: 2,
        kind: "user_message",
        visible: true,
        payload: {},
        created_at: record.created_at,
      },
      {
        id: "m2",
        sequence: 3,
        kind: "agent_message",
        visible: true,
        payload: {},
        created_at: record.created_at,
      },
    ]);
    const first = await service.events(admin, { run_id: "run-1", limit: 1 }, signal);
    await expect(
      service.events(
        admin,
        { run_id: "run-1", stream: "permissions", cursor: first.next_cursor },
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(repository.permissions).not.toHaveBeenCalled();
  });
});
