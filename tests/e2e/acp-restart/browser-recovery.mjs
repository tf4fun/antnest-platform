import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { runC4BrowserScope } from "../workspace-closeout/c4-browser-scope.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";
import { captureNavigationResponse } from "../../support/browser-navigation-response.mjs";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";
import { gatewayBrowserRequest } from "../../support/gateway-browser-request.mjs";
import { assertOrganizationSession } from "../identity-closeout/organization-session.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { createRecoveryInventoryReader } from "./recovery-inventory.mjs";
import { publishAutomaticRecoveryCheckpoint } from "./automatic-recovery-capture.mjs";
import {
  assertPendingRecoveryEvidence,
  assertManualRecoveryEvidence,
  recoveryResourceID,
} from "./manual-recovery-evidence.mjs";
import { assertBrowserRecoveryRequests } from "./browser-recovery-evidence.mjs";

const [expectedFile, checkpoint, directory] = process.argv.slice(2);
assert(expectedFile && checkpoint && directory);
const expected = JSON.parse(await readFile(expectedFile, "utf8"));
const gateway = new URL(process.env.ANTNEST_EDGE_PUBLIC_BASE_URL).origin;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("browser recovery interrupted"));
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
const budget = Math.min(
  220000,
  Number(process.env.ANTNEST_E2E_DEADLINE_MS) - Date.now(),
);
assert(Number.isFinite(budget) && budget > 0);
const signal = AbortSignal.any([
  abort.signal,
  AbortSignal.timeout(Math.ceil(budget)),
]);
const requests = [],
  observations = [];
const save = (name, value) =>
  writeEvidenceFile(directory, name, JSON.stringify(value) + "\n");
const launch = () =>
  chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
const agentPath = `/api/admin/agents/${encodeURIComponent(expected.agent_id)}`;
const workspace = `/workspace/${encodeURIComponent(expected.agent_id)}/sessions/${encodeURIComponent(expected.session_id)}`;
const consolePath = `/#agents/${encodeURIComponent(expected.agent_id)}`;

async function login(scope, email, password, userID, role) {
  const page = await scope.context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => {
    scope.recordFailure(error);
    abort.abort(error);
  });
  await page.goto(new URL("/login", gateway).href, {
    waitUntil: "domcontentloaded",
  });
  await page.locator('[name="organization_slug"]').fill("stage3");
  await page.locator('[name="email"]').fill(email);
  await page.locator('[name="password"]').fill(password);
  const { response, body } = await captureNavigationResponse(
    page,
    {
      url: new URL("/api/session/login", gateway).href,
    },
    () => page.getByRole("button", { name: "Sign in", exact: true }).click(),
  );
  assert.equal(response.status(), 200);
  assert.deepEqual(response.request().postDataJSON(), {
    organization_slug: "stage3",
    email,
    password,
  });
  const principal = assertOrganizationSession(
    JSON.parse(body.toString("utf8")),
    "login",
  );
  assert.equal(principal.organization_id, expected.organization_id);
  assert.equal(principal.user_id, userID);
  assert.equal(principal.organization_role, role);
  assert.equal(principal.active, true);
  const issued = gatewaySessionCookies(
    (await response.headersArray())
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => h.value),
  );
  const actual = gatewaySessionCookies(
    (await scope.context.storageState()).cookies,
  );
  assert(issued.accessToken && issued.csrf);
  assert.deepEqual(actual, issued);
  return page;
}

// Observe original page requests only. No route interception, response
// substitution, lifecycle API replay, or direct test-side Rebuild is used.
function observe(page, scope, operationPath) {
  const rows = new Map();
  const track = (work) =>
    scope.track(async () => {
      try {
        return await work();
      } catch (error) {
        abort.abort(error);
        throw error;
      }
    });
  const guard = (handle) => (value) => {
    try {
      handle(value);
    } catch (error) {
      scope.recordFailure(error);
      abort.abort(error);
    }
  };
  const requested = guard((request) => {
    const url = new URL(request.url());
    if (url.origin !== gateway || !url.pathname.startsWith("/api/")) return;
    const row = {
      method: request.method(),
      path: url.pathname + url.search,
      headers: {},
      body: null,
      status: null,
    };
    rows.set(request, row);
    requests.push(row);
    if (row.method === "POST" && url.pathname === agentPath + "/rebuild") {
      row.body = request.postDataJSON();
      track(async () => {
        row.headers = await request.allHeaders();
      });
    }
  });
  const responded = guard((response) => {
    const row = rows.get(response.request());
    if (!row) return;
    row.status = response.status();
    if (
      row.path.split("?")[0] === operationPath ||
      (row.method === "POST" &&
        row.path.split("?")[0] === agentPath + "/rebuild")
    ) {
      track(async () => {
        row.responseBody = await response.json();
        row.traceID = await response.headerValue("x-antnest-trace-id");
      });
    }
  });
  page.on("request", requested);
  page.on("response", responded);
  scope.addObserver({
    async closeAndWait() {
      page.off("request", requested);
      page.off("response", responded);
    },
  });
}

