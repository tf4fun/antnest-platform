import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, APIError } from "../lib/api";
import { SkillSources } from "./skill-sources";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ref = { kind: "agent" as const, agent_id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "code-review", sequence: 2 };
const digest = `sha256:${"b".repeat(64)}`;
const source = { skill_ref: ref, name: ref.name, description: "Review code changes", content_digest: digest };
const preview = { skill_ref: ref, content_digest: digest, skill_md: "---\nname: code-review\ndescription: Review code changes\n---\n<script>bad()</script>\n", files: [{ path: "SKILL.md", size: 92, executable: false }, { path: "scripts/check.sh", size: 10, executable: true }] };
const formal = { skill_id: "skill_cccccccccccccccccccccccccccccccc", name: ref.name, current_version: 3, description: "Review code", artifact_digest: digest, content_digest: digest, artifact_size: 100, unpacked_size: 200, package_rules_version: 1 };

async function choose(onPublished = vi.fn(), overrides: Record<string, unknown> = {}) {
  vi.spyOn(api, "searchSkillSources").mockResolvedValue({ items: [source] });
  vi.spyOn(api, "previewSkillSource").mockResolvedValue(preview);
  render(<SkillSources targets={[formal]} hasMoreTargets={false} moreTargetsPending={false} onMoreTargets={vi.fn()} onRefreshTargets={vi.fn()} onPublished={onPublished} {...overrides} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Agent Skills" }), { target: { value: "review" } });
  fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review and promote code-review" }));
  await screen.findByText("<script>bad()</script>", { exact: false });
  return screen.getByRole("dialog", { name: "Promote code-review" });
}

it("requires an explicit source search and preview before publication and renders source text as data", async () => {
  const published = vi.spyOn(api, "promoteSkillSource").mockResolvedValue({ ...formal, version: 1 });
  const onPublished = vi.fn();
  const dialog = await choose(onPublished);
  expect(api.previewSkillSource).toHaveBeenCalledWith({ skill_ref: ref, expected_digest: digest }, expect.any(AbortSignal));
  expect(published).not.toHaveBeenCalled();
  expect(dialog.querySelector("script")).toBeNull();
  expect(within(dialog).getByText(ref.agent_id)).toBeTruthy();
  expect(within(dialog).getByText("scripts/check.sh")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Promote Skill" }));
  await waitFor(() => expect(published).toHaveBeenCalledExactlyOnceWith({ skill_ref: ref, expected_digest: digest }));
  await waitFor(() => expect(onPublished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 1 })));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("binds append to the explicitly selected same-name formal head", async () => {
  const published = vi.spyOn(api, "promoteSkillSource").mockResolvedValue({ ...formal, version: 4 });
  const dialog = await choose();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Publication target" }), { target: { value: formal.skill_id } });
  expect(within(dialog).getByText(/Expected current version: 3/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Promote Skill" }));
  await waitFor(() => expect(published).toHaveBeenCalledExactlyOnceWith({ skill_ref: ref, expected_digest: digest, skill_id: formal.skill_id, expected_version: 3 }));
});

it("keeps the reviewed selection after uncertain failure and blocks double submission", async () => {
  let finish!: (value: typeof formal & { version: number }) => void;
  const published = vi.spyOn(api, "promoteSkillSource")
    .mockRejectedValueOnce(new APIError(503, "source_unavailable", "Try again"))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const dialog = await choose();
  fireEvent.click(within(dialog).getByRole("button", { name: "Promote Skill" }));
  await screen.findByText("Try again");
  fireEvent.click(within(dialog).getByRole("button", { name: "Promote Skill" }));
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Promoting…" }).disabled).toBe(true);
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
  expect(published).toHaveBeenCalledTimes(2);
  expect(published.mock.calls[0]).toEqual(published.mock.calls[1]);
  finish({ ...formal, version: 1 });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it.each(["content_changed", "revision_conflict", "name_conflict"])("requires explicit review after %s without replacing a confirmed selection", async (code) => {
  const published = vi.spyOn(api, "promoteSkillSource").mockRejectedValue(new APIError(409, code, "Selection changed"));
  const dialog = await choose();
  fireEvent.click(within(dialog).getByRole("button", { name: "Promote Skill" }));
  await screen.findByText("Selection changed");
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Promote Skill" }).disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Search again" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(api.searchSkillSources).toHaveBeenCalledTimes(2));
  expect(published).toHaveBeenCalledOnce();
});

it("does not publish or install if the selected source cannot be previewed", async () => {
  vi.spyOn(api, "searchSkillSources").mockResolvedValue({ items: [source] });
  vi.spyOn(api, "previewSkillSource").mockRejectedValue(new APIError(404, "not_found", "Source no longer available"));
  const published = vi.spyOn(api, "promoteSkillSource");
  render(<SkillSources targets={[]} hasMoreTargets={false} moreTargetsPending={false} onMoreTargets={vi.fn()} onRefreshTargets={vi.fn()} onPublished={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Agent Skills" }), { target: { value: "review" } });
  fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review and promote code-review" }));
  await screen.findByText("Source no longer available");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Promote Skill" }).disabled).toBe(true);
  expect(published).not.toHaveBeenCalled();
});

it("allows bounded target pagination without choosing a target or changing source identity", async () => {
  const more = vi.fn();
  const dialog = await choose(vi.fn(), { targets: [], hasMoreTargets: true, onMoreTargets: more });
  fireEvent.click(within(dialog).getByRole("button", { name: "Load more published Skills" }));
  expect(more).toHaveBeenCalledOnce();
  expect(within(dialog).getByRole<HTMLSelectElement>("combobox", { name: "Publication target" }).value).toBe("new");
});

it("never retries a confirmed promotion when refreshing inventory fails", async () => {
  const published = vi.spyOn(api, "promoteSkillSource").mockResolvedValue({ ...formal, version: 1 });
  const dialog = await choose(vi.fn().mockRejectedValue(new Error("Refresh failed")));
  fireEvent.click(within(dialog).getByRole("button", { name: "Promote Skill" }));
  await screen.findByText(/was published, but the inventory could not be refreshed/);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(published).toHaveBeenCalledOnce();
});

it("shows a target-page failure in the review dialog while retaining its bounded retry", async () => {
  const more = vi.fn();
  const dialog = await choose(vi.fn(), { targets: [], hasMoreTargets: true, moreTargetsError: "Inventory page unavailable", onMoreTargets: more });
  expect(within(dialog).getByText("Inventory page unavailable")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Load more published Skills" }));
  expect(more).toHaveBeenCalledOnce();
});
