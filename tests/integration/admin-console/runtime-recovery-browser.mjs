import assert from "node:assert/strict";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertNoOverflow,
  consoleSessionMetadata,
  fulfillConsoleActivity,
  prepareConsoleSession,
} from "./console-browser-harness.mjs";

const timestamp = "2026-09-07T00:00:00Z";
const requestID = "rebuild_original";
const operationPath = `/api/admin/operations/${requestID}`;
const rebuildPath = "/api/admin/agents/agent-1/rebuild";
const recovery = {
  barrier_id: "barrier-\u0000-original-🧪",
  reason: "runtime_barrier_required",
  runtime_revision: "runtime-1",
  policy_revision: 0,
  mode: "manual",
  cooldown_ms: 300000,
  rebuild_request_id: requestID,
  notification_id: "notification_original",
  cooldown_until: null,
};
const runtime = {
  image_ref: `sha256:${"a".repeat(64)}`,
  resources: {
    memory_bytes: 536870912,
    pids_limit: 128,
    tmpfs_bytes: 104857600,
  },
};
const configuredAgent = {
  agent_id: "agent-1",
  owner_user_id: "user-1",
  name: "Support Agent",
  desired_state: "enabled",
  lifecycle_state: "created",
  activation_state: "enabled",
  runtime_state: "available",
  aggregate_sequence: 2,
  agent_spec_revision: "spec-1",
  runtime: { runtime_revision: "runtime-1" },
  executable_execution_revision: "execution-1",
  runtime_recovery: recovery,
  configuration: {
    template: {
      template_id: "template-1",
      revision: 1,
      name: "Configured template",
    },
    model_profile: {
      model_profile_id: "model-1",
      revision_id: "model-rev-1",
      revision: 1,
      name: "Configured model",
      model: {
        model: "support",
        context_window: 8192,
        max_output_tokens: 1024,
      },
    },
    max_model_requests: 32,
    context_policy_version: "context-v1",
    runtime,
  },
  created_at: timestamp,
  updated_at: timestamp,
};
const latestTemplate = {
  template_id: "template-1",
  name: "Latest template",
  revision: 3,
  enabled: true,
  model_profile_id: "model-1",
  system_prompt: "",
  max_model_requests: 32,
  context_policy_version: "context-v1",
  skill_refs: [],
  runtime,
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
    display_name: "Support owner",
    role: "member",
    source: "local",
    active: true,
    created_at: timestamp,
    updated_at: timestamp,
  },
};
const originalInput = {
  template_id: "template-1",
  template_revision: 1,
  recovery: {
    barrier_id: recovery.barrier_id,
    expected_runtime_revision: recovery.runtime_revision,
  },
};

