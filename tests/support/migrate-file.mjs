import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { durablePath } from "./storage.mjs";

export function migrateFile({ source, destination, ledger, transform }) {
  source = resolve(source);
  destination = durablePath(destination);
  ledger = durablePath(ledger);
  assert(lstatSync(source).isFile(), "migration source must be a regular file");
  const original = readFileSync(source);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const expected = transform ? Buffer.from(transform(original)) : original;
  const source_sha256 = hash(original);
  const sha256 = hash(expected);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (!existsSync(destination)) {
    if (transform)
      writeFileSync(destination, expected, { flag: "wx", mode: 0o600 });
    else copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
  }
  assert(
    lstatSync(destination).isFile(),
    "migration destination must be a regular file",
  );
  assert.equal(
    hash(readFileSync(destination)),
    sha256,
    "migration destination differs",
  );
  assert.equal(
    hash(readFileSync(source)),
    source_sha256,
    "migration source changed",
  );
  mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
  const record = {
    source,
    destination,
    source_sha256,
    sha256,
    bytes: original.length,
  };
  const append = (state) =>
    appendFileSync(ledger, JSON.stringify({ ...record, state }) + "\n", {
      mode: 0o600,
    });
  append("verified");
  unlinkSync(source);
  append("removed");
  return record;
}
