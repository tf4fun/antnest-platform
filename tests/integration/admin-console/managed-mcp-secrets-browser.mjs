import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durablePath } from "../../support/storage.mjs";
import {
  assertNoOverflow,
  withConsoleBrowser,
} from "./console-browser-harness.mjs";

const output = durablePath(
  fileURLToPath(
    new URL(
      "../../../artifacts/verification/console-managed-mcp-secrets/",
      import.meta.url,
    ),
  ),
);
const time = "2026-10-06T00:00:00Z";
const model = {
  model_profile_id: "model-1",
  revision_id: "model-rev-1",
  revision: 1,
  display_name: "Fixture model",
  enabled: true,
  model: { model: "fixture" },
  created_at: time,
  updated_at: time,
};
const server = {
  id: "docs",
  command: "node",
  args: [],
  env: { LOG_LEVEL: "info" },
  secret_env: { API_KEY: { set: true, fingerprint: "sha256:1234abcd" } },
};
const template = {
  template_id: "template-1",
  revision: 1,
  name: "Secret template",
  enabled: true,
  model_profile_id: model.model_profile_id,
  system_prompt: "",
  max_model_requests: 32,
  context_policy_version: "context-v1",
  skill_refs: [],
  runtime: {
    image_ref: "runtime:local",
    resources: {
      memory_bytes: 536870912,
      pids_limit: 128,
      tmpfs_bytes: 67108864,
    },
    mcp_servers: [server],
  },
  created_at: time,
  updated_at: time,
};

async function exercise(browser, origin, viewport, label) {
  const context = await browser.newContext({ viewport });
  const writes = [],
    errors = [],
    unexpected = [];
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (
        request.method() === "POST" &&
        url.pathname === "/api/admin/templates/template-1/revisions"
      ) {
        writes.push(request.postDataJSON());
        return route.fulfill({
          status: 201,
          json: { ...template, revision: 2 },
        });
      }
      const fixtures = {
        "/api/session": {
          principal: {
            user_id: "admin",
            organization_id: "org",
            membership_id: "member",
            system_role: "admin",
            organization_role: "admin",
            active: true,
          },
        },
        "/api/admin/account": {
          account: {
            email: "admin@example.test",
            display_name: "Admin",
            source: "local",
            organization_slug: "test",
            organization_name: "Test",
            local_password_available: true,
          },
        },
        "/api/admin/execution-synchronization": {
          synchronization: {
            revision: 1,
            applied_revision: 1,
            updated_at: time,
            applied_at: time,
          },
        },
        "/api/admin/templates": { items: [template] },
        "/api/admin/templates/template-1": template,
        "/api/admin/templates/template-1/revisions/1": template,
        "/api/admin/template-defaults": { runtime_image_ref: "runtime:local" },
        "/api/admin/model-profiles": { items: [model] },
        "/api/admin/model-profiles/model-1": model,
        "/api/admin/skills": { items: [], next_after_id: null },
      };
      if (!(url.pathname in fixtures)) unexpected.push(url.pathname);
      return route.fulfill({
        status: url.pathname in fixtures ? 200 : 503,
        json: fixtures[url.pathname] ?? {},
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const open = async () => {
      await page.goto(`${origin}/#templates/template-1`);
      await page.getByRole("button", { name: "Create revision" }).click();
      return page.getByRole("dialog");
    };
    let dialog = await open();
    assert.equal(await dialog.getByLabel("Secret 1 value").count(), 0);
    await dialog.getByText(/Stored · sha256:1234abcd/).waitFor();
    await page.screenshot({
      path: resolve(output, `${label}-keep.png`),
      fullPage: true,
    });
    await assertNoOverflow(page);
    await dialog.getByRole("button", { name: "Publish revision" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(writes[0].runtime.mcp_servers[0].secret_env, {
      API_KEY: { keep: true },
    });
    dialog = await open();
    await dialog.getByRole("button", { name: "Replace secret 1" }).click();
    await dialog
      .getByLabel("Secret 1 value", { exact: true })
      .fill("browser-secret-canary");
    await dialog.getByRole("button", { name: "Publish revision" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(writes[1].runtime.mcp_servers[0].secret_env, {
      API_KEY: { value: "browser-secret-canary" },
    });
    dialog = await open();
    await dialog.getByRole("button", { name: "Remove secret 1" }).click();
    await dialog.getByRole("button", { name: "Publish revision" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(writes[2].runtime.mcp_servers[0].secret_env, undefined);
    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    assert(!stored.includes("browser-secret-canary"));
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    return {
      viewport: label,
      secret_actions: ["keep", "replace", "clear"],
      writes: writes.length,
      browser_errors: errors.length,
    };
  } finally {
    await context.close();
  }
}

console.log(
  JSON.stringify({ results: await withConsoleBrowser(output, exercise) }),
);
