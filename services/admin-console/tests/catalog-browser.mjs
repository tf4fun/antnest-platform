import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoOverflow,
  withConsoleBrowser,
} from "./console-browser-harness.mjs";

const output = fileURLToPath(
  new URL("../../../.cache/console-catalog-browser/", import.meta.url),
);
const time = "2026-09-14T00:00:00Z";
const connection = {
  connection_id: "connection-1",
  provider_key: "synthetic",
  display_name: "Enterprise model provider",
  base_url: "https://models.example.test",
  credential_method: "api_key",
  credential_revision: 1,
  credential_version: "revision-1",
  enabled: true,
  created_at: time,
  updated_at: time,
};
const model = {
  model_profile_id: "model-1",
  provider_connection_id: connection.connection_id,
  display_name: "Operations model",
  revision_id: "revision-1",
  revision: 1,
  enabled: true,
  model: {
    base_url: connection.base_url,
    model: "operations-model",
    context_window: 128000,
    max_output_tokens: 8192,
    supports_images: false,
  },
  created_at: time,
  updated_at: time,
};
const template = {
  template_id: "template-1",
  name: "Operations assistant",
  revision: 1,
  enabled: true,
  model_profile_id: model.model_profile_id,
  system_prompt: "Summarize verified operational data.",
  max_model_requests: 32,
  context_policy_version: "context-v1",
  skill_refs: [],
  runtime: {
    image_ref: "antnest/antnest-runtime:local",
    resources: {
      memory_bytes: 536870912,
      pids_limit: 128,
      tmpfs_bytes: 104857600,
    },
  },
  created_at: time,
  updated_at: time,
};

function fixtures() {
  const resources = {
    "provider-connections/connection-1": { ...connection },
    "model-profiles/model-1": { ...model },
    "templates/template-1": { ...template },
  };
  let conflict = true;
  let syncReads = 0;
  return (path, method, body) => {
    if (method === "PUT") {
      assert.match(
        path,
        /^\/api\/admin\/(provider-connections|model-profiles|templates)\/[^/]+\/availability$/,
      );
      assert.deepEqual(body, { expected_enabled: true, enabled: false });
      if (conflict) {
        conflict = false;
        return {
          status: 409,
          json: {
            code: "resource_in_use",
            message: "This provider is used by an active template.",
            references: [
              { kind: "template", resource_id: "template-1" },
              { kind: "agent", resource_id: "agent-1" },
              {
                kind: "lifecycle_operation",
                resource_id: "operation-1",
                agent_id: "agent-1",
              },
            ],
            references_truncated: true,
          },
        };
      }
      const key = path.slice("/api/admin/".length, -"/availability".length);
      const resource = resources[key];
      assert.ok(resource);
      resource.enabled = body.enabled;
      return {
        json: {
          resource_id: key.split("/")[1],
          enabled: body.enabled,
          updated_at: time,
        },
      };
    }
    assert.equal(method, "GET");
    if (path === "/api/session")
      return {
        json: {
          principal: {
            user_id: "admin-test",
            organization_id: "org-test",
            membership_id: "member-test",
            system_role: "admin",
            organization_role: "admin",
            active: true,
          },
        },
      };
    if (path === "/api/admin/account")
      return {
        json: {
          account: {
            email: "admin@example.test",
            display_name: "Test administrator",
            source: "local",
            organization_slug: "test",
            organization_name: "Test organization",
            local_password_available: true,
          },
        },
      };
    if (path === "/api/admin/execution-synchronization") {
      syncReads++;
      if (syncReads === 3)
        return {
          status: 503,
          json: {
            code: "unavailable",
            message: "Configuration status temporarily unavailable",
          },
        };
      return {
        json: {
          synchronization: {
            revision: 4,
            applied_revision: syncReads >= 4 ? 4 : 3,
            updated_at: time,
            applied_at: time,
          },
        },
      };
    }
    if (path === "/api/admin/model-catalog")
      return {
        json: {
          revision: "test",
          providers: [
            {
              provider_key: "synthetic",
              display_name: "Enterprise models",
              description: "",
              base_url: connection.base_url,
              custom: false,
              models: [
                {
                  model_id: model.model.model,
                  display_name: model.display_name,
                  ...model.model,
                },
              ],
            },
          ],
        },
      };
    if (path === "/api/admin/provider-connections")
      return {
        json: { items: [resources["provider-connections/connection-1"]] },
      };
    if (path === "/api/admin/model-profiles")
      return { json: { items: [resources["model-profiles/model-1"]] } };
    if (path === "/api/admin/templates/template-1/revisions/1")
      return { json: template };
    const resource = resources[path.slice("/api/admin/".length)];
    assert.ok(resource, `Unexpected API ${path}`);
    return { json: resource };
  };
}

