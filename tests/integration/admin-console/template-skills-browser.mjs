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
    "../../../artifacts/verification/console-template-skills-preview/",
    import.meta.url,
  ),
);
durablePath(output);
const skillID = "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const skill = {
  skill_id: skillID,
  name: "code-review",
  description: "Review changes for correctness and security.",
  artifact_digest: `sha256:${"a".repeat(64)}`,
  content_digest: `sha256:${"b".repeat(64)}`,
  artifact_size: 128,
  unpacked_size: 256,
  package_rules_version: 1,
};
const model = {
  model_profile_id: "model-1",
  provider_connection_id: "connection-1",
  display_name: "Operations model",
  revision_id: "revision-1",
  revision: 1,
  enabled: true,
  model: {
    base_url: "https://models.example.test",
    model: "operations-model",
    context_window: 128000,
    max_output_tokens: 8192,
    supports_images: false,
  },
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z",
};
const template = {
  template_id: "template-1",
  name: "Operations assistant",
  revision: 3,
  enabled: true,
  model_profile_id: model.model_profile_id,
  system_prompt: "Summarize verified operational data.",
  max_model_requests: 32,
  context_policy_version: "context-v1",
  skill_refs: [{ ...skill, version: 2 }],
  skill_set_digest: `sha256:${"c".repeat(64)}`,
  runtime: {
    image_ref: "antnest/antnest-runtime:local",
    resources: {
      memory_bytes: 536870912,
      pids_limit: 128,
      tmpfs_bytes: 104857600,
    },
  },
  created_at: model.created_at,
  updated_at: model.updated_at,
};

async function exercise(browser, origin, viewport, label) {
  const context = await browser.newContext({ viewport });
  const writes = [];
  const errors = [];
  const unexpected = [];
  try {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (
        route.request().method() === "POST" &&
        (url.pathname === "/api/admin/templates" ||
          url.pathname === "/api/admin/templates/template-1/revisions")
      ) {
        writes.push({
          path: url.pathname,
          body: route.request().postDataJSON(),
        });
        return route.fulfill({
          status: 201,
          json: {
            ...template,
            revision: url.pathname.endsWith("/revisions") ? 4 : 1,
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
        "/api/admin/execution-synchronization": {
          synchronization: {
            revision: 1,
            applied_revision: 1,
            updated_at: model.updated_at,
            applied_at: model.updated_at,
          },
        },
        "/api/admin/templates": { items: [template], next_after_id: null },
        "/api/admin/templates/template-1": template,
        "/api/admin/template-defaults": {
          runtime_image_ref: "antnest/antnest-runtime:local",
        },
        "/api/admin/model-profiles": { items: [model], next_after_id: null },
        "/api/admin/model-profiles/model-1": model,
        "/api/admin/skills": {
          items: [{ ...skill, current_version: 2 }],
          next_after_id: null,
        },
        [`/api/admin/skills/${skillID}/versions`]: {
          items: [
            { ...skill, version: 2 },
            { ...skill, version: 1 },
          ],
          next_after_version: null,
        },
      };
      if (!(url.pathname in fixtures))
        unexpected.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({
        json: fixtures[url.pathname] ?? {
          code: "unexpected",
          message: url.pathname,
        },
        status: url.pathname in fixtures ? 200 : 503,
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#templates`);
    await page.getByRole("button", { name: "Create template" }).first().click();
    await page.getByLabel("Add Skill").waitFor();
    await page.getByLabel("Add Skill").selectOption(skillID);
    await page.getByLabel("Skill version").selectOption("1");
    await page.getByRole("button", { name: "Add fixed version" }).click();
    await page.screenshot({
      path: resolve(output, `${label}-create.png`),
      fullPage: true,
    });
    await assertNoOverflow(page);
    const creation = page.getByRole("dialog");
    await creation.getByLabel("Template name").fill("New assistant");
    await creation
      .getByLabel("Model", { exact: true })
      .selectOption(model.model_profile_id);
    await creation.getByRole("button", { name: "Create template" }).click();
    await page.getByText("New assistant created.").waitFor();
    assert.deepEqual(writes[0]?.body.skill_refs, [
      { skill_id: skillID, version: 1 },
    ]);
    await page.goto(`${origin}/#templates/template-1`);
    await page.getByRole("button", { name: "Create revision" }).click();
    await page.getByText("code-review · v2").last().waitFor();
    await page.screenshot({
      path: resolve(output, `${label}-revision.png`),
      fullPage: true,
    });
    await assertNoOverflow(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Publish revision" })
      .click();
    await page.getByText("Template revision 4 published.").waitFor();
    assert.deepEqual(writes[1]?.body.skill_refs, [
      { skill_id: skillID, version: 2 },
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    return {
      viewport: label,
      create: `${label}-create.png`,
      revision: `${label}-revision.png`,
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
