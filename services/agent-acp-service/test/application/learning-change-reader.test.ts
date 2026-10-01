import { describe, expect, it, vi } from "vitest";

import { LearningChangeReader } from "../../src/application/learning-change-reader.js";
import { LearningChangeCursor } from "../../src/domain/learning-change-cursor.js";

const identity = { organizationId: "org-1", agentId: "agent-1", principalId: "owner-1" };
const scope = {
  organizationId: identity.organizationId,
  agentId: identity.agentId,
  ownerId: identity.principalId,
};
const cursor = new LearningChangeCursor(Buffer.alloc(32, 7), () => 1_790_700_000);
const item = {
  changeId: "change-1",
  sequence: "2",
  agentId: identity.agentId,
  kind: "skill_created" as const,
  occurredAt: "2026-09-29T00:00:00.000Z",
  skillName: "inspect-first",
  changeSummary: "已新增 Skill「inspect-first」",
};

function fixture() {
  const repository = {
    page: vi.fn(() =>
      Promise.resolve({
        sealedSequence: "2",
        items: [item],
        hasMoreOlder: false,
        hasMoreForward: false,
      }),
    ),
  };
  const access = {
    withAccess: vi.fn(
      (_identity: typeof identity, work: () => ReturnType<typeof repository.page>) => work(),
    ),
  };
  return { access, repository, reader: new LearningChangeReader(access, repository, cursor) };
}

describe("Skill learning change reader", () => {
  it("returns latest changes with a sealed forward cursor", async () => {
    const f = fixture();
    const page = await f.reader.list(identity, {}, 20);
    expect(page.items).toEqual([item]);
    expect(cursor.decode(page.sealedCursor, scope, "after")).toBe("2");
    expect(page.nextCursor).toBe(page.sealedCursor);
    expect(page.olderCursor).toBeNull();
    expect(f.access.withAccess).toHaveBeenCalledWith(identity, expect.any(Function));
  });

  it("advances an incremental page only through its returned items", async () => {
    const f = fixture();
    f.repository.page.mockResolvedValueOnce({
      sealedSequence: "9",
      items: [item],
      hasMoreOlder: false,
      hasMoreForward: true,
    });
    const page = await f.reader.list(identity, { after: "0" }, 1);
    expect(f.repository.page).toHaveBeenCalledWith(scope, { kind: "after", sequence: "0" }, 1);
    expect(cursor.decode(page.nextCursor, scope, "after")).toBe("2");
    expect(cursor.decode(page.sealedCursor, scope, "after")).toBe("9");
  });

  it("rejects a cursor from another owner before querying the repository", async () => {
    const f = fixture();
    const foreign = cursor.encode({ ...scope, ownerId: "other" }, "after", "2");
    await expect(f.reader.list(identity, { after: foreign }, 20)).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(f.repository.page).not.toHaveBeenCalled();
  });

  it("returns genesis for an authorized Agent with no changes", async () => {
    const f = fixture();
    f.repository.page.mockResolvedValueOnce({
      sealedSequence: "0",
      items: [],
      hasMoreOlder: false,
      hasMoreForward: false,
    });
    expect(await f.reader.list(identity, {}, 20)).toEqual({
      items: [],
      nextCursor: "0",
      olderCursor: null,
      sealedCursor: "0",
    });
  });
});
