import { durablePath } from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { chromium } from "../../../services/admin-console/web/node_modules/playwright/index.mjs";

// Opt-in development acceptance. Performs discovery and adds one selected model;
// it never calls a completion endpoint, creates an Agent, or changes credentials.
const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    "env-file": { type: "string", default: ".env" },
    "secret-file": { type: "string", default: "../.secret" },
    "confirm-development": { type: "boolean", default: false },
  },
});
values["env-file"] = durablePath(values["env-file"]);
values["secret-file"] = durablePath(values["secret-file"]);
assert(
  values["confirm-development"],
  "Explicit development confirmation required",
);
const origin = new URL(values.gateway).origin;
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const config = parseEnv(readFileSync(values["env-file"], "utf8"));
const secrets = parseEnv(readFileSync(values["secret-file"], "utf8"));
assert(secrets.OPENROUTER_API_KEY, "OpenRouter discovery credential required");
const output = "artifacts/verification/model-discovery-acceptance";
durablePath(output);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(25000);
const report = { status: "running", checks: [] };
async function read(path) {
  const response = await context.request.get(origin + path);
  assert.equal(response.status(), 200, path);
  return response.json();
}
async function models() {
  const items = [];
  let after;
  do {
    const result = await read(
      "/api/admin/model-profiles" +
        (after ? "?after_id=" + encodeURIComponent(after) : ""),
    );
    items.push(...result.items);
    after = result.next_after_id;
  } while (after);
  return items;
}
async function screenshot(name) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert(!overflow, "Horizontal viewport overflow");
  await page.screenshot({ path: output + "/" + name + ".png", fullPage: true });
}
try {
  await page.goto(origin);
  await page
    .locator('[name="organization_slug"]')
    .fill(config.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG);
  await page
    .locator('[name="email"]')
    .fill(config.ANTNEST_BOOTSTRAP_ADMIN_EMAIL);
  await page
    .locator('[name="password"]')
    .fill(config.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD);
  const login = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/session/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  assert.equal((await login).status(), 200);
  const connectionsBefore = await read("/api/admin/provider-connections");
  const router = connectionsBefore.items.find(
    (item) => item.provider_key === "openrouter" && item.enabled,
  );
  assert(router, "An enabled OpenRouter connection is required");
  const before = await models();
  const remote = await read(
    "/api/admin/provider-connections/" +
      router.connection_id +
      "/models/discovery",
  );
  assert(remote.models.length > 0, "Remote discovery returned no models");
  assert(
    !JSON.stringify(remote).includes(secrets.OPENROUTER_API_KEY),
    "Credential leaked",
  );
  assert.deepEqual(await models(), before, "Discovery changed saved models");
  report.checks.push("real discovery is read-only and secret-free");
  const savedIDs = new Set(
    before
      .filter((item) => item.provider_connection_id === router.connection_id)
      .map((item) => item.model.model),
  );
  const candidate = remote.models.find(
    (item) =>
      !savedIDs.has(item.model_id) &&
      item.context_window >= 1024 &&
      item.max_output_tokens > 0 &&
      item.display_name.length < 120,
  );
  assert(candidate, "No unsaved, complete discovery candidate");

  await page.goto(origin + "/#models");
  await page
    .getByRole("button", { name: "Add provider", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Provider", { exact: true })
    .selectOption("openrouter");
  await dialog
    .getByLabel("API key", { exact: true })
    .fill(secrets.OPENROUTER_API_KEY);
  await dialog
    .getByRole("button", { name: "Select models", exact: true })
    .click();
  await dialog.getByRole("checkbox").first().waitFor();
  assert.equal(
    await dialog.locator('input[type="checkbox"]:checked').count(),
    0,
  );
  assert.deepEqual(
    await read("/api/admin/provider-connections"),
    connectionsBefore,
    "Draft discovery created a connection",
  );
  await screenshot("draft-desktop");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  report.checks.push("draft discovery does not persist or preselect models");

  await page
    .getByRole("button", { name: new RegExp(router.display_name) })
    .first()
    .click();
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").first().waitFor();
  await dialog.getByPlaceholder("Search models").fill(candidate.model_id);
  await dialog
    .getByRole("checkbox", { name: candidate.display_name, exact: true })
    .check();
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/admin/model-profiles") &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Add selected models", exact: true })
    .click();
  assert.equal((await saved).status(), 201);
  await dialog.waitFor({ state: "hidden" });
  const after = await models();
  assert.equal(after.length, before.length + 1);
  for (const item of before)
    assert.deepEqual(
      after.find((row) => row.model_profile_id === item.model_profile_id),
      item,
    );
  const added = after.find(
    (item) =>
      item.provider_connection_id === router.connection_id &&
      item.model.model === candidate.model_id,
  );
  assert(added);
  assert.equal(added.model.context_window, candidate.context_window);
  report.checks.push(
    "only the selected model is persisted; existing settings unchanged",
  );

  await page.getByRole("button", { name: "Add model", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").first().waitFor();
  await dialog.getByPlaceholder("Search models").fill(candidate.model_id);
  assert(
    await dialog
      .getByRole("checkbox", { name: candidate.display_name, exact: true })
      .isDisabled(),
  );
  await screenshot("saved-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("saved-mobile");
  await page.route(
    "**/api/admin/provider-connections/*/models/discovery",
    (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          code: "provider_discovery_failed",
          message: "Synthetic provider outage",
        }),
      }),
  );
  await dialog
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert(
    await dialog
      .getByRole("checkbox", { name: candidate.display_name, exact: true })
      .isDisabled(),
  );
  await dialog.getByPlaceholder("Search models").fill("");
  assert((await dialog.getByRole("checkbox").count()) >= 2);
  await screenshot("fallback-mobile");
  assert.deepEqual(
    await models(),
    after,
    "Refresh mutated saved configuration",
  );
  report.checks.push(
    "saved models survive refresh and outage, duplicates are disabled, mobile fits",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(
    output + "/summary.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
