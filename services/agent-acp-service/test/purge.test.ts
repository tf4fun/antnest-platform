import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  isContentPurgeEntrypoint,
  runOfflineContentPurge,
  type ContentPurgeLock,
} from "../src/purge.js";

type Call = { text: string; values: readonly unknown[] };

function fixture(onQuery?: (call: Call) => void) {
  const calls: string[] = [];
  let selects = 0;
  const client = {
    query: vi.fn((text: string, values: readonly unknown[] = []) => {
      calls.push(text);
      onQuery?.({ text, values });
      if (text.includes("AS blocked")) return Promise.resolve({ rows: [{ blocked: false }] });
      if (text.includes("AS sessions"))
        return Promise.resolve({
          rows: [
            {
              sessions: "0",
              runs: "0",
              messages: "0",
              toolAttempts: "0",
              learningTasks: "0",
              evidenceItems: "0",
              evidenceSnapshots: "0",
              candidates: "0",
              publishedCandidates: "0",
              learningChanges: "0",
            },
          ],
        });
      if (text.includes("FROM acp_sessions")) {
        selects += 1;
        return Promise.resolve({
          rows: selects === 1 ? [{ id: "s-1", organization_id: "org-1", agent_id: "agent-1" }] : [],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(() => undefined),
    on: vi.fn(() => undefined),
    removeListener: vi.fn(() => undefined),
  } as unknown as PoolClient;
  const end = vi.fn(() => Promise.resolve(undefined));
  const connect = vi.fn(() => Promise.resolve(client));
  const pool = { connect, end } as unknown as Pool;
  return { calls, client, pool, end };
}

function lock(overrides: Partial<ContentPurgeLock> = {}) {
  return {
    release: vi.fn(() => Promise.resolve()),
    waitForLoss: () => new Promise<Error>(() => undefined),
    ...overrides,
  } satisfies ContentPurgeLock;
}

const args = ["--session", "s-1", "--dry-run"];
const input = (
  pool: Pool,
  ownership: AbortController,
  acquireLock: () => Promise<ContentPurgeLock>,
) => ({
  args,
  batchLimit: 500,
  out: vi.fn(),
  pool,
  ownership,
  acquireLock,
});

describe("isContentPurgeEntrypoint", () => {
  it("matches the module path including encoded space or non-ASCII paths", () => {
    expect(
      isContentPurgeEntrypoint("/tmp/my purge/dist/purge.js", "/tmp/my purge/dist/purge.js"),
    ).toBe(true);
    expect(isContentPurgeEntrypoint("/tmp/ dir/purge.js", "/tmp/ dir/purge.js")).toBe(true);
    expect(isContentPurgeEntrypoint("/tmp/purge.js", "/tmp/other.js")).toBe(false);
    expect(isContentPurgeEntrypoint("/tmp/purge.js", undefined)).toBe(false);
  });
});

describe("offline content purge entrypoint", () => {
  it("rejects invalid arguments without acquiring the lock, still closing the pool", async () => {
    const f = fixture();
    const ownership = new AbortController();
    const acquireLock = vi.fn(() => Promise.resolve(lock()));
    await expect(
      runOfflineContentPurge({
        args: ["--session", "s-1"],
        batchLimit: 500,
        out: vi.fn(),
        pool: f.pool,
        ownership,
        acquireLock,
      }),
    ).rejects.toThrow();
    expect(acquireLock).not.toHaveBeenCalled();
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it("closes the pool even when lock release fails", async () => {
    const f = fixture();
    const ownership = new AbortController();
    const failure = new Error("release failed");
    const released = vi.fn(() => Promise.reject(failure));
    const acquired = lock({ release: released });
    await expect(
      runOfflineContentPurge(input(f.pool, ownership, () => Promise.resolve(acquired))),
    ).rejects.toBe(failure);
    expect(released).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it("rolls back the batch when the ownership signal aborts mid-flight", async () => {
    const ownership = new AbortController();
    const f = fixture(() => {
      if (!ownership.signal.aborted) ownership.abort(new Error("stop"));
    });
    const released = vi.fn(() => Promise.resolve());
    const acquired = lock({ release: released });
    await expect(
      runOfflineContentPurge(input(f.pool, ownership, () => Promise.resolve(acquired))),
    ).rejects.toThrow();
    expect(f.calls).toContain("ROLLBACK");
    expect(f.calls).not.toContain("COMMIT");
    expect(released).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it("rejects and cleans up when the exclusive lock is lost", async () => {
    const f = fixture();
    const ownership = new AbortController();
    const loss = Promise.withResolvers<Error>();
    const released = vi.fn(() => Promise.resolve());
    const acquired = lock({ waitForLoss: () => loss.promise, release: released });
    loss.resolve(new Error("lock lost"));
    await expect(
      runOfflineContentPurge(input(f.pool, ownership, () => Promise.resolve(acquired))),
    ).rejects.toThrow();
    expect(released).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
  });
});
