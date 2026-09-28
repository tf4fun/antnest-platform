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
    "../../../artifacts/verification/console-agent-skill-preparation-preview/",
    import.meta.url,
  ),
);
durablePath(output);
const timestamp = "2026-09-27T12:00:00Z";
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
  created_at: timestamp,
  updated_at: timestamp,
};
const member = {
  user: {
    id: "user-1",
    system_role: "user",
    active: true,
    created_at: timestamp,
    updated_at: timestamp,
  },
  membership: {
    id: "member-1",
    user_id: "user-1",
    email: "owner@example.test",
    display_name: "Operations owner",
    role: "member",
    source: "local",
    active: true,
    created_at: timestamp,
    updated_at: timestamp,
  },
};

async function exercise(browser, origin, viewport, label) {
  const context = await browser.newContext({ viewport });
  const unexpected = [];
  const errors = [];
  const writes = [];
  try {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (
        url.pathname === "/api/admin/agents" &&
        route.request().method() === "POST"
      ) {
        writes.push({
          body: route.request().postData(),
          key: route.request().headers()["idempotency-key"],
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
        "/api/admin/agents": { items: [], next_cursor: null },
        "/api/admin/templates": { items: [template], next_after_id: null },
        "/api/admin/directory": { users: [member], groups: [] },
        "/api/admin/agent-skill-preparations/by-idempotency-key": {
          request_id: "request-1",
          agent_id: "agent-1",
          kind: "create",
          state: "preparing",
          progress: {
            verified_packages: 1,
            verified_bytes: 3100000,
            total_packages: 2,
            total_bytes: 6200000,
          },
          updated_at: timestamp,
        },
      };
      if (!(url.pathname in fixtures))
        unexpected.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({
        status: url.pathname in fixtures ? 200 : 503,
        json: fixtures[url.pathname] ?? { code: "unexpected" },
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#agents`);
    await page.getByRole("button", { name: "Create Agent" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Operations Agent");
    await dialog.getByLabel("Owner").selectOption("user-1");
    await dialog.getByLabel("Template").selectOption("template-1");
    await dialog.getByRole("button", { name: "Create Agent" }).click();
    await dialog.getByText("1 of 2 Skills verified").waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-preparing.png`),
      fullPage: true,
    });
    const retryResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/admin/agents" &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Retry creation" }).click();
    await retryResponse;
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0]);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    return {
      viewport: label,
      screenshot: `${label}-preparing.png`,
      writes: writes.length,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

console.log(
  JSON.stringify({
    screenshots: output,
    results: await withConsoleBrowser(output, exercise),
  }),
);
