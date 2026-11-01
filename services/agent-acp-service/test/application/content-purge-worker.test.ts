import { describe, expect, it, vi } from "vitest";
import { ContentPurgeWorker } from "../../src/application/content-purge-worker.js";
import type {
  ContentPurger,
  ContentPurgeBatch,
  ContentPurgeRequest,
} from "../../src/domain/content-retention.js";

const counts = (): ContentPurgeBatch["counts"] => ({
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
const batch = (scanned: number, nextCursor: string | null): ContentPurgeBatch => ({
  scanned,
  blocked: 0,
  counts: { ...counts(), sessions: scanned },
  nextCursor,
});
const setup = (
  retention = {
    deletedSessionRetentionMs: 1_000,
    purgeBatch: 5,
    purgeIntervalMs: 60_000,
  },
) => {
  const purge: ContentPurger = { batch: vi.fn<ContentPurger["batch"]>() };
  const report = vi.fn();
  return {
    purge,
    report,
    worker: new ContentPurgeWorker({ purge, retention, report }),
  };
};

describe("content purge worker", () => {
  it("does no work when retention is disabled", async () => {
    const f = setup({
      deletedSessionRetentionMs: 0,
      purgeBatch: 5,
      purgeIntervalMs: 1,
    });
    await f.worker.run(new AbortController().signal);
    expect(f.purge.batch).not.toHaveBeenCalled();
  });

  it("scans bounded batches in cursor order then waits between passes", async () => {
    const cutoff = Date.now();
    const f = setup();
    const worker = new ContentPurgeWorker({
      purge: f.purge,
      retention: {
        deletedSessionRetentionMs: 1_000,
        purgeBatch: 5,
        purgeIntervalMs: 60_000,
      },
      report: f.report,
      now: () => new Date(cutoff),
    });
    f.purge.batch = vi
      .fn<ContentPurger["batch"]>()
      .mockResolvedValueOnce(batch(2, "session-2"))
      .mockResolvedValueOnce(batch(1, "session-3"))
      .mockResolvedValue(batch(0, null));
    const controller = new AbortController();
    const running = worker.run(controller.signal);
    const mocked = f.purge.batch as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(f.purge.batch).toHaveBeenCalledTimes(3));
    controller.abort();
    await running;
    const calls = (mocked.mock.calls as [ContentPurgeRequest][]).map(([input]) => ({
      after: input.after ?? null,
      limit: input.limit,
      dryRun: input.dryRun,
      cutoff: input.cutoff?.getTime(),
    }));
    expect(calls).toEqual([
      { after: null, limit: 5, dryRun: false, cutoff: cutoff - 1_000 },
      { after: "session-2", limit: 5, dryRun: false, cutoff: cutoff - 1_000 },
      { after: "session-3", limit: 5, dryRun: false, cutoff: cutoff - 1_000 },
    ]);
    expect(f.report).not.toHaveBeenCalled();
  });

  it("reports each blocked batch once while the cursor still advances", async () => {
    const f = setup({
      deletedSessionRetentionMs: 1_000,
      purgeBatch: 5,
      purgeIntervalMs: 60_000,
    });
    const blockedFirst: ContentPurgeBatch = {
      scanned: 1,
      blocked: 1,
      counts: { ...counts() },
      nextCursor: "blocked-1",
    };
    f.purge.batch = vi
      .fn<ContentPurger["batch"]>()
      .mockResolvedValueOnce(blockedFirst)
      .mockResolvedValueOnce(batch(1, "session-2"))
      .mockResolvedValue(batch(0, null));
    const controller = new AbortController();
    const running = f.worker.run(controller.signal);
    await vi.waitFor(() => expect(f.purge.batch).toHaveBeenCalledTimes(3));
    controller.abort();
    await running;
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.report).toHaveBeenCalledWith(1);
  });

  it("never overlaps batches and joins the in-flight batch on abort", async () => {
    const f = setup();
    const gates = [
      Promise.withResolvers<ContentPurgeBatch>(),
      Promise.withResolvers<ContentPurgeBatch>(),
    ];
    f.purge.batch = vi
      .fn<ContentPurger["batch"]>()
      .mockImplementationOnce(() => gates[0]!.promise)
      .mockImplementationOnce(() => gates[1]!.promise)
      .mockResolvedValue(batch(0, null));
    const controller = new AbortController();
    const running = f.worker.run(controller.signal);
    await vi.waitFor(() => expect(f.purge.batch).toHaveBeenCalledTimes(1));
    gates[0]!.resolve(batch(1, "session-1"));
    await vi.waitFor(() => expect(f.purge.batch).toHaveBeenCalledTimes(2));
    controller.abort();
    gates[1]!.resolve(batch(0, null));
    await running;
    expect(f.purge.batch).toHaveBeenCalledTimes(2);
  });

  it("leaves no timer behind when aborted while waiting between passes", async () => {
    const f = setup();
    f.purge.batch = vi.fn<ContentPurger["batch"]>().mockResolvedValue(batch(0, null));
    const controller = new AbortController();
    const running = f.worker.run(controller.signal);
    await vi.waitFor(() => expect(f.purge.batch).toHaveBeenCalledTimes(1));
    controller.abort();
    await running;
    expect(f.purge.batch).toHaveBeenCalledTimes(1);
  });

  it("propagates batch failures instead of retrying inside the pass", async () => {
    const f = setup({ deletedSessionRetentionMs: 1, purgeBatch: 5, purgeIntervalMs: 1 });
    const failure = new Error("batch failed");
    f.purge.batch = vi.fn<ContentPurger["batch"]>().mockRejectedValue(failure);
    await expect(f.worker.run(new AbortController().signal)).rejects.toBe(failure);
  });
});
