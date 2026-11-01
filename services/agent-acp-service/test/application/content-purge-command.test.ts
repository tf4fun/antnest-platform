import { describe, expect, it, vi } from "vitest";
import {
  parseContentPurgeArguments,
  runContentPurgeCommand,
} from "../../src/application/content-purge-command.js";
import type { ContentPurger, ContentPurgeBatch } from "../../src/domain/content-retention.js";

const empty = (): ContentPurgeBatch["counts"] => ({
  sessions: 0,
  runs: 0,
  messages: 0,
  toolAttempts: 0,
  learningTasks: 0,
  evidenceItems: 0,
  evidenceSnapshots: 0,
  candidates: 0,
  publishedCandidates: 0,
  learningChanges: 0,
});
const result = (
  scanned: number,
  blocked: number,
  nextCursor: string | null,
  sessions = scanned - blocked,
): ContentPurgeBatch => ({
  scanned,
  blocked,
  counts: { ...empty(), sessions },
  nextCursor,
});
const setup = () => {
  const lines: string[] = [];
  const purge: ContentPurger = { batch: vi.fn<ContentPurger["batch"]>() };
  return {
    purge,
    lines,
    run: (args: string[]) =>
      runContentPurgeCommand({
        args,
        purge,
        batchLimit: 500,
        out: (line) => lines.push(line),
        signal: new AbortController().signal,
      }),
  };
};

describe("parseContentPurgeArguments", () => {
  it.each([
    [["--organization", "org-1", "--dry-run"], { organizationId: "org-1" }, true],
    [["--organization", "org-1", "--confirm"], { organizationId: "org-1" }, false],
    [["--user", "user-1", "--confirm"], { principalId: "user-1" }, false],
    [["--session", "session-1", "--dry-run"], { sessionId: "session-1" }, true],
    [["--dry-run", "--session", "session-1"], { sessionId: "session-1" }, true],
  ])("accepts %j", (args, selector, dryRun) => {
    expect(parseContentPurgeArguments(args)).toEqual({ selector, dryRun });
  });

  it.each<[readonly string[]]>([
    [[]],
    [["--organization"]],
    [["--organization", "org-1"]],
    [["--dry-run"]],
    [["--confirm"]],
    [["--organization", "org-1", "--user", "user-1", "--dry-run"]],
    [["--session", "s", "--session", "s2", "--confirm"]],
    [["--session", "s", "--dry-run", "--confirm"]],
    [["--session", "s", "--dry-run", "--dry-run"]],
    [["--session", "s", "--confirm", "--confirm"]],
    [["--organization", "", "--dry-run"]],
    [["--organization", " ", "--dry-run"]],
    [["--organization", " org", "--dry-run"]],
    [["--organization", "org ", "--dry-run"]],
    [["--organization", "x".repeat(201), "--dry-run"]],
    [["--user", "--dry-run", "--confirm"]],
    [["--unknown", "x", "--session", "s", "--confirm"]],
    [["positional", "--session", "s", "--confirm"]],
    [["--session", "-x", "--confirm"]],
  ])("rejects %j", (args) => {
    expect(() => parseContentPurgeArguments(args)).toThrow();
  });
});

describe("runContentPurgeCommand", () => {
  it("never calls a destructive batch without --confirm", async () => {
    const f = setup();
    await expect(f.run(["--session", "session-1"])).rejects.toThrow();
    expect(f.purge.batch).not.toHaveBeenCalled();
    await expect(f.run(["--session", "session-1", "--dry-run", "--confirm"])).rejects.toThrow();
    expect(f.purge.batch).not.toHaveBeenCalled();
  });

  it("cursors through bounded dry-run batches and reports count-only totals", async () => {
    const f = setup();
    const mocked = vi
      .fn<ContentPurger["batch"]>()
      .mockResolvedValueOnce(result(3, 0, "session-3"))
      .mockResolvedValueOnce(result(2, 1, "session-5", 1))
      .mockResolvedValueOnce(result(0, 0, null));
    f.purge.batch = mocked;
    await expect(f.run(["--organization", "org-1", "--dry-run"])).resolves.toBe(1);
    expect(
      mocked.mock.calls.map(([input]) => [
        input.organizationId,
        input.after ?? null,
        input.limit,
        input.dryRun,
        input.cutoff ?? null,
        input.waitForLocks ?? false,
      ]),
    ).toEqual([
      ["org-1", null, 500, true, null, true],
      ["org-1", "session-3", 500, true, null, true],
      ["org-1", "session-5", 500, true, null, true],
    ]);
    expect(f.lines).toHaveLength(1);
    const summary = JSON.parse(f.lines[0]!) as {
      dryRun: boolean;
      scanned: number;
      blocked: number;
      counts: Record<string, number>;
    };
    expect(summary).toEqual({
      dryRun: true,
      scanned: 5,
      blocked: 1,
      counts: { ...empty(), sessions: 4 },
    });
    expect(f.lines[0]).not.toMatch(/org-1|session-/u);
  });

  it("returns zero when a confirmed purge completes without blocked work", async () => {
    const f = setup();
    const mocked = vi
      .fn<ContentPurger["batch"]>()
      .mockResolvedValueOnce(result(2, 0, "session-2"))
      .mockResolvedValueOnce(result(0, 0, null));
    f.purge.batch = mocked;
    await expect(f.run(["--user", "user-1", "--confirm"])).resolves.toBe(0);
    expect(
      mocked.mock.calls.map(([input]) => [input.principalId, input.after ?? null, input.dryRun]),
    ).toEqual([
      ["user-1", null, false],
      ["user-1", "session-2", false],
    ]);
    const summary = JSON.parse(f.lines[0]!) as {
      dryRun: boolean;
      scanned: number;
      blocked: number;
      counts: Record<string, number>;
    };
    expect(summary.dryRun).toBe(false);
    expect(summary.blocked).toBe(0);
  });

  it("reports a nonzero incomplete result when batches are blocked", async () => {
    const f = setup();
    f.purge.batch = vi
      .fn<ContentPurger["batch"]>()
      .mockResolvedValueOnce(result(1, 1, "session-1", 0))
      .mockResolvedValueOnce(result(0, 0, null));
    await expect(f.run(["--session", "session-1", "--confirm"])).resolves.toBe(1);
  });

  it("propagates a hard batch failure without printing a summary", async () => {
    const f = setup();
    const failure = new Error("connection lost");
    f.purge.batch = vi.fn<ContentPurger["batch"]>().mockRejectedValue(failure);
    await expect(f.run(["--session", "session-1", "--confirm"])).rejects.toBe(failure);
    expect(f.lines).toEqual([]);
  });
});
