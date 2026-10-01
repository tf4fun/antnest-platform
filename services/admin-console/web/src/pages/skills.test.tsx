import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { SkillSummary, SkillVersion } from "../lib/skills";
import { SkillsPage } from "./skills";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const skill: SkillSummary = {
  skill_id: "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "review", current_version: 2,
  description: "Review code changes", artifact_digest: "sha256:a", content_digest: "sha256:b",
  artifact_size: 100, unpacked_size: 200, package_rules_version: 1,
};

it("shows an accessible ZIP picker, selected package details and an empty publication guard", async () => {
  vi.spyOn(api, "skills").mockResolvedValue({ items: [skill], next_after_id: null });
  const publish = vi.spyOn(api, "publishSkill").mockResolvedValue({ ...skill, version: 3 });
  render(<SkillsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Upload Skill" }));
  const dialog = screen.getByRole("dialog", { name: "Upload Skill" });
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Publish Skill" }).disabled).toBe(true);
  const input = within(dialog).getByLabelText<HTMLInputElement>("Skill ZIP");
  const click = vi.spyOn(input, "click");
  fireEvent.click(within(dialog).getByRole("button", { name: "Choose ZIP file" }));
  expect(click).toHaveBeenCalledOnce();
  const file = new File(["package"], "review.zip", { type: "application/zip" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(within(dialog).getByText("review.zip")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Change file" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish Skill" }));
  await waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(file));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("clears the chosen ZIP when the upload dialog is cancelled and reopened", async () => {
  vi.spyOn(api, "skills").mockResolvedValue({ items: [skill], next_after_id: null });
  render(<SkillsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Upload Skill" }));
  fireEvent.change(screen.getByLabelText("Skill ZIP"), { target: { files: [new File(["zip"], "review.zip")] } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Upload Skill" }));
  expect(screen.queryByText("review.zip")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Publish Skill" }).disabled).toBe(true);
});

it("shows a separately paginated organization Skill inventory", async () => {
  const list = vi.spyOn(api, "skills")
    .mockResolvedValueOnce({ items: [skill], next_after_id: "next" })
    .mockResolvedValueOnce({ items: [{ ...skill, skill_id: "skill_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "deploy" }], next_after_id: null });
  render(<SkillsPage />);
  expect((await screen.findByRole("link", { name: /review/i })).getAttribute("href")).toBe(`#skills/${skill.skill_id}`);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByRole("link", { name: /deploy/i });
  expect(list).toHaveBeenCalledWith("next");
});

it("waits for the current version before offering a CAS publication", async () => {
  const base: SkillVersion = { ...skill, version: 1 };
  const list = vi.spyOn(api, "skillVersions")
    .mockResolvedValueOnce({ items: [base], next_after_version: 1 })
    .mockResolvedValueOnce({ items: [{ ...base, version: 2 }], next_after_version: null });
  render(<SkillsPage skillID={skill.skill_id} />);
  await screen.findByText("Version 1");
  expect(screen.queryByRole("button", { name: "Publish new version" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish new version" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Publish new version" }));
  expect(screen.getByText(/Expected current version: 2/)).toBeTruthy();
  expect(list).toHaveBeenCalledWith(skill.skill_id, 1);
});

it("opens source discovery without issuing a search or publication automatically", async () => {
  vi.spyOn(api, "skills").mockResolvedValue({ items: [], next_after_id: null });
  const search = vi.spyOn(api, "searchSkillSources");
  const promote = vi.spyOn(api, "promoteSkillSource");
  render(<SkillsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Discover Agent Skills" }));
  expect(screen.getByRole("searchbox", { name: "Search Agent Skills" })).toBeTruthy();
  expect(search).not.toHaveBeenCalled();
  expect(promote).not.toHaveBeenCalled();
});
