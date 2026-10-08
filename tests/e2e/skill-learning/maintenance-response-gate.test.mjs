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
const withGate = (args) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: `--import ${gate}` },
  });

// ACP sends Runtime requests through RuntimeConnections.fetchFor, which uses
// undici directly. This stand-in has the same shape and never touches the
// global fetch, so only a gate on the real transport can observe it.
const runtimeTransport = `export class RuntimeConnections {
  fetchFor() {
    return async (input) => {
      const path = new URL(String(input)).pathname;
      return new Response(JSON.stringify({ path }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }
}
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
  writeFileSync(main, source);
  return main;
}

// held-commit.compose.yaml sets NODE_OPTIONS for the whole ACP container, so
// its `node -e` healthcheck loads the gate while ACP already holds the port.
test("gate stays out of node -e helpers such as the ACP healthcheck", () => {
  const result = withGate([
    "-e",
    "process.exit(globalThis.fetch.name === 'fetch' ? 0 : 3)",
  ]);
  assert.equal(result.signal, null, "helper process did not exit");
  assert.equal(result.status, 0, result.stderr);
});

test("gate installs in the ACP service entry point", (t) => {
  const main = serviceEntry(
    t,
    `const r = await fetch("http://127.0.0.1:18093/status");
     const body = await r.json();
     process.exit(body.pending === false ? 0 : 3);`,
  );
  const result = withGate([main]);
  assert.equal(result.signal, null, "entry process did not exit");
  assert.equal(result.status, 0, result.stderr);
});

test("gate holds a Runtime commit receipt sent through RuntimeConnections", (t) => {
  const main = serviceEntry(
    t,
    `import { setTimeout as delay } from "node:timers/promises";
     import { RuntimeConnections } from "./adapters/runtime-connections.js";
     const status = async () =>
       (await fetch("http://127.0.0.1:18093/status")).json();
     const send = new RuntimeConnections().fetchFor({});
     let settled = false;
     const receipt = send(
       "http://runtime.test:8093/internal/skill-maintenance/commit",
       { method: "POST", signal: new AbortController().signal },
     ).finally(() => { settled = true; });
     let held = false;
     for (let i = 0; i < 40 && !held; i++) {
       held = (await status()).pending;
       if (!held) await delay(25);
     }
     if (!held || settled) process.exit(3);
     const released = await fetch("http://127.0.0.1:18093/release", { method: "POST" });
     if (released.status !== 200) process.exit(4);
     const body = await (await receipt).json();
     if (body.path !== "/internal/skill-maintenance/commit") process.exit(5);
     const ordinary = await send(
       "http://runtime.test:8093/internal/skill-maintenance/observe",
       { method: "POST" },
     );
     if ((await ordinary.json()).path !== "/internal/skill-maintenance/observe")
       process.exit(6);
     process.exit((await status()).pending === false ? 0 : 7);`,
  );
  const result = withGate([main]);
  assert.equal(result.signal, null, "entry process did not exit");
  assert.equal(result.status, 0, result.stderr);
});

test("gate refuses to start when the Runtime transport cannot be gated", (t) => {
  const main = serviceEntry(t, "process.exit(0);", { transport: null });
  const result = withGate([main]);
  assert.equal(result.signal, null, "entry process did not exit");
  assert.notEqual(result.status, 0, "gate silently skipped the transport");
  assert.match(result.stderr, /runtime-connections/);
});
