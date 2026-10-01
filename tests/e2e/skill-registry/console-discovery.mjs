import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { assertNoOverflow } from "../../integration/admin-console/console-browser-harness.mjs";
import { skillArtifact } from "./stage3-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(
  new URL("../../../services/admin-console/web/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const id = randomUUID().slice(0, 8);
const project = `antnest-console-discovery-${id}`;
const registryImage = `antnest/skill-registry:console-discovery-${id}`;
const consoleImage = `antnest/admin-console:discovery-${id}`;
const output = resolve(
  root,
  `artifacts/verification/skill-discovery-d6-20261001/docker-${id}`,
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  ANTNEST_DISCOVERY_TEST_IMAGE: registryImage,
  ANTNEST_DISCOVERY_CONSOLE_IMAGE: consoleImage,
};
const controller = new AbortController();
const stop = () => {
  controller.abort();
  void browser?.close().catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const docker = dockerClient(env, controller.signal, 1200000);
const compose = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  project,
  "-f",
  resolve(root, "tests/e2e/skill-registry/console-discovery.compose.yaml"),
];
const token = "discovery-registry-control-token-at-least-32-bytes";
const org = `org_${"a".repeat(32)}`;
const owner = `user_${"c".repeat(32)}`;
const otherOwner = `user_${"d".repeat(32)}`;
const checks = [];
const commands = [];
const save = (name, value) =>
  writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const inventory = async (client) => ({
  containers: (await client(["ps", "-aq"])).split(/\s+/).filter(Boolean).sort(),
  networks: (await client(["network", "ls", "-q"]))
    .split(/\s+/)
    .filter(Boolean)
    .sort(),
  volumes: (await client(["volume", "ls", "-q"]))
    .split(/\s+/)
    .filter(Boolean)
    .sort(),
});
const principal = (actor = owner, organization = org, role = "admin") => ({
  "X-Antnest-User-ID": actor,
  "X-Antnest-Organization-ID": organization,
  "X-Antnest-Membership-ID": "membership-fixture",
  "X-Antnest-System-Role": "user",
  "X-Antnest-Organization-Role": role,
});
const asProjection = ({ artifact_reads, inspections, ...projection }) =>
  projection;
const selection = (projection) => ({
  skill_ref: {
    kind: "agent",
    agent_id: projection.agent_id,
    name: projection.name,
    sequence: projection.sequence,
  },
  expected_digest: projection.content_digest,
});
let baseline, primaryError, browser;
const built = [];
try {
  baseline = await inventory(docker);
  save("baseline.json", baseline);
  for (const [image, file] of [
    [registryImage, "services/skill-registry/Dockerfile"],
    [consoleImage, "services/admin-console/Dockerfile"],
  ]) {
    console.log(JSON.stringify({ project, stage: "build", image }));
    await docker(["build", "--tag", image, "--file", file, "."], true);
    built.push(image);
  }
  console.log(JSON.stringify({ project, stage: "start" }));
  await docker(
    [
      ...compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "--no-build",
      "--pull",
      "never",
    ],
    true,
  );
  const ids = (await docker([...compose, "ps", "-q"]))
    .split(/\s+/)
    .filter(Boolean);
  const rows = JSON.parse(await docker(["inspect", ...ids]));
  const origin = (service) => {
    const row = rows.find(
      (item) => item.Config.Labels["com.docker.compose.service"] === service,
    );
    const binding = row.NetworkSettings.Ports["8080/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    return `http://127.0.0.1:${binding.HostPort}`;
  };
  const registry = origin("registry"),
    source = origin("source"),
    consoleOrigin = origin("console");
  const fetchOptions = { signal: AbortSignal.timeout(20000) };
  async function request(path, body, status = 200, options = {}) {
    const { actor, organization, role, key, method = "POST" } = options;
    const response = await fetch(consoleOrigin + path, {
      ...fetchOptions,
      signal: AbortSignal.timeout(20000),
      method,
      headers: {
        ...principal(actor, organization, role),
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.headers
      .get("content-type")
      ?.includes("application/zip")
      ? Buffer.from(await response.arrayBuffer())
      : await response.json();
    assert.equal(
      response.status,
      status,
      `${path} returned ${response.status}: ${JSON.stringify(data)}`,
    );
    return data;
  }
  async function state(value) {
    const response = await fetch(source + "/fixture/state", {
      method: value ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: value ? JSON.stringify(value) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function index(projection) {
    const response = await fetch(registry + "/internal/skill-projections", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(asProjection(projection)),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
  }
  let current = await state();
  await index(current);
  console.log(
    JSON.stringify({ project, stage: "real-http-authorization-and-preview" }),
  );
  const result = await request("/api/admin/skill-sources/search", {
    query: "review",
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].skill_ref, selection(current).skill_ref);
  assert.deepEqual(
    (
      await request(
        "/api/admin/skill-sources/search",
        { query: "review" },
        200,
        { actor: otherOwner },
      )
    ).items,
    [],
  );
  assert.deepEqual(
    (
      await request(
        "/api/admin/skill-sources/search",
        { query: "review" },
        200,
        { organization: `org_${"e".repeat(32)}` },
      )
    ).items,
    [],
  );
  await request("/api/admin/skill-sources/search", { query: "review" }, 403, {
    role: "member",
  });
  await request(
    "/api/admin/skill-sources/search",
    { query: "review", actor_id: otherOwner },
    400,
  );
  await request("/api/admin/skill-sources/preview", selection(current), 404, {
    actor: otherOwner,
  });
  await request("/api/admin/skill-sources/promote", selection(current), 404, {
    actor: otherOwner,
    key: randomUUID(),
  });
  const preview = await request(
    "/api/admin/skill-sources/preview",
    selection(current),
  );
  assert.match(preview.skill_md, /version 1/);
  assert.deepEqual(
    preview.files.map((file) => file.path),
    ["SKILL.md"],
  );
  assert.deepEqual(
    (await request("/api/admin/skills", undefined, 200, { method: "GET" }))
      .items,
    [],
    "source mapping or preview must not copy a formal package",
  );
  checks.push(
    "trusted-caller-owner-only-member-and-tenant-boundaries",
    "preview-current-text-without-copy-or-install",
  );
  const stale = selection(current);
  current = await state({ version: 2, sequence: 2 });
  await index(current);
  await request("/api/admin/skill-sources/preview", stale, 409);
  await request("/api/admin/skill-sources/promote", stale, 409, {
    key: randomUUID(),
  });
  await state({ unavailable: true });
  await request("/api/admin/skill-sources/search", { query: "review" }, 503);
  await request("/api/admin/skill-sources/preview", selection(current), 503);
  current = await state({ unavailable: false, version: 1, sequence: 3 });
  await index(current);
  checks.push(
    "changed-source-needs-fresh-choice",
    "source-unavailable-is-not-empty-success",
  );

  browser = await chromium.launch({ headless: true });
  async function exercise(label, viewport, append) {
    const context = await browser.newContext({
      viewport,
      extraHTTPHeaders: principal(),
      acceptDownloads: true,
    });
    const unexpected = [],
      errors = [];
    try {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== consoleOrigin) {
          unexpected.push(url.toString());
          return route.abort();
        }
        // Gateway session/account shell only. All Skill reads/writes are real BFF HTTP.
        if (url.pathname === "/api/session")
          return route.fulfill({
            json: {
              principal: {
                user_id: owner,
                organization_id: org,
                membership_id: "membership-fixture",
                system_role: "user",
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
                display_name: "Source owner",
                source: "local",
                organization_slug: "test",
                organization_name: "Test organization",
                local_password_available: true,
              },
            },
          });
        if (
          url.pathname.startsWith("/api/") &&
          !url.pathname.startsWith("/api/admin/skills") &&
          !url.pathname.startsWith("/api/admin/skill-sources/")
        ) {
          unexpected.push(url.pathname);
          return route.abort();
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (req) => {
        if (new URL(req.url()).pathname === "/api/admin/skill-sources/promote")
          commands.push({
            body: req.postDataJSON(),
            key: req.headers()["idempotency-key"],
          });
      });
      await page.goto(consoleOrigin + "/#skills");
      await page.getByRole("button", { name: "Discover Agent Skills" }).click();
      await page
        .getByRole("searchbox", { name: "Search Agent Skills" })
        .fill("review");
      await page.getByRole("button", { name: "Find Skills" }).click();
      await page
        .getByRole("button", { name: "Review and promote code-review" })
        .click();
      let dialog = page.getByRole("dialog", { name: "Promote code-review" });
      await dialog.locator("pre").waitFor();
      assert.equal(
        await dialog
          .getByRole("button", { name: "Load more published Skills" })
          .count(),
        0,
        "terminal Registry inventory must not offer an empty next page",
      );
      await assertNoOverflow(page);
      await page.screenshot({
        path: resolve(output, `${label}-source-preview.png`),
        fullPage: true,
      });
      if (append) {
        const targetID = (
          await request("/api/admin/skills", undefined, 200, { method: "GET" })
        ).items[0].skill_id;
        await dialog
          .getByRole("combobox", { name: "Publication target" })
          .selectOption(targetID);
        await dialog
          .getByText("Expected current version: 1.", { exact: false })
          .waitFor();
        current = await state({ version: 2, sequence: 4 });
        await index(current);
        await dialog.getByRole("button", { name: "Promote Skill" }).click();
        await dialog.getByRole("button", { name: "Search again" }).waitFor();
        assert.equal(
          await dialog
            .getByRole("button", { name: "Promote Skill" })
            .isDisabled(),
          true,
        );
        await page.screenshot({
          path: resolve(output, `${label}-changed-source.png`),
          fullPage: true,
        });
        const attempts = commands.length;
        await dialog.getByRole("button", { name: "Search again" }).click();
        await page
          .getByRole("button", { name: "Review and promote code-review" })
          .click();
        dialog = page.getByRole("dialog", { name: "Promote code-review" });
        await dialog.locator("pre").waitFor();
        assert.match(await dialog.locator("pre").innerText(), /version 2/);
        assert.equal(
          commands.length,
          attempts,
          "review must not silently retry a write",
        );
        await dialog
          .getByRole("combobox", { name: "Publication target" })
          .selectOption(targetID);
      }
      await dialog.getByRole("button", { name: "Promote Skill" }).click();
      await page
        .getByText(new RegExp(`code-review v${append ? 2 : 1} promoted\\.`))
        .waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page
        .getByRole("button", { name: "Published Skills", exact: true })
        .click();
      await page.getByRole("link", { name: /code-review/ }).click();
      await page
        .getByRole("heading", {
          name: `Version ${append ? 2 : 1}`,
          exact: true,
        })
        .waitFor();
      await page.getByRole("button", { name: "Publish new version" }).waitFor();
      await assertNoOverflow(page);
      await page.screenshot({
        path: resolve(output, `${label}-promoted-version.png`),
        fullPage: true,
      });
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      return {
        viewport: label,
        browserErrors: errors.length,
        unexpectedRequests: unexpected.length,
      };
    } finally {
      await context.close();
    }
  }
  console.log(
    JSON.stringify({ project, stage: "desktop-mobile-real-console-ui" }),
  );
  const browserResults = [];
  browserResults.push(
    await exercise("desktop", { width: 1440, height: 1000 }, false),
  );
  browserResults.push(
    await exercise("mobile", { width: 390, height: 844 }, true),
  );
  checks.push(
    "desktop-create-after-review",
    "mobile-source-drift-explicit-rereview-and-append",
    "no-uncaught-browser-errors-or-overflow",
  );
  const formal = (
    await request("/api/admin/skills", undefined, 200, { method: "GET" })
  ).items[0];
  assert.equal(formal.current_version, 2);
  assert.equal(formal.content_digest, current.content_digest);
  const versions = await request(
    `/api/admin/skills/${formal.skill_id}/versions`,
    undefined,
    200,
    { method: "GET" },
  );
  assert.deepEqual(
    versions.items.map((version) => version.version),
    [1, 2],
  );
  assert.notEqual(
    versions.items[0].content_digest,
    versions.items[1].content_digest,
  );
  await request(
    "/api/admin/skill-sources/promote",
    { ...selection(current), skill_id: formal.skill_id, expected_version: 1 },
    409,
    { key: randomUUID() },
  );
  const receipt = commands.at(-1);
  assert(receipt?.key);
  assert.equal(receipt.body.skill_ref.sequence, 4);
  const beforeReplay = (await state()).artifact_reads;
  current = await state({ active: false, sequence: 5, unavailable: true });
  await index(current);
  const replay = await request(
    "/api/admin/skill-sources/promote",
    receipt.body,
    201,
    { key: receipt.key },
  );
  assert.equal(replay.skill_id, formal.skill_id);
  assert.equal(replay.version, 2);
  assert.equal(
    (await state()).artifact_reads,
    beforeReplay,
    "committed replay must not re-read unavailable source",
  );
  await request(
    "/api/admin/skill-sources/promote",
    { ...receipt.body, expected_version: 2 },
    409,
    { key: receipt.key },
  );
  const downloaded = await request(
    `/api/admin/skills/${formal.skill_id}/versions/2/artifact`,
    undefined,
    200,
    { method: "GET" },
  );
  assert.deepEqual(downloaded, skillArtifact(2));
  await request(
    `/api/admin/skills/${formal.skill_id}/versions`,
    undefined,
    404,
    { method: "GET", organization: `org_${"e".repeat(32)}` },
  );
  checks.push(
    "explicit-target-cas",
    "committed-replay-without-live-source",
    "immutable-formal-package-independent-of-source",
    "formal-tenant-isolation",
  );
  save("acceptance.json", {
    scope:
      "Real Console + Registry + PostgreSQL; synthetic private Agent source and Gateway session/account shell. DI1 full learning/Template/rebuild acceptance is separate.",
    checks,
    browserResults,
    publicationAttempts: commands.length,
    formalVersions: versions.items.map((item) => ({
      version: item.version,
      content_digest: item.content_digest,
    })),
  });
  console.log(
    JSON.stringify({ project, stage: "passed", checks: checks.length }),
  );
} catch (error) {
  primaryError = error;
  save("failure.json", { name: error.name, message: error.message });
} finally {
  const cleanup = dockerClient(env, undefined, 120000);
  try {
    await browser?.close();
  } catch (error) {
    primaryError ??= error;
  }
  try {
    await cleanup(
      [...compose, "down", "--volumes", "--remove-orphans", "--timeout", "10"],
      true,
    );
    for (const image of built.reverse()) await cleanup(["image", "rm", image]);
    const after = await inventory(cleanup);
    save("cleanup.json", after);
    if (baseline)
      assert.deepEqual(
        after,
        baseline,
        "D6 Docker resources must return to baseline",
      );
    assert.equal(
      (await cleanup(["ps", "-q"])).trim(),
      "",
      "existing acceptance containers must remain stopped",
    );
  } catch (error) {
    primaryError ??= error;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
}
if (primaryError) throw primaryError;
console.log(JSON.stringify({ project, output, status: "passed-and-cleaned" }));
