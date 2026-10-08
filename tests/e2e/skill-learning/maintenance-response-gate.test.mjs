import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(
  new URL("./maintenance-response-gate.mjs", import.meta.url),
);
const withGate = (args, mode = "response") =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${gate}`,
      ANTNEST_E2E_INSTALL_GATE: mode,
    },
  });

// ACP sends Runtime requests through RuntimeConnections.fetchFor, which uses
// undici directly. This stand-in has the same shape and never touches the
// global fetch, so only a gate on the real transport can observe it. Like
// undici, it rejects once the caller's signal aborts, and it counts the
// requests that actually reached it. A "?wait" request stays in flight until
// its caller aborts, like an install the Runtime holds after its rename.
const runtimeTransport = `export const dispatched = [];
export class RuntimeConnections {
  fetchFor() {
    return async (input, init) => {
      init?.signal?.throwIfAborted();
      const url = new URL(String(input));
      const path = url.pathname;
      dispatched.push(path);
      if (url.search === "?wait")
        await new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason), {
            once: true,
          }),
        );
      return new Response(JSON.stringify({ path, attempt: dispatched.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }
}
`;

const prelude = `import { setTimeout as delay } from "node:timers/promises";
import { RuntimeConnections, dispatched } from "./adapters/runtime-connections.js";
const control = async (path, method = "GET") =>
  (await fetch("http://127.0.0.1:18093/" + path, { method })).json();
const send = new RuntimeConnections().fetchFor({});
const install = (signal = new AbortController().signal, search = "") =>
  send("http://runtime.test:8093/internal/skill-maintenance/install" + search, {
    method: "POST",
    signal,
  });
const until = async (check) => {
  for (let i = 0; i < 40; i++) {
    if (await check()) return true;
    await delay(25);
  }
  return false;
};
const fail = (code, detail) => {
  console.error(JSON.stringify(detail));
  process.exit(code);
};
`;

function serviceEntry(t, source, { transport = runtimeTransport } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "maintenance-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist", "adapters"), { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  if (transport !== null)
    writeFileSync(
      join(directory, "dist", "adapters", "runtime-connections.js"),
      transport,
    );
  const main = join(directory, "dist", "main.js");
  writeFileSync(main, `${source}\nprocess.exit(0);\n`);
  return main;
}

function passes(result) {
  assert.equal(result.signal, null, "entry process did not exit");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

// install-gate.compose.yaml sets NODE_OPTIONS for the whole ACP container, so
// its `node -e` healthcheck loads the gate while ACP already holds the port.
test("gate stays out of node -e helpers such as the ACP healthcheck", () => {
  passes(
    withGate(["-e", "process.exit(globalThis.fetch.name === 'fetch' ? 0 : 3)"]),
  );
});

test("gate installs in the ACP service entry point", (t) => {
  const main = serviceEntry(
    t,
    `${prelude}
     const status = await control("status");
     if (status.mode !== "response" || status.pending || status.installs !== 0)
       fail(3, status);`,
  );
  passes(withGate([main]));
});

test("response mode holds only the first real install receipt", (t) => {
  const main = serviceEntry(
    t,
    `${prelude}
     let settled = false;
     const first = install().finally(() => { settled = true; });
     if (!(await until(async () => (await control("status")).pending)))
       fail(3, await control("status"));
     if (settled || dispatched.length !== 1) fail(4, dispatched);
     const digest = await send(
       "http://runtime.test:8093/internal/skill-maintenance/digest",
       { method: "POST" },
     );
     if ((await digest.json()).path !== "/internal/skill-maintenance/digest")
       fail(5, "digest was gated");
     const released = await control("release", "POST");
     if (released.released !== true) fail(6, released);
     if ((await (await first).json()).attempt !== 1) fail(7, "first receipt");
     const resent = await install();
     if ((await resent.json()).attempt !== 3) fail(8, "resend was gated");
     const status = await control("status");
     if (status.pending || status.aborted || status.installs !== 2)
       fail(9, status);`,
  );
  passes(withGate([main]));
});

test("response mode rejects a held receipt when the caller aborts", (t) => {
  const main = serviceEntry(
    t,
    `${prelude}
     const caller = new AbortController();
     const first = install(caller.signal);
     if (!(await until(async () => (await control("status")).pending)))
       fail(3, await control("status"));
     caller.abort(new Error("lifecycle stopped learning"));
     const outcome = await first.then(() => "resolved", (error) => error.message);
     if (outcome !== "lifecycle stopped learning") fail(4, outcome);
     const status = await control("status");
     if (status.pending || !status.aborted) fail(5, status);
     const release = await fetch("http://127.0.0.1:18093/release", { method: "POST" });
     if (release.status !== 409) fail(6, release.status);`,
  );
  passes(withGate([main]));
});

test("response mode drops a held receipt after the Runtime handled it", (t) => {
  const main = serviceEntry(
    t,
    `${prelude}
     const first = install().then(() => "resolved", () => "rejected");
     if (!(await until(async () => (await control("status")).pending)))
       fail(3, await control("status"));
     const dropped = await control("drop", "POST");
     if (dropped.dropped !== true) fail(4, dropped);
     const outcome = await first;
     if (outcome !== "rejected" || dispatched.length !== 1) fail(5, outcome);
     if ((await (await install()).json()).attempt !== 2) fail(6, "resend");
     const status = await control("status");
     if (status.pending || status.aborted || status.installs !== 2)
       fail(7, status);`,
  );
  passes(withGate([main]));
});

test("dispatch mode holds the first install before the Runtime sees it", (t) => {
  const main = serviceEntry(
    t,
    `${prelude}
     const caller = new AbortController();
     const first = install(caller.signal);
     if (!(await until(async () => (await control("status")).pending)))
       fail(3, await control("status"));
     if (dispatched.length !== 0) fail(4, dispatched);
     const drop = await fetch("http://127.0.0.1:18093/drop", { method: "POST" });
     if (drop.status !== 409) fail(5, drop.status);
     caller.abort(new Error("foreground admitted"));
     const outcome = await first.then(() => "resolved", (error) => error.message);
     if (outcome !== "foreground admitted" || dispatched.length !== 0)
       fail(6, { outcome, dispatched });
     if ((await (await install()).json()).attempt !== 1) fail(7, "resend");
     const status = await control("status");
     if (status.pending || !status.aborted || status.installs !== 2)
       fail(8, status);`,
  );
  passes(withGate([main], "dispatch"));
});

test("dispatch mode release sends the held install", (t) => {
  const main = serviceEntry(
    t,
    `${prelude}
     const first = install();
     if (!(await until(async () => (await control("status")).pending)))
       fail(3, await control("status"));
     const released = await control("release", "POST");
     if (released.released !== true) fail(4, released);
     if ((await (await first).json()).attempt !== 1) fail(5, dispatched);`,
  );
  passes(withGate([main], "dispatch"));
});

test("observe mode forwards installs and records an in-flight abort", (t) => {
  const main = serviceEntry(
    t,
    `${prelude}
     const settled = new AbortController();
     const first = await install(settled.signal);
     if ((await first.json()).attempt !== 1) fail(3, dispatched);
     settled.abort(new Error("lease ended after the receipt"));
     let status = await control("status");
     if (status.pending || status.aborted || status.installs !== 1)
       fail(4, status);
     const caller = new AbortController();
     const held = install(caller.signal, "?wait");
     if (!(await until(async () => dispatched.length === 2))) fail(5, dispatched);
     caller.abort(new Error("drain"));
     const outcome = await held.then(() => "resolved", (error) => error.message);
     if (outcome !== "drain") fail(6, outcome);
     status = await control("status");
     if (status.pending || !status.aborted || status.installs !== 2)
       fail(7, status);`,
  );
  passes(withGate([main], "observe"));
});

test("gate refuses an unknown mode", (t) => {
  const main = serviceEntry(t, "process.exit(0);");
  const result = withGate([main], "commit");
  assert.equal(result.signal, null, "entry process did not exit");
  assert.notEqual(result.status, 0, "gate accepted an unknown mode");
  assert.match(result.stderr, /ANTNEST_E2E_INSTALL_GATE/);
});

test("gate refuses to start when the Runtime transport cannot be gated", (t) => {
  const main = serviceEntry(t, "process.exit(0);", { transport: null });
  const result = withGate([main]);
  assert.equal(result.signal, null, "entry process did not exit");
  assert.notEqual(result.status, 0, "gate silently skipped the transport");
  assert.match(result.stderr, /runtime-connections/);
});
