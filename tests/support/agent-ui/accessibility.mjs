import assert from "node:assert/strict";
import AxeBuilder from "../../../services/agent-ui/web/node_modules/@axe-core/playwright/dist/index.mjs";

export async function assertWcagPage(page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary,
    })),
  }));
  assert.deepEqual(violations, [], "Workspace page must pass automated WCAG A/AA checks");
}
