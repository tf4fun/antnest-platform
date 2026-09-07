import { DomainError } from "../domain/errors.js";
import type { RuntimeInformation } from "../domain/runtime-information.js";

export function runtimeContext(information: RuntimeInformation, characterBudget: number): string {
  const notice =
    "\n[Runtime information truncated; use read at the listed root/path for complete guidance or skill contents. Additional entries may be omitted.]";
  const sections = [
    "# Current Runtime information (refreshed for this request)",
    `Environment: ${JSON.stringify(information.environment)}`,
    "Skill entries are summaries. Read the listed root/path before use. System skills are platform-provided; personal skills are workspace-owned.",
  ];
  if (information.instructions !== null)
    sections.push(`## Workspace guidance ${JSON.stringify(information.instructions.path)}`);
  let remaining = characterBudget - notice.length - sections.join("\n").length;
  if (remaining < 0)
    throw new DomainError(
      "context_budget_exhausted",
      "Runtime guidance locators exceed the context budget",
    );
  let truncated = information.truncated || information.instructions?.truncated === true;
  if (information.instructions !== null) {
    const content = information.instructions.content;
    const prefix = content.slice(0, Math.max(0, Math.floor(remaining / 2) - 1));
    sections.push(prefix);
    remaining -= prefix.length + 1;
    truncated ||= prefix.length < content.length;
  }
  // Keep metadata entries whole so every retained locator remains usable.
  const entries = [
    ...information.skills.map((skill) => JSON.stringify(skill)),
    ...information.warnings.map(
      (warning) => `Runtime information warning: ${JSON.stringify(warning)}`,
    ),
  ];
  for (const entry of entries) {
    if (entry.length + 1 > remaining) {
      truncated = true;
      continue;
    }
    sections.push(entry);
    remaining -= entry.length + 1;
  }
  return sections.join("\n") + (truncated ? notice : "");
}
