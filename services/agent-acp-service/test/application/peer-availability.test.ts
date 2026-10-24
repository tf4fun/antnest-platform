import { describe, expect, it, vi } from "vitest";
import { PeerAvailability } from "../../src/application/peer-availability.js";

const registration = (member: string, digit: string) => ({
  registration_id: `${digit.repeat(8)}-1111-4111-8111-111111111111`,
  member_id: member,
  incarnation_id: `${digit.repeat(8)}-2222-4222-8222-222222222222`,
});
const local = registration("acp-b", "2");
const dead = registration("acp-a", "1");
const old = registration("acp-a", "3");
const digest = "a".repeat(64);
const historyId = "44444444-4444-4444-8444-444444444444";
const stopped = (original: typeof local) => ({
  ...original,
  state: "stopped" as const,
  stop_receipt: {
    receipt_id: "55555555-5555-4555-8555-555555555555",
    reason: "container_stopped" as const,
    observed_at: "2026-10-24T00:00:00.000Z",
  },
});

function setup() {
  const events: string[] = [];
  let revision = "2";
  const rows = [dead, local];
  const originals = new Map([
    ["acp-a", [dead, old]],
    ["acp-b", [local]],
  ]);
  const capture = vi.fn(() => {
    events.push("capture");
    return Promise.resolve({
      membershipSha256: digest,
      revision,
      registrations: structuredClone(rows),
    });
  });
  const assert = vi.fn((expected: { revision: string }) => {
    events.push("assert");
    if (expected.revision !== revision) return Promise.reject(new Error("participation changed"));
    return Promise.resolve();
  });
  const history = vi.fn((input: { member_id: string; cursor: unknown }) => {
    events.push(`history:${input.member_id}`);
    const entries = originals.get(input.member_id)!;
    return Promise.resolve({
      member_id: input.member_id,
      history_id: historyId,
      snapshot_revision: String(entries.length),
      after_sequence: "0",
      items: entries.map((value, i) => ({ sequence: String(i + 1), registration: value })),
      next_cursor: null,
    });
  });
  const inspect = vi.fn((original: typeof local): Promise<unknown> => {
    events.push(`inspect:${original.registration_id}`);
    return Promise.resolve(
      original.member_id === local.member_id
        ? { ...original, state: "running" as const, observed_at: "2026-10-24T00:00:01.000Z" }
        : stopped(original),
    );
  });
  const availability = new PeerAvailability({
    registration: local,
    membershipSha256: digest,
    members: ["acp-a", "acp-b"],
    ledger: { capture, assert },
    registry: { history, inspect },
  });
  return {
    availability,
    capture,
    assert,
    history,
    inspect,
    events,
    rows,
    originals,
    join: () => {
      revision = "3";
    },
    refresh: () => availability.refresh(new AbortController().signal, Date.now() + 5000),
  };
}

