import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durablePath } from "../../support/storage.mjs";
import {
  assertNoOverflow,
  withConsoleBrowser,
} from "./console-browser-harness.mjs";

const output = fileURLToPath(
  new URL(
    "../../../artifacts/verification/console-agent-skill-lifecycle-preview/",
    import.meta.url,
  ),
);
durablePath(output);
const now = "2026-09-27T12:00:00Z";
const template = {
  template_id: "template-1",
  name: "Operations assistant",
  revision: 3,
  enabled: true,
  model_profile_id: "model-1",
  system_prompt: "",
  max_model_requests: 32,
  skill_refs: [
    {
      skill_id: "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      version: 2,
      name: "code-review",
    },
  ],
  context_policy_version: "context-v1",
  runtime: {
    image_ref: "antnest/antnest-runtime:local",
    resources: {
      memory_bytes: 536870912,
      pids_limit: 128,
      tmpfs_bytes: 104857600,
    },
  },
  created_at: now,
  updated_at: now,
};
const member = {
  user: {
    id: "user-1",
    system_role: "user",
    active: true,
    created_at: now,
    updated_at: now,
  },
  membership: {
    id: "member-1",
    user_id: "user-1",
    email: "owner@example.test",
    display_name: "Operations owner",
    role: "member",
    source: "local",
    active: true,
    created_at: now,
    updated_at: now,
  },
};

async function exercise(browser, origin, viewport, label) {
  const results = [];
  for (const action of ["rebuild", "enable"]) {
    const context = await browser.newContext({ viewport });
    const errors = [];
    const unexpected = [];
    const writes = [];
    try {
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname.endsWith("/events/watch"))
          return route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: "",
          });
        if (
          url.pathname === `/api/admin/agents/agent-1/${action}` &&
          request.method() === "POST"
        ) {
          writes.push({
            body: request.postData(),
            key: request.headers()["idempotency-key"],
          });
          return route.fulfill({
            status: 503,
            json: {
              code: "dependency_unavailable",
              message: "Skill preparation continues",
              retryable: true,
            },
          });
        }
        const agent = {
          agent_id: "agent-1",
          owner_user_id: "user-1",
          name: "Operations Agent",
          desired_state: action === "enable" ? "disabled" : "enabled",
          lifecycle_state: "created",
          activation_state: action === "enable" ? "disabled" : "enabled",
          runtime_state: action === "enable" ? "absent" : "available",
          aggregate_sequence: 3,
          agent_spec_revision: "spec-1",
          runtime: { runtime_revision: "runtime-1" },
          executable_execution_revision:
            action === "enable" ? undefined : "execution-1",
          created_at: now,
          updated_at: now,
        };
        const fixtures = {
          "/api/session": {
            principal: {
              user_id: "user-admin",
              organization_id: "org-test",
              membership_id: "member-test",
              system_role: "admin",
              organization_role: "admin",
              active: true,
            },
          },
          "/api/admin/account": {
            account: {
              email: "admin@example.test",
              display_name: "Administrator",
              source: "local",
              organization_slug: "test",
              organization_name: "Test organization",
              local_password_available: true,
            },
          },
          "/api/admin/execution-synchronization": { synchronization: null },
          "/api/admin/agents/agent-1": agent,
          "/api/admin/agents/agent-1/events": { events: [], next_sequence: 0 },
          "/api/admin/agents/agent-1/network-policy": {
            agent_id: "agent-1",
            action: "deny_all",
            resource_version: 7,
            attachment: { state: "open", resource_version: 4 },
          },
          "/api/admin/templates": { items: [template], next_after_id: null },
          "/api/admin/directory": { users: [member], groups: [] },
          "/api/admin/agent-skill-preparations/by-idempotency-key": {
            request_id: "request-1",
            agent_id: "agent-1",
            kind: action,
            state: "retry_wait",
            progress: {
              verified_packages: 1,
              verified_bytes: 3100000,
              total_packages: 2,
              total_bytes: 6200000,
            },
            updated_at: now,
          },
        };
        if (!(url.pathname in fixtures))
          unexpected.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({
          status: url.pathname in fixtures ? 200 : 503,
          json: fixtures[url.pathname] ?? { code: "unexpected" },
        });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/#agents/agent-1`);
      await page
        .getByRole("button", {
          name: action === "rebuild" ? "Rebuild" : "Enable",
          exact: true,
        })
        .click();
      if (action === "rebuild") {
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("Template").selectOption("template-1");
        await dialog
          .getByRole("button", { name: "Rebuild", exact: true })
          .click();
      }
      await page.getByText("1 of 2 Skills verified").waitFor();
      await assertNoOverflow(page);
      await page.screenshot({
        path: resolve(output, `${label}-${action}.png`),
        fullPage: true,
      });
      const retryResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/admin/agents/agent-1/${action}` &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", {
          name: action === "rebuild" ? "Retry rebuild" : "Retry enable",
        })
        .click();
      await retryResponse;
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], writes[0]);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      results.push({
        action,
        screenshot: `${label}-${action}.png`,
        writes: writes.length,
        browserErrors: errors.length,
      });
    } finally {
      await context.close();
    }
  }
  return { viewport: label, results };
}

console.log(
  JSON.stringify({
    screenshots: output,
    results: await withConsoleBrowser(output, exercise),
  }),
);
