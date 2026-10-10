import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { gatewayBrowserRequest } from "./gateway-browser-request.mjs";

test(
  "API probes retain Chromium's loopback Secure cookie session and CSRF boundary",
  { timeout: 30000 },
  async (t) => {
    const requests = [];
    const server = createServer((request, response) => {
      if (request.url === "/login") {
        response.setHeader("Set-Cookie", [
          "antnest_session=test-session; Path=/; Secure; HttpOnly; SameSite=Lax",
          "antnest_csrf=test-csrf; Path=/; Secure; SameSite=Lax",
        ]);
      } else if (request.url === "/probe") {
        requests.push({
          cookie: request.headers.cookie,
          csrf: request.headers["x-antnest-csrf-token"],
        });
        if (!request.headers.cookie?.includes("antnest_session=test-session"))
          response.statusCode = 401;
        else if (
          request.method === "POST" &&
          request.headers["x-antnest-csrf-token"] !== "test-csrf"
        )
          response.statusCode = 403;
      } else if (request.url === "/redirect") {
        response.statusCode = 302;
        response.setHeader("Location", "/must-not-follow");
      } else if (request.url === "/must-not-follow") {
        requests.push({ redirected: true });
      }
      response.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const login = await context.request.post(`${origin}/login`);
    assert.equal(login.status(), 200);
    assert((await context.cookies()).every((cookie) => cookie.secure));
    const page = await context.newPage();
    await page.goto(origin);
    assert.equal(
      await page.evaluate(async () => (await fetch("/probe")).status),
      200,
    );
    assert.equal(
      (await context.request.get(`${origin}/probe`)).status(),
      401,
      "the unadapted API probe reproduces the lost session",
    );
    await context.addCookies([
      {
        name: "other_host",
        value: "excluded",
        url: "https://unrelated.example",
      },
      {
        name: "other_path",
        value: "excluded",
        domain: "127.0.0.1",
        path: "/private",
        secure: true,
      },
    ]);
    const response = await gatewayBrowserRequest(context, `${origin}/probe`, {
      method: "POST",
    });
    assert.equal(response.status(), 200);
    assert.equal(requests.at(-1).csrf, "test-csrf");
    assert.doesNotMatch(requests.at(-1).cookie, /other_host|other_path/);
    assert(
      (await context.cookies())
        .filter((cookie) => cookie.name.startsWith("antnest_"))
        .every((cookie) => cookie.secure),
    );
    assert.equal(
      (
        await gatewayBrowserRequest(context, `${origin}/probe`, {
          headers: { Cookie: "" },
        })
      ).status(),
      401,
    );
    assert.equal(
      (
        await gatewayBrowserRequest(context, `${origin}/probe`, {
          method: "POST",
          headers: { "X-Antnest-CSRF-Token": "wrong" },
        })
      ).status(),
      403,
    );
    assert.equal(
      (await gatewayBrowserRequest(context, `${origin}/redirect`)).status(),
      302,
    );
    assert.equal(
      requests.some((request) => request.redirected),
      false,
    );
  },
);

test("cookie selection promotes only literal loopback HTTP and never follows redirects", async () => {
  for (const [target, cookieURL] of [
    ["http://127.0.0.1:8123/api/read", "https://127.0.0.1:8123/api/read"],
    ["http://127.24.0.1/api/read", "https://127.24.0.1/api/read"],
    ["http://[::1]:8123/api/read", "https://[::1]:8123/api/read"],
    ["https://gateway.example/api/read", "https://gateway.example/api/read"],
    ["http://gateway.example/api/read", "http://gateway.example/api/read"],
    ["http://192.168.1.2/api/read", "http://192.168.1.2/api/read"],
    ["http://127.0.0.1.example/api/read", "http://127.0.0.1.example/api/read"],
  ]) {
    const context = {
      async cookies(url) {
        assert.equal(url, cookieURL);
        return [];
      },
      request: {
        async fetch(url, options) {
          assert.equal(url, target);
          assert.equal(options.maxRedirects, 0);
          assert.equal(options.headers.origin, "https://explicit.example");
          assert.equal(options.headers.cookie, "");
          return "response";
        },
      },
    };
    assert.equal(
      await gatewayBrowserRequest(context, target, {
        maxRedirects: 5,
        headers: { Origin: "https://explicit.example" },
      }),
      "response",
    );
  }
});
