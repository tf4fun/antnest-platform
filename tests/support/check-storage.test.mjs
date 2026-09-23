import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheViolations } from "./check-storage.mjs";

test("cache policy catches nested project sources and lasting evidence while allowing rebuildable caches", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-cache-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of [
    [
      ".cache/go-mod/example.org/external@v1.0.0/pkg_test.go",
      "package external",
    ],
    [
      ".cache/go-mod/cache/download/example.org/external/@v/v1.0.0.ziphash",
      "h1:fixture",
    ],
    [".cache/go-build/00/" + "0".repeat(64) + "-d", "generated"],
    [".cache/task/before/test.py", "assert True"],
    [".cache/task/report.json", "{}"],
  ]) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  assert.deepEqual(cacheViolations(root), [
    ".cache/task/before/test.py",
    ".cache/task/report.json",
  ]);
});

test("rebuildable cache names do not exempt ordinary scripts and reports", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-cache-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const forbidden = [
    "go-build/check.py",
    "go-build/00/report.json",
    "golangci-lint/probe.sh",
    "go-mod/probe.py",
    "go-mod/example.org/task/check.py",
    "npm/report.json",
    "npm/_cacache/check.mjs",
    "rust-build/check.py",
    "rust-build/task/report.json",
  ];
  for (const name of forbidden) {
    const file = join(root, ".cache", name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "synthetic misplaced asset");
  }
  const found = cacheViolations(root);
  for (const name of forbidden)
    assert(
      found.some((violation) => (".cache/" + name).startsWith(violation)),
      name,
    );
});

test("an unverified module directory is not a dependency cache", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-module-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = ".cache/go-mod/example.org/task@v1.0.0";
  mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, directory, "report.json"), "{}");
  assert.deepEqual(cacheViolations(root), [directory]);
});

test("standard module metadata, npm objects and Cargo generated outputs remain allowed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-valid-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = [
    "go-mod/cache/lock",
    "go-mod/cache/download/example.org/legacy/@v/v0.0.0-20260101000000-abcdef012345+incompatible.mod",
    "go-mod/cache/download/sumdb/sum.golang.org/lookup/example.org/legacy@v1.0.0",
    "go-mod/cache/download/sumdb/sum.golang.org/tile/8/0/x123/456.p/78",
    "npm/_logs/2026-09-23T10_20_30_000Z-debug-0.log",
    "npm/_cacache/_lastverified",
    "npm/_cacache/tmp/12345678-1234-1234-1234-123456789abc",
    "npm/_cacache/content-v2/sha512/aa/bb/" + "c".repeat(124),
    "npm/_cacache/index-v5/aa/bb/" + "c".repeat(60),
    "rust-build/probe/CACHEDIR.TAG",
    "rust-build/probe/.rustc_info.json",
    "rust-build/probe/debug/.cargo-build-lock",
    "rust-build/probe/debug/build/serde-0123456789abcdef/out/private.rs",
    "rust-build/probe/debug/build/serde-0123456789abcdef/build_script_build-0123456789abcdef.d",
    "rust-build/probe/debug/.fingerprint/probe-0123456789abcdef/test-integration-test-elicitation.json",
    "rust-build/probe/debug/deps/probe-0123456789abcdef.crate.abcdef-cgu.0.rcgu.o",
    "rust-build/probe/debug/incremental/probe-0abcdefgh/s-abcd-123.lock",
  ];
  for (const path of paths) {
    mkdirSync(join(root, ".cache", path, ".."), { recursive: true });
    writeFileSync(join(root, ".cache", path), "generated cache fixture");
  }
  assert.deepEqual(cacheViolations(root), []);
  const invalid =
    "rust-build/probe/debug/build/serde-0123456789abcdef/report.json";
  writeFileSync(join(root, ".cache", invalid), "{}");
  assert.deepEqual(cacheViolations(root), [".cache/" + invalid]);
});

test("the cache root itself cannot be an alias", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-cache-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "ordinary"));
  symlinkSync(join(root, "ordinary"), join(root, ".cache"));
  assert.deepEqual(cacheViolations(root), [".cache"]);
  rmSync(join(root, "ordinary"), { recursive: true });
  assert.deepEqual(cacheViolations(root), [".cache"]);
});
test("a dependency-cache name cannot alias a project source directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-cache-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".cache"));
  mkdirSync(join(root, "tests"));
  symlinkSync(join(root, "tests"), join(root, ".cache/go-mod"));
  assert.deepEqual(cacheViolations(root), [".cache/go-mod"]);
});