async function exercise(browser, origin, viewport, label) {
  const context = await browser.newContext({ viewport });
  const fixture = fixtures();
  const errors = [];
  const writes = [];
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        errors.push(`Unexpected external request ${url.origin}`);
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        await route.continue();
        return;
      }
      try {
        if (request.method() !== "GET") writes.push(url.pathname);
        const response = fixture(
          url.pathname,
          request.method(),
          request.postDataJSON(),
        );
        await route.fulfill({
          status: response.status ?? 200,
          json: response.json,
        });
      } catch (cause) {
        errors.push(String(cause));
        await route.fulfill({
          status: 503,
          json: { message: "Unexpected synthetic request" },
        });
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#models`);
    await page
      .getByText("Configuration delivery pending", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: /Enterprise model provider/ })
      .click();
    await page.getByRole("switch", { name: "Provider enabled" }).click();
    await page
      .getByText("Reference list is incomplete.", { exact: true })
      .waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-references.png`),
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "Template template-1", exact: true })
      .click();
    await page.getByRole("switch", { name: "Template enabled" }).click();
    await page
      .getByText("Availability change saved.", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("switch", { name: "Template enabled" })
        .getAttribute("aria-checked"),
      "false",
    );
    await page
      .getByRole("button", { name: "Refresh configuration delivery" })
      .click();
    await page
      .getByText("Configuration delivery unknown", { exact: true })
      .waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-saved-delivery-unknown.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Refresh configuration delivery" })
      .click();
    await page
      .getByText("Configuration acknowledged", { exact: true })
      .waitFor();
    await page.goto(`${origin}/#models/model-1`);
    await page.getByRole("switch", { name: "Model enabled" }).click();
    await page
      .getByText("Availability change saved.", { exact: true })
      .waitFor();
    await page.goto(`${origin}/#models`);
    await page
      .getByRole("button", { name: /Enterprise model provider/ })
      .click();
    await page.getByRole("switch", { name: "Provider enabled" }).click();
    await page
      .getByText("Availability change saved.", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("switch", { name: "Provider enabled" })
        .getAttribute("aria-checked"),
      "false",
    );
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-provider-disabled.png`),
      fullPage: true,
    });
    await page.goto(`${origin}/#templates/template-1/revisions/1`);
    await page
      .getByRole("heading", { name: template.name, exact: true })
      .waitFor();
    assert.equal(await page.getByRole("switch").count(), 0);
    assert.deepEqual(writes, [
      "/api/admin/provider-connections/connection-1/availability",
      "/api/admin/templates/template-1/availability",
      "/api/admin/model-profiles/model-1/availability",
      "/api/admin/provider-connections/connection-1/availability",
    ]);
    assert.deepEqual(errors, []);
    return {
      viewport: label,
      writes: writes.length,
      browserErrors: 0,
      overflow: false,
    };
  } finally {
    await context.close();
  }
}

console.log(
  JSON.stringify({
    scope: "Console synthetic catalog UI, not B5 integration",
    results: await withConsoleBrowser(output, exercise),
    screenshots: output,
  }),
);
