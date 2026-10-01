import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LearningNotices } from "./LearningNotices";

afterEach(cleanup);

test("learning deferral is read only when results open and never creates a toast", async () => {
  const read = vi.fn(async () => ({ agentId: "agent-1", blocked: { reason: "writer_present" as const } }));
  render(<LearningNotices agentId="agent-1" ready notices={[]} loadStatus={read} />);
  expect(read).not.toHaveBeenCalled();
  expect(screen.queryByText(/waiting for background writes/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Skill learning results/i }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  await screen.findByText(/You can keep chatting/i);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Skill learning results/i }));
  expect(screen.queryByText(/waiting for background writes/i)).toBeNull();
});

test.each(["close", "switch"])("%s cancels an in-flight diagnostic read", async (action) => {
  let signal: AbortSignal | undefined;
  const pending = Promise.withResolvers<{ agentId: string; blocked: null }>();
  const read = vi.fn((input: AbortSignal) => { signal = input; return pending.promise; });
  const view = render(<LearningNotices agentId="agent-1" ready notices={[]} loadStatus={read} />);
  fireEvent.click(screen.getByRole("button", { name: /Skill learning results/i }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  if (action === "switch")
    view.rerender(<LearningNotices agentId="agent-2" ready notices={[]} loadStatus={read} />);
  else fireEvent.click(screen.getByRole("button", { name: /Skill learning results/i }));
  expect(signal?.aborted).toBe(true);
  pending.resolve({ agentId: "agent-1", blocked: null });
  await Promise.resolve();
  expect(read).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region", { name: "Skill learning history" })).toBeNull();
});

test("failed diagnostics remain unavailable inside the panel and never report learning success", async () => {
  const read = vi.fn(async () => { throw new Error("unavailable"); });
  render(<LearningNotices agentId="agent-1" ready notices={[]} loadStatus={read} />);
  fireEvent.click(screen.getByRole("button", { name: /Skill learning results/i }));
  await screen.findByText("Learning status is unavailable.");
  expect(screen.queryByRole("status")).toBeNull();
  expect(read).toHaveBeenCalledOnce();
});

test("learning history links to its source conversation using the existing route", () => {
  const select = vi.fn();
  render(<LearningNotices agentId="agent-1" ready notices={[{
    ...earlier, sourceSessionId: "session-1", sourceRunId: "run-1",
  }]} onSelectSource={select} />);
  fireEvent.click(screen.getByRole("button", { name: /Skill learning results/i }));
  const link = screen.getByRole("link", { name: "View source conversation" });
  expect(link.getAttribute("href")).toBe("/workspace/agent-1/sessions/session-1");
  fireEvent.click(link);
  expect(select).toHaveBeenCalledWith("session-1");
});

const earlier = {
  changeId: "change-1",
  sequence: "1",
  agentId: "agent-1",
  kind: "skill_created" as const,
  occurredAt: "2026-09-29T00:00:00Z",
  skillName: "release-workflow",
  changeSummary: "Learned the release workflow",
};
const later = {
  changeId: "change-2",
  sequence: "2",
  agentId: "agent-1",
  kind: "skill_updated" as const,
  occurredAt: "2026-09-29T00:01:00Z",
  skillName: "release-workflow",
  changeSummary: "Improved the release workflow",
};
const latest = {
  changeId: "change-3",
  sequence: "3",
  agentId: "agent-1",
  kind: "skill_updated" as const,
  occurredAt: "2026-09-29T00:02:00Z",
  skillName: "release-workflow",
  changeSummary: "Refined the release workflow",
};

test("restored learning history stays available without producing a fresh alert", () => {
  render(<LearningNotices agentId="agent-1" ready notices={[earlier]} />);
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Skill learning results/i }),
  );
  expect(screen.getByText("Learned the release workflow")).toBeTruthy();
  expect(screen.queryByText(/Undo/i)).toBeNull();
});

test("a new applied learning result is announced once and Agent switching resets the baseline", () => {
  const view = render(
    <LearningNotices agentId="agent-1" ready notices={[earlier]} />,
  );
  view.rerender(
    <LearningNotices agentId="agent-1" ready notices={[earlier, later]} />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Improved the release workflow",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss learning result" }),
  );
  view.rerender(
    <LearningNotices agentId="agent-1" ready notices={[earlier, later]} />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<LearningNotices agentId="agent-2" ready notices={[later]} />);
  expect(screen.queryByRole("status")).toBeNull();
});

test("an older notice arriving late joins history without replacing the fresh result", () => {
  const view = render(
    <LearningNotices agentId="agent-1" ready notices={[later]} />,
  );
  view.rerender(
    <LearningNotices agentId="agent-1" ready notices={[earlier, later]} />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Skill learning results/i }),
  );
  expect(screen.getByText("Learned the release workflow")).toBeTruthy();
  view.rerender(
    <LearningNotices
      agentId="agent-1"
      ready
      notices={[latest, earlier, later]}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Refined the release workflow",
  );
});