async function readAgent(context) {
  const response = await gatewayBrowserRequest(
    context,
    new URL(agentPath, gateway).href,
    { method: "GET", timeout: 15000 },
  );
  assert.equal(response.status(), 200);
  return response.json();
}

try {
  const readSnapshot = await createRecoveryInventoryReader({
    expected,
    project: process.env.COMPOSE_PROJECT_NAME,
    signal,
    docker: dockerClient(process.env, signal, budget),
    projection: true,
  });
  const sample = async (stage) => {
    const data = await readSnapshot();
    observations.push({ stage, at: new Date().toISOString(), ...data });
    save("browser-recovery-database.private.json", observations);
    return data;
  };
  const pending = await until(
    async () => {
      const data = await sample("pending");
      for (const key of ["receipts", "rebuilds", "starts"])
        assert.deepEqual(
          data[key],
          [],
          "recovery started before browser action",
        );
      const observation = data.observations[0];
      if (
        !data.cycles[0] ||
        !observation?.barrier_hex ||
        observation.policy_mode !== expected.policy.mode ||
        observation.policy_revision !== expected.policy.revision ||
        (expected.policy.mode === "notify" && !data.notifications.length)
      )
        return false;
      assertPendingRecoveryEvidence(data, expected);
      return data;
    },
    "persisted current recovery observation",
    signal,
    90000,
  );
  const barrier = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(pending.cycles[0].barrier_hex, "hex"),
  );
  const wire = {
    agent_id: expected.agent_id,
    request_id: recoveryResourceID("rebuild", expected, barrier),
    body: {
      template_id: expected.source.template_id,
      template_revision: expected.source.template_revision,
      recovery: {
        barrier_id: barrier,
        expected_runtime_revision: expected.source.runtime_revision,
      },
    },
  };
  const operationPath = `/api/admin/operations/${encodeURIComponent(wire.request_id)}`;
  let completed;
  await runC4BrowserScope({ signal, launch }, async (ownerScope) => {
    const owner = await login(
      ownerScope,
      "restart-owner@example.com",
      "restart-owner-password",
      expected.owner_user_id,
      expected.owner_role,
    );
    observe(owner, ownerScope, operationPath);
    await owner.goto(new URL(workspace, gateway).href, {
      waitUntil: "domcontentloaded",
    });
    const alert = owner.getByRole("status", { name: "Workspace recovery" });
    await alert.waitFor({ state: "visible" });
    assert.match(await alert.textContent(), /Workspace recovery required/u);
    const link = alert.getByRole("link", {
      name: "Recover workspace",
      exact: true,
    });
    writeEvidenceFile(
      directory,
      "workspace-recovery-before.png",
      await owner.screenshot({ fullPage: true }),
    );
    if (expected.owner_role === "admin") {
      assert.equal(await link.getAttribute("href"), consolePath);
      await link.click();
      await owner
        .getByRole("heading", {
          name: "Runtime recovery required",
          exact: true,
        })
        .waitFor();
      assert.equal(owner.url(), new URL(consolePath, gateway).href);
      await owner.goto(new URL(workspace, gateway).href, {
        waitUntil: "domcontentloaded",
      });
      await alert.waitFor({ state: "visible" });
    } else {
      assert.equal(await link.count(), 0);
      assert.match(
        await alert.textContent(),
        /Contact an organization administrator/u,
      );
    }
    await runC4BrowserScope({ signal, launch }, async (adminScope) => {
      const page = await login(
        adminScope,
        "stage3-admin@example.com",
        "stage3-admin-password",
        expected.actor_principal_id,
        "admin",
      );
      observe(page, adminScope, operationPath);
      await page.goto(new URL(consolePath, gateway).href, {
        waitUntil: "domcontentloaded",
      });
      const heading = page.getByRole("heading", {
        name: "Runtime recovery required",
        exact: true,
      });
      await heading.waitFor();
      const original = await readAgent(adminScope.context);
      assert.equal(original.agent_id, expected.agent_id);
      assert.equal(
        original.configuration.template.template_id,
        expected.source.template_id,
      );
      assert.equal(
        original.configuration.template.revision,
        expected.source.template_revision,
      );
      const recovery = original.runtime_recovery;
      assert.equal(recovery.barrier_id, barrier);
      assert.equal(recovery.runtime_revision, expected.source.runtime_revision);
      assert.equal(recovery.rebuild_request_id, wire.request_id);
      assert.equal(recovery.reason, "runtime_barrier_required");
      assert.equal(recovery.mode, expected.policy.mode);
      assert.equal(recovery.policy_revision, expected.policy.revision);
      assert.equal(recovery.cooldown_ms, expected.policy.cooldown_ms);
      assert.equal(
        recovery.notification_id,
        recoveryResourceID("notification", expected, barrier),
      );
      if (expected.policy.mode === "notify")
        await page
          .locator("p")
          .filter({ hasText: /^Runtime recovery required$/u })
          .waitFor();
      await page.reload({ waitUntil: "domcontentloaded" });
      await heading.waitFor();
      assert.deepEqual(
        (await readAgent(adminScope.context)).runtime_recovery,
        recovery,
      );
      const before = await sample("after-refresh-before-click");
      assertPendingRecoveryEvidence(before, expected);
      assert.deepEqual(
        before.notifications,
        pending.notifications,
        "refresh duplicated or replaced notification",
      );
      await ownerScope.joinTasks();
      await adminScope.joinTasks();
      assertBrowserRecoveryRequests(requests, wire, { beforeDispatch: true });
      await page
        .getByRole("button", { name: "Recover Runtime", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Recover Runtime",
        exact: true,
      });
      await dialog.waitFor();
      assert(
        (await dialog.textContent()).includes(
          original.configuration.template.name,
        ),
      );
      assert(
        (await dialog.textContent()).includes(
          `revision ${expected.source.template_revision}`,
        ),
      );
      writeEvidenceFile(
        directory,
        "console-recovery-confirm.png",
        await page.screenshot({ fullPage: true }),
      );
      await adminScope.joinTasks();
      await ownerScope.joinTasks();
      assertBrowserRecoveryRequests(requests, wire, { beforeDispatch: true });
      assertPendingRecoveryEvidence(
        await sample("dialog-open-before-confirm"),
        expected,
      );
      await dialog
        .getByRole("button", { name: "Confirm recovery", exact: true })
        .click();
      await until(
        async () => {
          await adminScope.joinTasks();
          return requests.some(
            (row) => row.path === agentPath + "/rebuild" && row.responseBody,
          );
        },
        "original browser recovery response",
        signal,
        30000,
      );
      assertBrowserRecoveryRequests(requests, wire);
      await dialog.waitFor({ state: "hidden" });
      completed = await until(
        async () => {
          const data = await sample("recovering");
          for (const key of ["cycles", "receipts", "rebuilds", "starts"])
            assert(data[key].length <= 1, `duplicated ${key}`);
          assert.notEqual(
            data.receipts[0]?.state,
            "failed",
            "browser Rebuild failed",
          );
          if (
            !data.cycles[0]?.retired_at ||
            !data.receipts[0]?.started_at ||
            data.receipts[0]?.state !== "completed"
          )
            return false;
          assertManualRecoveryEvidence(data, expected);
          return data;
        },
        "browser recovery completed and original barrier retired",
        signal,
        120000,
      );
      await alert.waitFor({ state: "hidden", timeout: 30000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByRole("heading", { name: "Last operation", exact: true })
        .waitFor();
      assert.equal(
        Object.hasOwn(await readAgent(adminScope.context), "runtime_recovery"),
        false,
      );
      await adminScope.joinTasks();
      await ownerScope.joinTasks();
      assertBrowserRecoveryRequests(requests, wire);
      writeEvidenceFile(
        directory,
        "console-recovery-completed.png",
        await page.screenshot({ fullPage: true }),
      );
      writeEvidenceFile(
        directory,
        "workspace-recovery-cleared.png",
        await owner.screenshot({ fullPage: true }),
      );
    });
  });
  // Browser scopes close actual contexts, browsers, response readers and
  // observers before the client is released to verify physical retirement.
  const final = await sample("browsers-joined");
  assert.deepEqual(
    assertManualRecoveryEvidence(final, expected),
    completed.receipts[0],
  );
  assert.deepEqual(final.notifications, pending.notifications);
  const post = assertBrowserRecoveryRequests(requests, wire);
  save("browser-recovery-requests.private.json", requests);
  save("browser-recovery-result.json", {
    status: "browser_recovery_passed",
    mode: expected.policy.mode,
    request_id: wire.request_id,
    owner_role: expected.owner_role,
    browsers_joined: true,
  });
  await publishAutomaticRecoveryCheckpoint(
    checkpoint,
    {
      ...final,
      browser: { request_id: wire.request_id, trace_id: post.traceID },
    },
    { signal },
  );
} catch (error) {
  save("browser-recovery-requests.private.json", requests);
  save("browser-recovery-failure.private.json", {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  console.error(
    "Browser Runtime recovery failed; private original observations retained",
  );
  process.exitCode = 1;
} finally {
  abort.abort();
  for (const event of ["SIGINT", "SIGTERM"])
    process.removeListener(event, interrupt);
}
