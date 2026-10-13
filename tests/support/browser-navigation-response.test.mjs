import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { captureNavigationResponse } from "./browser-navigation-response.mjs";

test(
  "login wire response survives cross-process navigation without replay",
  { timeout: 30_000 },
  async () => {
    const payload = {
      principal: { user_id: "original-login-user", system_role: "admin" },
      marker: "the original login response, never a subsequent session read",
    };
    const calls = [];
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === "/api/session/login") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Strict-Transport-Security": "max-age=31536000",
          "Cache-Control": "no-store",
          "X-Antnest-Trace-Id": "1234567890abcdef1234567890abcdef",
          "Set-Cookie": [
            "session=fixture; HttpOnly; Path=/",
            "csrf=fixture; Path=/",
          ],
        });
        res.end(JSON.stringify(payload));
      } else if (req.url === "/destination") {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Cross-Origin-Opener-Policy": "same-origin",
        });
        res.end("<!doctype html><title>After login</title><p>Signed in</p>");
      } else {
        const destination = `http://localhost:${server.address().port}/destination`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html><button>Sign in</button><script>
        document.querySelector('button').onclick = async () => {
          const response = await fetch('/api/session/login', { method: 'POST' });
          await response.json();
          location.replace(${JSON.stringify(destination)});
        };
      </script>`);
      }
    });
    let browser,
      interrupted = false;
    const interrupt = () => {
      interrupted = true;
      void browser?.close();
      server.closeAllConnections();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
          "--site-per-process",
          "--host-resolver-rules=MAP localhost 127.0.0.1",
        ],
      });
      assert(!interrupted, "browser regression interrupted");
      const page = await browser.newPage();
      await page.goto(origin);
      const result = await captureNavigationResponse(
        page,
        { url: `${origin}/api/session/login` },
        async () => {
          await page.getByRole("button", { name: "Sign in" }).click();
          // Deliberately inspect only after the original renderer is replaced.
          await page.waitForURL(
            `http://localhost:${server.address().port}/destination`,
          );
          await page.getByText("Signed in", { exact: true }).waitFor();
        },
      );
      assert.deepEqual(JSON.parse(result.body.toString("utf8")), payload);
      assert.equal(result.response.status(), 200);
      assert.equal(
        await result.response.headerValue("strict-transport-security"),
        "max-age=31536000",
      );
      assert.equal(
        (await result.response.headerValues("set-cookie")).length,
        2,
      );
      assert.equal(
        calls.filter((value) => value === "POST /api/session/login").length,
        1,
      );
      assert(!calls.some((value) => value === "GET /api/session"));
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test(
  "wire capture rejects ambiguous, failed and incomplete requests and retires failed pages",
  { timeout: 30_000 },
  async (t) => {
    const calls = [];
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === "/abort") {
        // Deliver headers and a partial body before closing. Closing a reused
        // connection before any response bytes lets Chromium retry internally.
        res.writeHead(200, { "Content-Length": "1000" });
        res.write("{", () => res.destroy());
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/after" });
        res.end();
      } else if (req.url === "/large") {
        res.end("x".repeat(1024 * 1024 + 1));
      } else if (req.url === "/login") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ method: req.method }));
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><title>Capture failures</title>");
      }
    });
    let browser,
      interrupted = false;
    const interrupt = () => {
      interrupted = true;
      void browser?.close();
      server.closeAllConnections();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      assert(!interrupted, "browser regression interrupted");
      for (const [name, path, action, expected, timeout] of [
        [
          "deadline",
          "/never",
          async () => {},
          /capture deadline exceeded/,
          150,
        ],
        [
          "transport failure",
          "/abort",
          (page) =>
            page.evaluate(() =>
              fetch("/abort", { method: "POST" }).catch(() => {}),
            ),
          /capture request failed/,
        ],
        [
          "page closed",
          "/never",
          (page) => page.close(),
          /capture (page|session) closed/,
        ],
        [
          "duplicate",
          "/login",
          (page) =>
            page.evaluate(() =>
              Promise.all([
                fetch("/login", { method: "POST" }),
                fetch("/login", { method: "POST" }),
              ]),
            ),
          /more than one matching request|duplicate responses/,
        ],
        [
          "redirect",
          "/redirect",
          (page) => page.evaluate(() => fetch("/redirect", { method: "POST" })),
          /refuses redirects/,
        ],
        [
          "oversized body",
          "/large",
          (page) =>
            page.evaluate(() =>
              fetch("/large", { method: "POST" }).then((r) => r.arrayBuffer()),
            ),
          /body exceeds limit|evicted from inspector cache/,
        ],
      ]) {
        await t.test(name, async () => {
          const page = await browser.newPage();
          await page.goto(origin);
          const responseListeners = page.listenerCount("response"),
            closeListeners = page.listenerCount("close");
          await assert.rejects(
            captureNavigationResponse(
              page,
              { url: origin + path, timeout },
              () => action(page),
            ),
            expected,
          );
          assert(page.isClosed(), "failed capture must retire its owned page");
          // Playwright also removes its own once(close) listener on closure.
          assert(page.listenerCount("response") <= responseListeners);
          assert(page.listenerCount("close") <= closeListeners);
        });
      }
      await t.test(
        "same URL with another method cannot supply the captured body",
        async () => {
          const page = await browser.newPage();
          await page.goto(origin);
          const responseListeners = page.listenerCount("response");
          const result = await captureNavigationResponse(
            page,
            { url: origin + "/login" },
            () =>
              page.evaluate(async () => {
                await fetch("/login");
                await fetch("/login", { method: "POST" });
              }),
          );
          assert.deepEqual(JSON.parse(result.body.toString("utf8")), {
            method: "POST",
          });
          assert.equal(page.listenerCount("response"), responseListeners);
          await page.close();
        },
      );
      assert.equal(
        calls.filter((value) => value === "POST /abort").length,
        1,
        "failed request must not be replayed",
      );
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
