import { once } from "node:events";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadWorkspaceDocument } from "../../../services/agent-ui/web/server/dist/ssr-assets.js";
import { createTestWorkspaceHttpServer, testHeaders } from "./auth-fixture.mjs";
import { verifyExternalIdentitiesBrowser } from "../../support/agent-ui/external-identities-browser.mjs";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import {
  installRevocationObserver,
  readRevocationObservation,
  assertRevocationStoppedRequests,
  assertOnlyPendingActivity,
} from "../../support/agent-ui/revocation-observer.mjs";

test(
  "revocation observation distinguishes pending activity and catches private dispatch after consumption across navigation",
  { timeout: 30_000 },
  async (testContext) => {
    const browser = await chromium.launch({ headless: true });
    const stop = () => {
      void browser.close().catch(() => {});
    };
    testContext.signal.addEventListener("abort", stop, { once: true });
    try {
      testContext.signal.throwIfAborted();
      const context = await browser.newContext();
      const privateRequests = [];
      await installRevocationObserver(
        context,
        "/api/session/external-identities/current",
      );
      await context.route("http://revocation.test/**", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (
          pathname.startsWith("/api/") &&
          pathname !== "/api/session/external-identities/current"
        )
          privateRequests.push(route.request());
        if (pathname.startsWith("/api/"))
          return route.fulfill({
            json: { revoked_count: 1, current_revoked: true },
          });
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Observer probe</title>",
        });
      });
      const page = await context.newPage();
      await page.goto("http://revocation.test/");
      await page.evaluate(async () => {
        const result = await (
          await fetch("/api/session/external-identities/current", {
            method: "DELETE",
          })
        ).json();
        // A parsed body is not yet an observed revocation.
        await fetch("/api/session/activity", { method: "POST" });
        if (result.current_revoked !== true || result.current_revoked !== true)
          throw new Error("Observer changed the result");
      });
      const firstSnapshot = await readRevocationObservation(page);
      assertRevocationStoppedRequests(firstSnapshot);
      assert.equal(privateRequests.length, 1);
      const pendingActivity = privateRequests[0];
      assertOnlyPendingActivity(privateRequests, pendingActivity);
      await page.evaluate(async () => {
        // Deliberate violations: the observer must reject every private route,
        // including activity, rather than exempting the CI failure's path.
        for (const [path, method] of [
          ["/api/session/activity", "POST"],
          ["/api/session", "GET"],
          ["/api/session/external-identities", "GET"],
          ["/api/session", "DELETE"],
          ["/api/app/workspace/v1/bootstrap", "GET"],
        ])
          await fetch(path, { method });
      });
      await page.goto("http://revocation.test/");
      const events = await readRevocationObservation(page);
      await context.close();
      const observed = events.find(
        (event) => event.type === "current_revocation_observed",
      );
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "request" && event.sequence > observed.sequence,
          )
          .map(({ method, path }) => ({ method, path })),
        [
          { method: "POST", path: "/api/session/activity" },
          { method: "GET", path: "/api/session" },
          { method: "GET", path: "/api/session/external-identities" },
          { method: "DELETE", path: "/api/session" },
          { method: "GET", path: "/api/app/workspace/v1/bootstrap" },
        ],
      );
      assert.throws(
        () => assertRevocationStoppedRequests(events),
        /cannot send another private request/,
      );
      assert.throws(
        () => assertOnlyPendingActivity(privateRequests, pendingActivity),
        /beyond the proven pending activity/,
      );
      // An earlier clean snapshot alone would miss these later requests.
      assertRevocationStoppedRequests(firstSnapshot);
    } finally {
      testContext.signal.removeEventListener("abort", stop);
      await browser.close();
    }
  },
);

test(
  "Workspace external identities and notices use the validated shell on desktop and mobile",
  { timeout: 90_000 },
  async (context) => {
    const server = createTestWorkspaceHttpServer(
      {
        async handle(request) {
          if (
            new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap"
          )
            return null;
          return Response.json({
            principal: {
              userId: "user-1",
              organizationId: "org-1",
              organizationSlug: "engineering",
              organizationName: "Engineering",
              administrator: false,
            },
            agents: [],
            renderedAt: new Date().toISOString(),
            bridgeEpoch: "external-identities-epoch",
          });
        },
      },
      await loadWorkspaceDocument(),
    );
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      await verifyExternalIdentitiesBrowser({
        base: `http://127.0.0.1:${server.address().port}`,
        signal: context.signal,
        headersForRequest: testHeaders,
        output: fileURLToPath(
          new URL(
            "../../../artifacts/verification/issue-61/agent-ui-browser/external/",
            import.meta.url,
          ),
        ),
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
