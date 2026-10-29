import { DomainError } from "../domain/errors.js";
import type { RuntimeInformation } from "../domain/runtime-information.js";

export function runtimeContext(
  information: RuntimeInformation,
  budget: number,
  estimate: (text: string) => number = (text) => text.length,
  mandatoryBudget: number = budget,
): string {
  const notice =
    "\n[Runtime information truncated; use read with the listed string path for complete guidance or skill contents. Additional entries may be omitted.]";
  const sections = [
    "# Current Runtime information (refreshed for this request)",
    `Environment: ${JSON.stringify(information.environment)}`,
    "Skill entries are summaries. Use read({path: the listed string path}) before use. File tools accept workspace-relative paths, /workspace/ paths and read-only /skills/ paths. System skills are platform-provided; personal skills are workspace-owned.",
  ];
  if (information.instructions !== null)
    sections.push(
      `## Workspace guidance ${JSON.stringify(toolPath(information.instructions.path))}`,
    );
  const baseCost = estimate(sections.join("\n") + notice);
  if (baseCost > mandatoryBudget)
    throw new DomainError(
      "context_budget_exhausted",
      "Runtime guidance locators exceed the context budget",
    );
  let remaining = Math.max(0, budget - baseCost);
  let truncated = information.truncated || information.instructions?.truncated === true;
  if (information.instructions !== null) {
    const content = information.instructions.content;
    const prefixBudget = Math.floor(remaining / 2);
    let prefix = content;
    if (estimate("\n" + content) > prefixBudget) {
      let lo = 0;
      let hi = content.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (estimate("\n" + content.slice(0, mid)) <= prefixBudget) lo = mid;
        else hi = mid - 1;
      }
      if (lo > 0 && lo < content.length) {
        const code = content.charCodeAt(lo - 1);
        if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
      }
      prefix = content.slice(0, lo);
    }
    sections.push(prefix);
    remaining -= estimate("\n" + prefix);
    truncated ||= prefix.length < content.length;
  }
  // Keep metadata entries whole so every retained locator remains usable.
  const entries = [
    ...information.skills.map((skill) => JSON.stringify({ ...skill, path: toolPath(skill.path) })),
    ...information.warnings.map(
      (warning) =>
        `Runtime information warning: ${JSON.stringify({ ...warning, path: toolPath(warning.path) })}`,
    ),
  ];
  for (const entry of entries) {
    if (estimate("\n" + entry) > remaining) {
      truncated = true;
      continue;
    }
    sections.push(entry);
    remaining -= estimate("\n" + entry);
  }
  return sections.join("\n") + (truncated ? notice : "");
}

function toolPath(path: { root: "workspace" | "system_skills"; path: string }): string {
  return `${path.root === "workspace" ? "/workspace" : "/skills"}/${path.path}`;
}
