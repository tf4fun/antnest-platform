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
    "../../../artifacts/verification/console-skills-browser/",
    import.meta.url,
  ),
);
durablePath(output);
const skillID = "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const metadata = {
  skill_id: skillID,
  name: "code-review",
  description: "Review changes for correctness and security.",
  artifact_digest: "sha256:a",
  content_digest: "sha256:b",
  artifact_size: 128,
  unpacked_size: 256,
  package_rules_version: 1,
};

async function exercise(browser, origin, viewport, label) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const unexpected = [];
  const errors = [];
  const publicationKeys = [];
  let head = 0;
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
      if (url.pathname === "/api/session")
        return route.fulfill({
          json: {
            principal: {
              user_id: "user-admin",
              organization_id: "org-test",
              membership_id: "member-test",
              system_role: "admin",
              organization_role: "admin",
              active: true,
            },
          },
        });
      if (url.pathname === "/api/admin/account")
        return route.fulfill({
          json: {
            account: {
              email: "admin@example.test",
              display_name: "Administrator",
              source: "local",
              organization_slug: "test",
              organization_name: "Test organization",
              local_password_available: true,
            },
          },
        });
      if (url.pathname === "/api/admin/skills" && request.method() === "GET")
        return route.fulfill({
          json: {
            items: head ? [{ ...metadata, current_version: head }] : [],
            next_after_id: null,
          },
        });
      if (url.pathname === "/api/admin/skills" && request.method() === "POST") {
        assert.match(
          request.headers()["content-type"] ?? "",
          /^multipart\/form-data;/,
        );
        assert.match(request.postData() ?? "", /artifact/);
        publicationKeys.push(request.headers()["idempotency-key"]);
        head = 1;
        return route.fulfill({
          status: 201,
          json: { ...metadata, version: head },
        });
      }
      if (
        url.pathname === `/api/admin/skills/${skillID}/versions` &&
        request.method() === "GET"
      )
        return route.fulfill({
          json: {
            items: Array.from({ length: head }, (_, index) => ({
              ...metadata,
              version: index + 1,
            })),
            next_after_version: null,
          },
        });
      if (
        url.pathname === `/api/admin/skills/${skillID}/versions` &&
        request.method() === "POST"
      ) {
        assert.match(request.postData() ?? "", /expected_version/);
        assert.match(request.postData() ?? "", /\r\n1\r\n/);
        publicationKeys.push(request.headers()["idempotency-key"]);
        head = 2;
        return route.fulfill({
          status: 201,
          json: { ...metadata, version: head },
        });
      }
      if (url.pathname === `/api/admin/skills/${skillID}/versions/1/artifact`)
        return route.fulfill({
          status: 200,
          contentType: "application/zip",
          body: Buffer.from("synthetic ZIP"),
        });
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({
        status: 503,
        json: { code: "unexpected", message: "Unexpected request" },
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#skills`);
    await page.getByText("No Skills published").waitFor();
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-empty.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Upload Skill" }).first().click();
    await page.locator('input[name="artifact"]').setInputFiles({
      name: "review.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("synthetic ZIP"),
    });
    await page.getByRole("button", { name: "Publish Skill" }).click();
    await page.getByRole("link", { name: /code-review/ }).waitFor();
    await page.screenshot({
      path: resolve(output, `${label}-inventory.png`),
      fullPage: true,
    });
    await page.getByRole("link", { name: /code-review/ }).click();
    await page.getByText("Version 1").waitFor();
    await page.getByRole("button", { name: "Publish new version" }).click();
    await page.getByText("Expected current version: 1.").waitFor();
    await page.locator('input[name="artifact"]').setInputFiles({
      name: "review-v2.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("synthetic ZIP v2"),
    });
    await page.getByRole("button", { name: "Publish version" }).click();
    await page.getByRole("heading", { name: "Version 2" }).waitFor();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download ZIP" }).first().click();
    assert.equal((await download).suggestedFilename(), `${skillID}-v1.zip`);
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-versions.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(publicationKeys.length, 2);
    assert.notEqual(publicationKeys[0], publicationKeys[1]);
    return {
      viewport: label,
      publications: publicationKeys.length,
      browserErrors: errors.length,
      unexpectedRequests: unexpected.length,
    };
  } finally {
    await context.close();
  }
}

console.log(
  JSON.stringify({
    scope:
      "Console synthetic Skills UI, not Registry/Controller Docker integration",
    results: await withConsoleBrowser(output, exercise),
    screenshots: output,
  }),
);
