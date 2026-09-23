import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateFile } from "./migrate-file.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "antnest-file-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, ".cache/task/check.py");
  mkdirSync(join(root, ".cache/task"), { recursive: true });
  writeFileSync(source, "assert preserved == True\n");
  return {
    source,
    destination: join(root, "tests/integration/check.py"),
    ledger: join(root, "artifacts/migration.jsonl"),
  };
}
test("migration preserves exact bytes and records hashes before deleting one original", (t) => {
  const options = fixture(t),
    original = readFileSync(options.source);
  const result = migrateFile(options);
  assert.deepEqual(readFileSync(options.destination), original);
  assert(!existsSync(options.source));
  assert.equal(result.bytes, original.length);
  const rows = readFileSync(options.ledger, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    rows.map((x) => x.state),
    ["verified", "removed"],
  );
  assert.equal(rows[0].sha256, rows[1].sha256);
});
test("migration refuses a different destination and retains the source", (t) => {
  const options = fixture(t);
  mkdirSync(join(options.destination, ".."), { recursive: true });
  writeFileSync(options.destination, "user source");
  assert.throws(() => migrateFile(options), /destination differs/);
  assert(existsSync(options.source));
  assert.equal(readFileSync(options.destination, "utf8"), "user source");
});
test("migration resumes an already copied destination without replacing it", (t) => {
  const options = fixture(t);
  mkdirSync(join(options.destination, ".."), { recursive: true });
  writeFileSync(options.destination, readFileSync(options.source));
  migrateFile(options);
  assert(!existsSync(options.source));
});
test("migration refuses cache destinations and journals", (t) => {
  const options = fixture(t);
  assert.throws(
    () =>
      migrateFile({
        ...options,
        destination: join(options.source, "../../elsewhere.py"),
      }),
    /durable.*cache/,
  );
  assert.throws(
    () =>
      migrateFile({
        ...options,
        ledger: join(options.source, "../ledger.json"),
      }),
    /durable.*cache/,
  );
  assert(existsSync(options.source));
});

test("a reviewed mechanical transform verifies the canonical copy before removing its old source", (t) => {
  const options = fixture(t);
  const canonical = Buffer.from("assert preserved == True\n\n");
  mkdirSync(join(options.destination, ".."), { recursive: true });
  writeFileSync(options.destination, canonical);
  const result = migrateFile({
    ...options,
    transform: (bytes) => Buffer.concat([bytes, Buffer.from("\n")]),
  });
  assert(!existsSync(options.source));
  assert.deepEqual(readFileSync(options.destination), canonical);
  assert.notEqual(result.source_sha256, result.sha256);
});
