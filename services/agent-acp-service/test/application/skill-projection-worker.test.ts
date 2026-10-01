import { expect, it, vi } from "vitest";
import { SkillProjectionWorker } from "../../src/application/skill-projection-worker.js";
import { DomainError } from "../../src/domain/errors.js";

const projection = {
  organization_id: `org_${"a".repeat(32)}`,
  agent_id: `agent_${"b".repeat(32)}`,
  owner_id: `user_${"c".repeat(32)}`,
  name: "inspect-first",
  description: "Inspect first.",
  sequence: 1,
  content_digest: `sha256:${"d".repeat(64)}`,
  active: true,
};

it("retries durable metadata after transport failure without model replay", async () => {
  const pending = vi.fn(() => Promise.resolve([projection]));
  const complete = vi.fn(() => Promise.resolve());
  const remove = vi.fn(() => Promise.resolve());
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ outcome: "replayed", sequence: 1 });
  const worker = new SkillProjectionWorker({
    repository: { pending, complete, remove },
    client: { send },
    directory: { inspect: () => ({ agent: {} }) },
    report: vi.fn(),
  });
  await worker.tick(new AbortController().signal);
  expect(complete).toHaveBeenLastCalledWith(projection, false);
  await worker.tick(new AbortController().signal);
  expect(complete).toHaveBeenLastCalledWith(projection, true);
  expect(send.mock.calls[0]?.[0]).toEqual(projection);
  expect(remove).not.toHaveBeenCalled();
});

it("propagates current access revocation as a higher-sequence tombstone and defers uninitialized configurations", async () => {
  const pending = vi.fn(() => Promise.resolve([projection]));
  const complete = vi.fn(() => Promise.resolve());
  const remove = vi.fn(() => Promise.resolve());
  const send = vi.fn();
  const inspect = vi.fn(() => {
    throw new DomainError("access_denied", "revoked");
  });
  const worker = new SkillProjectionWorker({
    repository: { pending, complete, remove },
    client: { send },
    directory: { inspect },
    report: vi.fn(),
  });
  await worker.tick(new AbortController().signal);
  expect(remove).toHaveBeenCalledWith(projection);
  expect(send).not.toHaveBeenCalled();
  inspect.mockImplementation(() => {
    throw new DomainError("configuration_not_ready", "wait");
  });
  remove.mockClear();
  await worker.tick(new AbortController().signal);
  expect(remove).not.toHaveBeenCalled();
  expect(complete).toHaveBeenLastCalledWith(projection, false);
  pending.mockResolvedValue([{ ...projection, active: false }]);
  send.mockResolvedValue({ outcome: "applied", sequence: 2 });
  await worker.tick(new AbortController().signal);
  expect(send).toHaveBeenCalledWith({ ...projection, active: false }, expect.any(AbortSignal));
});
