import { describe, expect, it, vi } from "vitest";
import {
  LearningStatusReader,
  type LearningStatus,
} from "../../src/application/learning-status-reader.js";

const identity = { organizationId: "org", agentId: "agent", principalId: "owner" };
describe("owner-scoped learning status", () => {
  it("checks access before reading the owner projection", async () => {
    const repository = { read: vi.fn(() => Promise.resolve({ agentId: "agent", blocked: null })) };
    const access = {
      withAccess: vi.fn(async (_identity: typeof identity, work: () => Promise<LearningStatus>) =>
        work(),
      ),
    };
    expect(await new LearningStatusReader(access, repository).read(identity)).toEqual({
      agentId: "agent",
      blocked: null,
    });
    expect(access.withAccess).toHaveBeenCalledOnce();
    expect(repository.read).toHaveBeenCalledWith({
      organizationId: "org",
      agentId: "agent",
      ownerId: "owner",
    });
  });
  it("does not query stored blockers when access is denied", async () => {
    const repository = { read: vi.fn(() => Promise.resolve({ agentId: "agent", blocked: null })) };
    const access = { withAccess: vi.fn(() => Promise.reject(new Error("access denied"))) };
    await expect(new LearningStatusReader(access, repository).read(identity)).rejects.toThrow(
      "access denied",
    );
    expect(repository.read).not.toHaveBeenCalled();
  });
});