export async function exerciseRuntimeRecovery(
  browser,
  origin,
  viewport,
  label,
  output,
) {
  const context = await browser.newContext({ viewport });
  const errors = [];
  const unexpected = [];
  const requests = [];
  const writes = [];
  const operationReads = [];
  let savedOperation = null;
  try {
    await prepareConsoleSession(context, origin);
    // This controlled EventSource stays open until its page owner closes it.
    // A finite native SSE response would instead trigger unrelated reconnects.
    await context.addInitScript(() => {
      const streams = [];
      window.__runtimeRecoveryStreams = streams;
      window.EventSource = class extends EventTarget {
        constructor(url) {
          super();
          this.url = new URL(url, window.location.href).href;
          this.readyState = 0;
          this.onopen = null;
          this.onerror = null;
          this.onmessage = null;
          this.record = { url: this.url, opened: false, closed: false };
          streams.push(this.record);
          queueMicrotask(() => {
            if (this.record.closed) return;
            this.readyState = 1;
            this.record.opened = true;
            const event = new Event("open");
            this.dispatchEvent(event);
            this.onopen?.(event);
          });
        }
        close() {
          this.readyState = 2;
          this.record.closed = true;
        }
      };
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push("External request");
        await route.abort();
        return;
      }
      try {
        if (await fulfillConsoleActivity(route)) return;
        if (!url.pathname.startsWith("/api/")) {
          await route.continue();
          return;
        }
        const method = request.method();
        requests.push({ method, path: url.pathname });
        const respond = (json, status = 200) =>
          route.fulfill({
            status,
            json,
            headers: { "cache-control": "no-store" },
          });
        if (method !== "GET") {
          const headers = request.headers();
          writes.push({
            path: url.pathname,
            body: request.postData(),
            key: headers["idempotency-key"],
            csrf: headers["x-antnest-csrf-token"],
            contentType: headers["content-type"],
          });
        }
        if (method === "POST" && url.pathname === rebuildPath) {
          const write = writes.at(-1);
          assert.equal(
            url.search,
            "",
            "Recovery must use the existing Rebuild route",
          );
          assert.equal(
            write.key,
            requestID,
            "The projected request ID must be forwarded unchanged",
          );
          assert.equal(
            write.csrf,
            "synthetic-console-session",
            "Recovery requires the browser CSRF token",
          );
          assert.equal(write.contentType, "application/json");
          assert.ok(
            isDeepStrictEqual(request.postDataJSON(), originalInput),
            "Recovery must preserve the original configured Template and opaque barrier",
          );
          assert.ok(
            writes.length <= 2,
            "Recovery must not automatically resubmit",
          );
          if (writes.length === 1) {
            // No receipt is persisted: the browser must resolve this unknown
            // response and obtain another authoritative 404 before retrying.
            await route.abort("failed");
            return;
          }
          savedOperation = {
            request_id: requestID,
            agent_id: "agent-1",
            kind: "rebuild",
            state: "running",
            phase: "drain",
            created_at: timestamp,
            updated_at: timestamp,
          };
          await respond(savedOperation, 202);
          return;
        }
        if (
          method === "GET" &&
          url.pathname.startsWith("/api/admin/operations/")
        ) {
          operationReads.push({ path: url.pathname, search: url.search });
          assert.equal(
            url.pathname,
            operationPath,
            "Every recovery read must query the original operation",
          );
          assert.equal(url.search, "");
          await respond(
            savedOperation ?? {
              code: "operation_not_found",
              message: "Recovery operation was not found",
            },
            savedOperation === null ? 404 : 200,
          );
          return;
        }
        const agent =
          savedOperation === null
            ? configuredAgent
            : {
                ...configuredAgent,
                aggregate_sequence: 3,
                active_operation_request_id: requestID,
              };
        const directory = { users: [member], groups: [] };
        const fixtures = {
          "/api/session": {
            ...consoleSessionMetadata,
            principal: {
              organization_slug: "test",
              organization_name: "Test organization",
              user_id: "admin-test",
              organization_id: "org-test",
              membership_id: "member-test",
              system_role: "admin",
              organization_role: "admin",
              active: true,
            },
          },
          "/api/session/account": {
            account: {
              user_id: "admin-test",
              organization_id: "org-test",
              membership_id: "member-test",
              email: "admin@example.test",
              display_name: "Test administrator",
              source: "local",
              local_password_available: true,
            },
          },
          "/api/admin/execution-synchronization": { synchronization: null },
          "/api/admin/overview": {
            directory: { status: "available", data: directory },
            model_profiles: { status: "available", data: { items: [] } },
            templates: {
              status: "available",
              data: { items: [latestTemplate] },
            },
            agents: { status: "available", data: { items: [agent] } },
            defaults: { runtime_image_ref: runtime.image_ref },
          },
          "/api/admin/agents/agent-1": agent,
          "/api/admin/agents/agent-1/events": { events: [], next_sequence: 0 },
          "/api/admin/agents/agent-1/network-policy": {
            agent_id: "agent-1",
            action: "deny_all",
            resource_version: 7,
            attachment: { state: "open", resource_version: 4 },
          },
          "/api/admin/templates": {
            items: [latestTemplate],
            next_after_id: null,
          },
          "/api/admin/directory": directory,
        };
        if (method !== "GET" || !Object.hasOwn(fixtures, url.pathname)) {
          throw new Error("Unmatched recovery fixture API");
        }
        await respond(fixtures[url.pathname]);
      } catch {
        unexpected.push(`${request.method()} ${url.pathname}`);
        await route.fulfill({
          status: 503,
          json: {
            code: "unexpected_fixture_request",
            message: "Unexpected synthetic request",
          },
        });
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#agents/agent-1`);
    await page
      .getByRole("heading", { name: "Runtime recovery required", exact: true })
      .waitFor();
    await page.getByText("live", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Recover Runtime", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Recover Runtime",
      exact: true,
    });
    await dialog
      .getByText("Configured template · revision 1", { exact: true })
      .waitFor();
    assert.equal(writes.length, 0);
    await dialog
      .getByRole("button", { name: "Confirm recovery", exact: true })
      .click();
    const check = dialog.getByRole("button", {
      name: "Check recovery request",
      exact: true,
    });
    await check.waitFor();
    assert.equal(writes.length, 1);
    assert.equal(savedOperation, null);
    assert.equal(operationReads.length, 1);
    assert.deepEqual(
      requests.filter(
        (request) => request.path === operationPath || request.method !== "GET",
      ),
      [
        { method: "GET", path: operationPath },
        { method: "POST", path: rebuildPath },
      ],
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Retry same recovery", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Confirm recovery", exact: true })
        .count(),
      0,
    );
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-runtime-recovery-unknown.png`),
      fullPage: true,
    });

    const beforeCheck = requests.length;
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === operationPath &&
          response.request().method() === "GET" &&
          response.status() === 404,
      ),
      check.click(),
    ]);
    const retry = dialog.getByRole("button", {
      name: "Retry same recovery",
      exact: true,
    });
    await retry.waitFor();
    assert.equal(
      writes.length,
      1,
      "Checking a recovery request must remain read-only",
    );
    assert.equal(savedOperation, null);
    assert.deepEqual(requests.slice(beforeCheck), [
      { method: "GET", path: operationPath },
    ]);
    assert.equal(operationReads.length, 2);

    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === rebuildPath &&
          response.request().method() === "POST" &&
          response.status() === 202,
      ),
      retry.click(),
    ]);
    const currentOperation = page.getByRole("heading", {
      name: "Current operation",
      exact: true,
    });
    await currentOperation.waitFor();
    await currentOperation
      .locator("xpath=ancestor::section[1]")
      .getByText("running", { exact: true })
      .waitFor();
    assert.equal(await dialog.count(), 0);
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes[1],
      writes[0],
      "An explicit retry must keep the original body, ID and CSRF token",
    );
    assert.ok(operationReads.length >= 3);
    assert.ok(
      operationReads.every(
        (read) => read.path === operationPath && read.search === "",
      ),
    );
    assert.equal(savedOperation.request_id, requestID);
    await assertNoOverflow(page);
    await page.screenshot({
      path: resolve(output, `${label}-runtime-recovery-running.png`),
      fullPage: true,
    });
    const streams = await page.evaluate(() => window.__runtimeRecoveryStreams);
    assert.ok(streams.some((stream) => stream.opened));
    assert.ok(
      streams.every((stream) => {
        const url = new URL(stream.url);
        return (
          url.origin === origin &&
          url.pathname === "/api/admin/agents/agent-1/events/watch" &&
          url.search === "?after_sequence=0"
        );
      }),
    );
    assert.equal(writes.length, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    return {
      scope:
        "Controlled Console HTTP/SSE browser fixture, not actual Runtime E2E",
      viewport: label,
      writes: writes.length,
      operationQueries: operationReads.length,
      configuredTemplateRevision: 1,
      catalogTemplateRevision: 3,
      browserErrors: errors.length,
      overflow: false,
    };
  } finally {
    await context.close();
  }
}
