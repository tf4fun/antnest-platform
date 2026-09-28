import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { SkillReference } from "../lib/skills";
import { TemplateSkills } from "./template-skills";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("adds a fixed version and retains the frozen revision until explicitly removed", async () => {
  const old = { skill_id: "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", version: 2, name: "review", description: "Review", artifact_digest: "sha256:a", content_digest: "sha256:b", artifact_size: 1, unpacked_size: 1, package_rules_version: 1 };
  const next = { ...old, skill_id: "skill_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", version: 4, name: "triage" };
  vi.spyOn(api, "skills").mockResolvedValue({ items: [{ ...next, current_version: 4 }], next_after_id: null });
  vi.spyOn(api, "skillVersions").mockResolvedValue({ items: [next, { ...next, version: 3 }], next_after_version: null });
  let selected: SkillReference[] = [{ skill_id: old.skill_id, version: old.version }];
  function Harness() {
    const [value, setValue] = useState(selected);
    return <TemplateSkills value={value} frozen={[old]} onChange={(nextValue: SkillReference[]) => { selected = nextValue; setValue(nextValue); }} />;
  }
  render(<Harness />);
  expect(screen.getByText("review · v2")).toBeTruthy();
  fireEvent.change(await screen.findByLabelText("Add Skill"), { target: { value: next.skill_id } });
  fireEvent.change(await screen.findByLabelText("Skill version"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Add fixed version" }));
  await waitFor(() => expect(selected).toEqual([
    { skill_id: old.skill_id, version: 2 },
    { skill_id: next.skill_id, version: 3 },
  ]));
  fireEvent.click(screen.getByRole("button", { name: "Remove review" }));
  expect(selected).toEqual([{ skill_id: next.skill_id, version: 3 }]);
});
