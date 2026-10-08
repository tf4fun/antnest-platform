import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { asciiJSON } from "./ascii-json.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Mirrors Docker's log copier and json-file driver: output is cut into 16 KiB
// partial messages and each one is decoded on its own.
function throughDockerLogs(line) {
  const bytes = Buffer.from(`${line}\n`, "utf8");
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    text += bytes.subarray(offset, offset + 16_384).toString("utf8");
  return text.trimEnd();
}

const record = (padding) => ({
  status: "business_passed",
  padding: "x".repeat(padding),
  warnings: [
    "clock skew adjustment disabled; not applying calculated delta of 251.507µs",
  ],
  unicode: "注释 😀 é",
});

function splitPadding() {
  const prefix = '{"status":"business_passed","padding":"';
  const before =
    '","warnings":["clock skew adjustment disabled; not applying calculated delta of 251.507';
  return 16_383 - Buffer.byteLength(prefix) - Buffer.byteLength(before);
}

test("a raw JSON line loses a character split at 16 KiB", () => {
  const value = record(splitPadding());
  assert.notDeepEqual(
    JSON.parse(throughDockerLogs(JSON.stringify(value))),
    value,
  );
});

test("an ASCII JSON line survives every 16 KiB split", () => {
  for (const padding of [0, splitPadding() - 1, splitPadding(), 40_000]) {
    const value = record(padding);
    const line = asciiJSON(value);
    assert.match(line, /^[\x20-\x7e]*$/u);
    assert.deepEqual(JSON.parse(throughDockerLogs(line)), value);
  }
});

test("ASCII JSON keeps JSON.stringify semantics", () => {
  for (const value of [
    null,
    1.5,
    "plain",
    "\u0000\u001f\u007f\u0080\uffff",
    "\ud800",
    ["µ", { ключ: "значение" }],
  ]) {
    assert.deepEqual(
      JSON.parse(asciiJSON(value)),
      JSON.parse(JSON.stringify(value)),
    );
  }
  assert.equal(asciiJSON(undefined), undefined);
});

function logicalCommands(script) {
  return script.replace(/\\\n/gu, " ").split("\n");
}

// Runners that start a client detached and read its result with
// `docker logs "$client"`.
function logReadClients() {
  const directory = join(root, "tests/e2e");
  const clients = [];
  for (const name of readdirSync(directory).filter((file) =>
    file.endsWith(".sh"),
  )) {
    const script = readFileSync(join(directory, name), "utf8");
    if (!/\blogs "\$client"/u.test(script)) continue;
    const create = logicalCommands(script).find((command) =>
      /\bcreate --name "\$client"/u.test(command),
    );
    const entry = create?.match(/\bnode \/app\/(tests\/\S+\.mjs)/u)?.[1];
    assert(entry, `${name} creates no Node client read through docker logs`);
    clients.push({ runner: name, entry });
  }
  return clients;
}

test("clients read through docker logs print ASCII JSON", () => {
  const clients = logReadClients();
  assert(clients.length >= 15, `found only ${clients.length} clients`);
  for (const { runner, entry } of clients) {
    const source = readFileSync(join(root, entry), "utf8");
    assert.doesNotMatch(
      source,
      /(?:console\.(?:log|error)|process\.std(?:out|err)\.write)\(\s*JSON\.stringify\(/u,
      `${entry} (${runner}) prints raw JSON`,
    );
    assert.match(source, /\basciiJSON\(/u, `${entry} (${runner})`);
  }
});
