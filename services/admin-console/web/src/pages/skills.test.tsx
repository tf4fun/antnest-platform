import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
