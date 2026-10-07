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
  const directory = mkdtempSync(join(tmpdir(), "maintenance-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  const main = join(directory, "dist", "main.js");
  writeFileSync(
    main,
    `const r = await fetch("http://127.0.0.1:18093/status");
     const body = await r.json();
     process.exit(body.pending === false ? 0 : 3);`,
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const result = withGate([main]);
  assert.equal(result.signal, null, "entry process did not exit");
  assert.equal(result.status, 0, result.stderr);
});
