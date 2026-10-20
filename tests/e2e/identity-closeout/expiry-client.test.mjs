import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("./expiry-client.mjs", import.meta.url));
const principal = { user_id: "expiry-user", organization_id: "expiry-org" };
const cookie = "antnest_session=expiry-session; antnest_csrf=expiry-csrf";
const protectedPaths = [
  "/api/session",
  "/api/admin/account",
  "/api/app/workspace/v1/bootstrap",
];

async function fixture(t, override = {}) {
  const directory = await mkdtemp(join(tmpdir(), "antnest-expiry-client-"));
  const state = join(directory, "state.json");
  const requests = [];
  const children = [];
  const warm = new Set();
  let observePending;
  const pending = new Promise((resolve) => {
    observePending = resolve;
  });
  let stopped = false;
  const server = createServer((request, response) => {
    request.resume();
    requests.push({
      path: request.url,
      method: request.method,
      cookie: request.headers.cookie,
      stopped,
    });
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.url === "/api/session/login" && !stopped) {
      response.setHeader("set-cookie", [
        "antnest_session=expiry-session; Path=/; HttpOnly",
        "antnest_csrf=expiry-csrf; Path=/",
      ]);
      response.end(JSON.stringify({ principal }));
    } else if (protectedPaths.includes(request.url) && !stopped) {
      warm.add(request.url);
      response.end(JSON.stringify({ principal }));
    } else if (protectedPaths.includes(request.url) && stopped) {
      if (override.hold) {
        observePending();
        return;
      }
      response.statusCode = override.status ?? 503;
      response.setHeader("cache-control", override.cacheControl ?? "no-store");
      if (override.setCookie)
        response.setHeader("set-cookie", override.setCookie);
      response.end(
        JSON.stringify({
          code:
            override.code ??
            (request.url === "/api/admin/account" && warm.has(request.url)
              ? "dependency_unavailable"
              : "identity_unavailable"),
        }),
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  t.after(async () => {
    for (const record of children)
      if (!record.closed) record.child.kill("SIGTERM");
    const escalation = setTimeout(() => {
      for (const record of children)
        if (!record.closed) record.child.kill("SIGKILL");
    }, 1000);
    try {
      await Promise.all(children.map((record) => record.joined));
    } finally {
      clearTimeout(escalation);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const run = (phase, { signal = t.signal } = {}) => {
    let child;
    const result = new Promise((resolve) => {
      child = execFile(
        process.execPath,
        [client, gateway, "http://127.0.0.1:1", phase, state],
        { timeout: 10000, signal, maxBuffer: 1024 * 1024 },
        (error) => resolve({ code: error ? (error.code ?? "terminated") : 0 }),
      );
    });
    const record = { child, closed: false };
    record.joined = new Promise((resolve) => {
      child.once("close", () => {
        record.closed = true;
        resolve();
      });
    });
    children.push(record);
    return Promise.all([result, record.joined]).then(([value]) => value);
  };
  return {
    requests,
    children,
    pending,
    run,
    stop: () => {
      stopped = true;
    },
    saved: async () => JSON.parse(await readFile(state, "utf8")),
  };
}

test("outage CLI keeps the newly issued session cold until Identity stops", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("prepare")).code, 0);
  assert.deepEqual(await f.saved(), { cookie, principal });
  f.stop();
  assert.equal(
    (await f.run("unavailable")).code,
    0,
    "each cold scope must fail at Gateway instead of forwarding to Console",
  );
  assert.deepEqual(
    f.requests.filter((request) => !request.stopped).map(({ path }) => path),
    ["/api/session/login"],
  );
  assert.deepEqual(
    f.requests.filter((request) => request.stopped),
    protectedPaths.map((path) => ({
      path,
      method: "GET",
      cookie,
      stopped: true,
    })),
  );
});

test("cancelled outage CLI is joined before its result completes", async (t) => {
  const f = await fixture(t, { hold: true });
  assert.equal((await f.run("prepare")).code, 0);
  f.stop();
  const controller = new AbortController();
  const running = f.run("unavailable", { signal: controller.signal });
  await Promise.race([
    f.pending,
    running.then(() => assert.fail("CLI exited before the pending request")),
  ]);
  controller.abort();
  assert.equal((await running).code, "ABORT_ERR");
  assert(
    f.children.every((record) => record.closed),
    "the child close event must precede completion even after cancellation",
  );
  for (const { child } of f.children)
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

for (const [name, override] of [
  ["successful access", { status: 200 }],
  ["authentication rejection", { status: 401 }],
  ["retired route 404", { status: 404 }],
  [
    "Console dependency failure on a cold scope",
    { code: "dependency_unavailable" },
  ],
  ["unknown failure", { code: "unrelated_failure" }],
  ["cacheable response", { cacheControl: "public" }],
  ["cookie invalidation", { setCookie: "antnest_session=; Max-Age=0; Path=/" }],
])
  test(`cold outage CLI rejects ${name}`, async (t) => {
    const f = await fixture(t, override);
    assert.equal((await f.run("prepare")).code, 0);
    f.stop();
    assert.equal((await f.run("unavailable")).code, 1);
    assert.deepEqual(
      f.requests.filter((request) => request.stopped),
      [{ path: "/api/session", method: "GET", cookie, stopped: true }],
    );
  });
