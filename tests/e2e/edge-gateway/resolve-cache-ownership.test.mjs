import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cacheEvidencePaths } from "./resolve-cache-ownership.mjs";

for (const field of ["credentialsDirectory", "output"])
  test(`existing ${field} is never acquired for cleanup or failure output`, (t) => {
    const project = `antnest-lifecycle-${randomUUID().slice(0, 8)}`;
    const paths = cacheEvidencePaths(project);
    mkdirSync(paths[field], { recursive: true, mode: 0o700 });
    t.after(() => rmSync(paths[field], { recursive: true, force: true }));
    const sentinel = join(paths[field], "sentinel");
    writeFileSync(sentinel, "existing-private-evidence", { mode: 0o600 });
    let owned;
    assert.throws(() => {
      owned = cacheEvidencePaths(project);
    }, /already exists/u);
    assert.equal(owned, undefined);
    assert.equal(readFileSync(sentinel, "utf8"), "existing-private-evidence");
    const other = field === "output" ? "credentialsDirectory" : "output";
    assert.equal(existsSync(paths[other]), false);
  });