describe("complete-history participation before survivor takeover", () => {
  it("captures participation before discovery and covers a stopped incarnation without any Run", async () => {
    const f = setup();
    const view = await f.refresh();
    expect(f.events[0]).toBe("capture");
    expect(f.events.at(-1)).toBe("assert");
    expect(f.inspect.mock.calls.map(([r]) => r.registration_id).sort()).toEqual(
      [dead, old, local].map((r) => r.registration_id).sort(),
    );
    expect(view.guard).toEqual({ membershipSha256: digest, revision: "2" });
    expect(view.members.map((m) => [m.memberId, m.state])).toEqual([
      ["acp-a", "stopped"],
      ["acp-b", "running"],
    ]);
    expect(view.live).toEqual([local]);
    expect(view.members[0]).not.toHaveProperty("revocation", "joined");
    expect(f.availability.current()).toBe(view);
  });

  it("does not publish an availability capture if a registration joins during history discovery", async () => {
    const f = setup();
    const original = f.history.getMockImplementation()!;
    f.history.mockImplementation(async (input) => {
      const page = await original(input);
      f.join();
      return page;
    });
    await expect(f.refresh()).rejects.toThrow();
    expect(() => f.availability.current()).toThrow();
    expect(f.assert).toHaveBeenCalledOnce();
  });

  it("captures the original ledger version before any adapter can mutate its returned object", async () => {
    const f = setup();
    const returned = { membershipSha256: digest, revision: "2", registrations: [dead, local] };
    f.capture.mockResolvedValue(returned);
    const original = f.history.getMockImplementation()!;
    f.history.mockImplementation(async (input) => {
      f.join();
      returned.revision = "3";
      return original(input);
    });
    await expect(f.refresh()).rejects.toThrow();
    expect(() => f.availability.current()).toThrow();
  });

  it.each(["running", "unknown"] as const)(
    "rejects a hidden old incarnation that remains %s",
    async (state) => {
      const f = setup();
      const original = f.inspect.getMockImplementation()!;
      f.inspect.mockImplementation(async (r) =>
        r.registration_id === old.registration_id
          ? state === "running"
            ? { ...r, state, observed_at: "2026-10-24T00:00:01.000Z" }
            : { registration_id: r.registration_id, state, reason: "platform_unavailable" }
          : original(r),
      );
      await expect(f.refresh()).rejects.toThrow();
      expect(f.assert).not.toHaveBeenCalled();
    },
  );

  it("rejects a history that omits an admitted participant even if every returned process is stopped", async () => {
    const f = setup();
    f.originals.set("acp-a", [old]);
    await expect(f.refresh()).rejects.toThrow();
    expect(f.assert).not.toHaveBeenCalled();
  });

  it("rejects an unregistered running process and two running processes for the same member", async () => {
    const f = setup();
    f.originals.set("acp-b", [local, registration("acp-b", "6")]);
    await expect(f.refresh()).rejects.toThrow();
    expect(f.assert).not.toHaveBeenCalled();
  });

  it("keeps never-participated catalog members explicit instead of manufacturing a stop receipt", async () => {
    const f = setup();
    f.rows.splice(0, 1);
    f.originals.set("acp-a", []);
    const view = await f.refresh();
    expect(view.members[0]).toMatchObject({ memberId: "acp-a", state: "unregistered" });
    expect(view.members[0]).not.toHaveProperty("inspection");
    expect(view.members).toHaveLength(2);
  });

  it("joins every original history call on cancellation and retains the last verified capture", async () => {
    const f = setup();
    const previous = await f.refresh();
    const held = Promise.withResolvers<Awaited<ReturnType<typeof f.history>>>();
    const entered = Promise.withResolvers<void>();
    f.history.mockImplementationOnce(async () => {
      entered.resolve();
      return held.promise;
    });
    const abort = new AbortController();
    let completed = false;
    const original = f.availability.refresh(abort.signal, Date.now() + 5000).finally(() => {
      completed = true;
    });
    const result = expect(original).rejects.toThrow();
    await entered.promise;
    abort.abort(new Error("cancelled"));
    await Promise.resolve();
    expect(completed).toBe(false);
    held.reject(new Error("late original failure"));
    await result;
    expect(f.availability.current()).toBe(previous);
  });

  it("reuses the newer published object when overlapping refresh captures are identical", async () => {
    const f = setup();
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalAssert = f.assert.getMockImplementation()!;
    f.assert.mockImplementationOnce(async (expected) => {
      await originalAssert(expected);
      entered.resolve();
      await held.promise;
    });
    const first = f.refresh();
    const firstJoined = first.catch(() => undefined);
    let second: ReturnType<typeof f.refresh> | undefined;
    try {
      await entered.promise;
      second = f.refresh();
      const published = await second;
      expect(f.availability.current()).toBe(published);
      expect(f.assert).toHaveBeenCalledTimes(2);
      held.resolve();
      await expect(first).resolves.toBe(published);
      expect(f.availability.current()).toBe(published);
      expect(f.capture).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve();
      await Promise.allSettled([firstJoined, ...(second === undefined ? [] : [second])]);
    }
  });

  it("rejects an older overlapping refresh when a newer participation revision is published", async () => {
    const f = setup();
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalAssert = f.assert.getMockImplementation()!;
    f.assert.mockImplementationOnce(async (expected) => {
      await originalAssert(expected);
      entered.resolve();
      await held.promise;
    });
    const first = f.refresh();
    const firstJoined = first.catch(() => undefined);
    let second: ReturnType<typeof f.refresh> | undefined;
    try {
      await entered.promise;
      f.join();
      second = f.refresh();
      const published = await second;
      expect(published.guard.revision).toBe("3");
      expect(published.live).toEqual([local]);
      expect(f.assert.mock.calls.map(([guard]) => guard.revision)).toEqual(["2", "3"]);
      held.resolve();
      await expect(first).rejects.toMatchObject({ code: "configuration_unavailable" });
      expect(f.availability.current()).toBe(published);
    } finally {
      held.resolve();
      await Promise.allSettled([firstJoined, ...(second === undefined ? [] : [second])]);
    }
  });

  it("does not revive a running peer from an older overlapping refresh after a same-H stop proof", async () => {
    const f = setup();
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalAssert = f.assert.getMockImplementation()!;
    const originalInspect = f.inspect.getMockImplementation()!;
    let peerStopped = false;
    let observedRunningPeer = false;
    f.inspect.mockImplementation((original) => {
      if (original.registration_id === dead.registration_id && !peerStopped) {
        observedRunningPeer = true;
        return Promise.resolve({
          ...original,
          state: "running" as const,
          observed_at: "2026-10-24T00:00:01.000Z",
        });
      }
      return originalInspect(original);
    });
    f.assert.mockImplementationOnce(async (expected) => {
      await originalAssert(expected);
      entered.resolve();
      await held.promise;
    });
    const first = f.refresh();
    const firstJoined = first.catch(() => undefined);
    let second: ReturnType<typeof f.refresh> | undefined;
    try {
      await entered.promise;
      expect(observedRunningPeer).toBe(true);
      peerStopped = true;
      second = f.refresh();
      const published = await second;
      expect(published.guard.revision).toBe("2");
      expect(published.live).toEqual([local]);
      expect(published.members[0]).toMatchObject({
        memberId: dead.member_id,
        state: "stopped",
        stopped: [stopped(dead), stopped(old)],
      });
      held.resolve();
      await expect(first).rejects.toMatchObject({ code: "configuration_unavailable" });
      expect(f.availability.current()).toBe(published);
      expect(f.availability.current().live).toEqual([local]);
    } finally {
      held.resolve();
      await Promise.allSettled([firstJoined, ...(second === undefined ? [] : [second])]);
    }
  });

  it.each(["ledger", "abort", "deadline"] as const)(
    "keeps the original %s check for an otherwise identical overlapping refresh",
    async (mode) => {
      const f = setup();
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const originalAssert = f.assert.getMockImplementation()!;
      const ledgerError = new Error("original participation assertion failed");
      const abortError = new Error("original refresh cancelled");
      const abort = new AbortController();
      const startedAt = Date.now();
      const deadline = startedAt + 5000;
      const clock =
        mode === "deadline" ? vi.spyOn(Date, "now").mockReturnValue(startedAt) : undefined;
      f.assert.mockImplementationOnce(async (expected) => {
        entered.resolve();
        await held.promise;
        if (mode === "ledger") throw ledgerError;
        await originalAssert(expected);
      });
      let completed = false;
      const first = f.availability.refresh(abort.signal, deadline).finally(() => {
        completed = true;
      });
      const firstJoined = first.catch(() => undefined);
      let second: ReturnType<typeof f.refresh> | undefined;
      try {
        await entered.promise;
        second = f.refresh();
        const published = await second;
        expect(published.guard.revision).toBe("2");
        expect(f.assert).toHaveBeenCalledTimes(2);
        if (mode === "abort") abort.abort(abortError);
        if (mode === "deadline") clock!.mockReturnValue(deadline);
        await Promise.resolve();
        expect(completed).toBe(false);
        held.resolve();
        if (mode === "ledger") await expect(first).rejects.toBe(ledgerError);
        else if (mode === "abort") await expect(first).rejects.toBe(abortError);
        else await expect(first).rejects.toMatchObject({ code: "configuration_unavailable" });
        expect(f.availability.current()).toBe(published);
      } finally {
        held.resolve();
        await Promise.allSettled([firstJoined, ...(second === undefined ? [] : [second])]);
        clock?.mockRestore();
      }
    },
  );
});
