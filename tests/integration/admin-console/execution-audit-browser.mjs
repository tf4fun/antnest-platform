import { durablePath } from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoOverflow,
  withConsoleBrowser,
} from "./console-browser-harness.mjs";

const output = fileURLToPath(
  new URL(
    "../../../artifacts/verification/console-audit-browser/",
    import.meta.url,
  ),
);
durablePath(output);
const summary = {
  run_id: "run/one #2",
  session_id: "session-audit",
  agent_id: "deleted-agent",
  principal_id: "user-archive",
  state: "completed",
  created_at: "2026-09-14T10:00:00.123456Z",
  updated_at: "2026-09-14T10:01:00Z",
};
const detail = {
  ...summary,
  input: [{ type: "text", text: "Generate the quarterly operations report." }],
  execution_snapshot: {
    modelProfileId: "reporting-model",
    executionSpec: {
      model: { model: "synthetic-model", contextWindow: 128000 },
      systemPrompt: "Summarize verified business data.",
    },
  },
  terminal_class: "completed",
  executor_state: "quiescent",
  tool_effect_state: "settled",
  stop_reason: "end_turn",
  error_class: null,
  usage_measurements: [{ input_tokens: 840, output_tokens: 210 }],
};

function apiFixture(url) {
  if (url.pathname === "/api/session")
    return {
      principal: {
        user_id: "admin-test",
        organization_id: "org-test",
        membership_id: "member-test",
        system_role: "admin",
        organization_role: "admin",
        active: true,
      },
    };
  if (url.pathname === "/api/admin/account")
    return {
      account: {
        email: "audit-admin@example.test",
        display_name: "Audit administrator",
        source: "local",
        organization_slug: "test",
        organization_name: "Test organization",
        local_password_available: true,
      },
    };
  if (url.pathname === "/api/admin/execution-audits")
    return { items: [summary], next_cursor: null };
  const path = `/api/admin/execution-audits/${encodeURIComponent(summary.run_id)}`;
  if (url.pathname === path) return detail;
  if (url.pathname !== `${path}/events`) return undefined;
  const stream = url.searchParams.get("stream");
  return {
    stream,
    next_cursor: null,
    items:
      stream === "execution"
        ? [
            {
              id: "tool-start",
              sequence: 1,
              kind: "tool_start",
              visible: true,
              payload: { command: "python report.py" },
              created_at: summary.created_at,
            },
            {
              id: "tool-result",
              sequence: 2,
              kind: "tool_result",
              visible: true,
              payload: {
                exit_code: 0,
                output: "/workspace/quarterly-report.md",
                diagnostic: "x".repeat(300),
              },
              created_at: summary.updated_at,
            },
          ]
        : [
            {
              tool_call_id: "report-tool",
              request: { command: "python report.py" },
              decision: "allow_once",
              reason: "Approved for this report",
              created_at: summary.created_at,
              decided_at: summary.updated_at,
            },
          ],
  };
}

async function exercise(browser, origin, viewport, label) {
  const context = await browser.newContext({ viewport });
  const unexpected = [];
  const requests = [];
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push(request.url());
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        await route.continue();
        return;
      }
      requests.push(url.pathname);
      const body = apiFixture(url);
      if (request.method() !== "GET" || body === undefined)
        unexpected.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({
        status: body === undefined ? 503 : 200,
        json: body ?? { message: "Unexpected dependency" },
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#audits?agent_id=deleted-agent`);
    await page
      .getByRole("link", { name: summary.run_id, exact: true })
      .waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-list.png`),
      fullPage: true,
    });
    await page.getByRole("link", { name: summary.run_id, exact: true }).click();
    await page
      .getByRole("heading", { name: "Execution detail", exact: true })
      .waitFor();
    const events = page.getByRole("region", { name: "Execution events" });
    const permissions = page.getByRole("region", {
      name: "Permission records",
    });
    await permissions.getByText("allow_once", { exact: true }).waitFor();
    assert.equal(await page.locator("details[open]").count(), 0);
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-detail.png`),
      fullPage: true,
    });
    await events.locator("summary").filter({ hasText: "tool_result" }).click();
    await permissions.locator("summary").click();
    assert.match(await events.innerText(), /quarterly-report\.md/);
    assert.match(await permissions.innerText(), /Approved for this report/);
    const count = requests.filter((path) => path.endsWith("/events")).length;
    await page
      .getByRole("button", { name: "Refresh execution detail", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Execution detail", exact: true })
      .waitFor();
    assert.equal(await page.locator("details[open]").count(), 2);
    assert.equal(
      requests.filter((path) => path.endsWith("/events")).length,
      count,
    );
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-expanded.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    return {
      viewport: label,
      browserErrors: errors.length,
      unexpectedRequests: unexpected.length,
      overflow: false,
      refreshPreservesStreams: true,
    };
  } finally {
    await context.close();
  }
}

console.log(
  JSON.stringify({
    scope: "Console synthetic audit UI, not B5 integration",
    results: await withConsoleBrowser(output, exercise),
    screenshots: output,
  }),
);
