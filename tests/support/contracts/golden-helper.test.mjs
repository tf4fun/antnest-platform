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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertGolden,
  loadGolden,
  validateGolden,
  withFutureFields,
} from "./golden.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "antnest-golden-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("withFutureFields clones the value and stamps every nested object", () => {
  const original = {
    schema_version: 1,
    label: "record",
    nothing: null,
    nested: { cursor: null, deeper: { list: [1, 2] } },
    items: [{ id: "a", inner: { flag: true } }, { id: "b" }, null],
  };
  const snapshot = structuredClone(original);
  const enriched = withFutureFields(original);
  assert.notEqual(enriched, original);
  assert.notEqual(enriched.nested, original.nested);
  assert.notEqual(enriched.items[0], original.items[0]);
  assert.deepEqual(original, snapshot);
  assert.equal(enriched.x_future_field, 1);
  assert.equal(enriched.schema_version, 1);
  assert.equal(enriched.label, "record");
  assert.equal(enriched.nothing, null);
  assert.equal(enriched.nested.x_future_field, 1);
  assert.equal(enriched.nested.cursor, null);
  assert.equal(enriched.nested.deeper.x_future_field, 1);
  assert.equal(enriched.items[0].x_future_field, 1);
  assert.equal(enriched.items[0].inner.x_future_field, 1);
  assert.equal(enriched.items[1].x_future_field, 1);
  assert.equal(enriched.items[2], null);
  assert.ok(!("x_future_field" in enriched.items));
  assert.ok(!("x_future_field" in enriched.nested.deeper.list));
});

test("withFutureFields returns primitives untouched and enriches array elements", () => {
  assert.equal(withFutureFields(null), null);
  assert.equal(withFutureFields(7), 7);
  assert.equal(withFutureFields("text"), "text");
  assert.equal(withFutureFields(false), false);
  const enriched = withFutureFields([{ a: 1 }, 2, "x"]);
  assert.deepEqual(enriched[0], { a: 1, x_future_field: 1 });
  assert.equal(enriched[1], 2);
  assert.equal(enriched[2], "x");
});

test("loadGolden parses an example stored under contracts/<area>/examples", (t) => {
  const area = `golden-selftest-${process.pid}`;
  const areaDir = join(root, "contracts", area);
  mkdirSync(join(areaDir, "examples"), { recursive: true });
  t.after(() => rmSync(areaDir, { recursive: true, force: true }));
  const payload = { z: [1, { inner: null }], a: { deep: true } };
  writeFileSync(
    join(areaDir, "examples", "sample.json"),
    `${JSON.stringify(payload)}\n`,
  );
  assert.deepEqual(loadGolden(area, "sample.json"), payload);
});

test("loadGolden rejects traversal and absolute area or filename", () => {
  for (const [area, filename] of [
    ["identity", "../identity-contract.json"],
    ["identity", "../../CONVENTIONS.md"],
    ["identity", "nested/../escape.json"],
    ["identity", "/etc/hostname"],
    ["identity", ""],
    ["..", "x.json"],
    ["../common", "x.json"],
    ["common/../identity", "x.json"],
    ["/tmp", "x.json"],
  ]) {
    assert.throws(
      () => loadGolden(area, filename),
      undefined,
      `${area} / ${filename}`,
    );
  }
});

test("assertGolden passes when only object key order differs", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "ordered.json");
  writeFileSync(file, '{"b":{"y":2,"x":[1,{"n":null,"m":3}]},"a":1}\n');
  assert.doesNotThrow(() =>
    assertGolden(file, { a: 1, b: { x: [1, { m: 3, n: null }], y: 2 } }),
  );
});

test("assertGolden accepts a file URL", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "url.json");
  writeFileSync(file, '{"ok":true}\n');
  assert.doesNotThrow(() => assertGolden(pathToFileURL(file), { ok: true }));
});

test("assertGolden fails on mismatch and leaves the file untouched", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "mismatch.json");
  writeFileSync(file, '{"a":1}\n');
  assert.throws(() => assertGolden(file, { a: 2 }));
  assert.throws(() => assertGolden(file, { a: 1, extra: true }));
  assert.throws(() => assertGolden(file, {}));
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
});

test("assertGolden fails closed on a missing file without update", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "missing.json");
  assert.throws(() => assertGolden(file, { a: 1 }));
  assert.ok(!existsSync(file));
});

test("assertGolden update writes normalized JSON that then passes", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "written.json");
  const actual = { b: { y: 2, x: null }, a: [1, { c: true }] };
  assert.doesNotThrow(() => assertGolden(file, actual, { update: true }));
  const text = readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.ok(text.includes("\n  "));
  assert.deepEqual(JSON.parse(text), actual);
  assert.doesNotThrow(() => assertGolden(file, actual));
});

test("assertGolden update replaces a stale document", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "stale.json");
  writeFileSync(file, '{"old":true}\n');
  assert.doesNotThrow(() =>
    assertGolden(file, { next: [1, 2] }, { update: true }),
  );
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { next: [1, 2] });
});

test("assertGolden ignores ambient UPDATE_GOLDEN unless the caller opts in", (t) => {
  const dir = tempDir(t);
  const previous = process.env.UPDATE_GOLDEN;
  process.env.UPDATE_GOLDEN = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.UPDATE_GOLDEN;
    else process.env.UPDATE_GOLDEN = previous;
  });
  const missing = join(dir, "env-missing.json");
  assert.throws(() => assertGolden(missing, { a: 1 }));
  assert.ok(!existsSync(missing));
  const stale = join(dir, "env-stale.json");
  writeFileSync(stale, '{"a":1}\n');
  assert.throws(() => assertGolden(stale, { a: 2 }));
  assert.equal(readFileSync(stale, "utf8"), '{"a":1}\n');
  assert.doesNotThrow(() =>
    assertGolden(
      stale,
      { a: 2 },
      { update: process.env.UPDATE_GOLDEN === "1" },
    ),
  );
  assert.deepEqual(JSON.parse(readFileSync(stale, "utf8")), { a: 2 });
});

test("validateGolden resolves contract descriptor method fragments", async () => {
  assert.equal(
    await validateGolden(
      "identity/identity-contract.json#/methods/list_login_methods/response",
      { methods: [] },
    ),
    true,
  );
  await assert.rejects(() =>
    validateGolden(
      "identity/identity-contract.json#/methods/list_login_methods/response",
      { methods: "local" },
    ),
  );
});
