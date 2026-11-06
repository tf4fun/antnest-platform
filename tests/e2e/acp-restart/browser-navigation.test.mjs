import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { runC4BrowserScope } from "../workspace-closeout/c4-browser-scope.mjs";
import { openRecoveryWorkspace } from "./browser-navigation.mjs";

for (const { label, role, initialPath, redirectPending } of [
  {
    label: "member recovery joins the login redirect",
    role: "member",
    initialPath: "/login",
    redirectPending: true,
  },
  {
    label: "member recovery accepts an already completed login redirect",
    role: "member",
    initialPath: "/workspace/",
    redirectPending: false,
  },
  {
    label: "administrator recovery opens the session without a member redirect",
    role: "admin",
    initialPath: "/login",
    redirectPending: false,
  },
])
  test(
    `${label} before opening the original session`,
    { timeout: 20000 },
    async () => {
      const target = "/workspace/agent_original/sessions/session_original";
      const redirected = Promise.withResolvers();
      if (role === "admin") redirected.resolve();
      const calls = [];
      const server = createServer((request, response) => {
        calls.push(request.url);
        response.setHeader("content-type", "text/html");
        if (request.url === target) {
          // Hold the session document while the old login renderer is still able
          // to navigate. The real member login uses location.replace as well.
          void redirected.promise.then(() =>
            response.end("<p>Original session</p>"),
          );
        } else if (request.url === "/workspace/") {
          response.end("<p>Workspace chooser</p>");
          redirected.resolve();
        } else {
          response.end("<p>Login accepted</p>");
        }
      });
      const abort = new AbortController();
      const interrupt = () =>
        abort.abort(new Error("browser regression interrupted"));
      for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const gateway = `http://127.0.0.1:${server.address().port}`;
        await runC4BrowserScope(
          {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
            launch: () =>
              chromium.launch({
                headless: true,
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false,
              }),
          },
          async (scope) => {
            const page = await scope.context.newPage();
            await page.goto(gateway + initialPath);
            if (redirectPending)
              await page.evaluate(() =>
                window.setTimeout(
                  () => window.location.replace("/workspace/"),
                  250,
                ),
              );
            const opened = openRecoveryWorkspace(page, {
              gateway,
              workspace: target,
              role,
            });
            await opened;
            assert.equal(page.url(), gateway + target);
            await page.getByText("Original session", { exact: true }).waitFor();
            assert.equal(calls.filter((path) => path === target).length, 1);
            assert.equal(
              calls.filter((path) => path === "/workspace/").length,
              role === "member" ? 1 : 0,
            );
            if (role === "member")
              assert(
                calls.indexOf("/workspace/") < calls.indexOf(target),
                "the login redirect must precede the session request",
              );
          },
        );
      } finally {
        abort.abort();
        redirected.resolve();
        for (const event of ["SIGINT", "SIGTERM"])
          process.removeListener(event, interrupt);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
