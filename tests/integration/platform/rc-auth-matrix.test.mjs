import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const contract = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../contracts/runtime-controller/control-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const routes = contract.routes.filter((route) => route.path !== "/status");

if (process.argv.includes("--probe-fixture")) {
  // Run the actual CLI probe in a disposable process with no network access.
  // Native Request still enforces GET/HEAD body rules before a reply is mocked.
  const keys = {
    current: "fixture-current-only",
    next: "fixture-next-only",
    wrong: "fixture-wrong-only",
  };
  const readFile = fs.readFileSync;
  fs.readFileSync = (path, ...args) => {
    if (path === "/fixture/control-contract.json")
      return JSON.stringify(contract);
    if (path === "/run/auth/fixture.json") return JSON.stringify(keys);
    return readFile(path, ...args);
  };
  let requests = 0,
    duplicates = 0,
    schemaBodies = 0;
  const bodyRoutes = routes.filter((route) => route.request_body !== "none");
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.hostname, "runtime-controller");
    assert.equal(
      request.headers.get("x-antnest-principal-id"),
      requests < routes.length * 2 ? "pretend-controller" : null,
    );
    const token = request.headers.get("antnest-service-authorization");
    let status;
    if (url.pathname === "/status") status = 404;
    else if (token === null) status = 401;
    else if (token === `Bearer ${keys.wrong}`) status = 403;
    else if (
      request.method === "POST" &&
      !["application/json"].includes(init.headers["Content-Type"])
    )
      status = 415;
    else status = 200;
    if (requests < routes.length * 2 && request.method === "POST") {
      assert.deepEqual(JSON.parse(await request.text()), {});
      schemaBodies++;
    }
    requests++;
    const code =
      status === 401
        ? "service_unauthenticated"
        : status === 403
          ? "caller_not_allowed"
          : "unsupported_media_type";
    return new Response(JSON.stringify({ code }), {
      status,
      headers:
        status === 401
          ? { "WWW-Authenticate": 'Bearer realm="antnest-service"' }
          : {},
    });
  };
  http.request = (url, options, callback) => {
    assert.equal(new URL(url).hostname, "runtime-controller");
    const names = options.headers.filter((_, index) => index % 2 === 0);
    assert.equal(
      names.filter((name) => name === "Antnest-Service-Authorization").length,
      2,
    );
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = (body) => {
      new Request(url, { method: options.method, body });
      if (options.method === "POST") {
        assert.equal(body, "{}");
      } else {
        assert.equal(body, undefined);
      }
      duplicates++;
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 401;
        response.resume = () => {};
        callback(response);
        queueMicrotask(() => response.emit("end"));
      });
    };
    return req;
  };
  syncBuiltinESMExports();
  process.argv = [process.execPath, "probe.mjs", "matrix"];
  await import("../../e2e/service-authentication/runtime-controller/probe.mjs");
  assert.equal(requests, routes.length * 2 + 6);
  assert.equal(duplicates, routes.length);
  assert.equal(schemaBodies, bodyRoutes.length * 2);
} else {
  test("actual RC authentication probe covers every published route without attaching bodies to GET/HEAD", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--probe-fixture"],
      {
        encoding: "utf8",
        timeout: 10000,
        env,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).checks, routes.length * 3 + 6);
  });
}
