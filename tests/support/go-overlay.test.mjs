import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeGoOverlay } from "./go-overlay.mjs";

test("root Go integration sources retain private package access and are discovered", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-go-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (path, content) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  file("go.work", "go 1.25.4\nuse ./services/sample\n");
  file("services/sample/go.mod", "module example.test/sample\ngo 1.25.4\n");
  file(
    "services/sample/internal/component/value.go",
    "package component\nfunc privateValue() int { return 7 }\n",
  );
  file(
    "tests/integration/go/sample/internal/component/value_integration_test.go",
    'package component\nimport "testing"\nfunc TestRootPrivateValue(t *testing.T) { if privateValue()!=7 { t.Fatal("value") } }\n',
  );
  file(
    "tests/integration/go/sample/internal/e2e/root_test.go",
    'package e2e\nimport "testing"\nfunc TestVirtualTestPackage(t *testing.T) {}\n',
  );
  const overlay = writeGoOverlay({
    root,
    service: "sample",
    output: join(root, "evidence"),
  });
  const content = JSON.parse(readFileSync(overlay, "utf8"));
  assert.equal(Object.keys(content.Replace).length, 2);
  const result = spawnSync(
    "go",
    ["test", "-overlay", overlay, "-count=1", "-v", "./services/sample/..."],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GOCACHE: join(root, "gocache"), GOPROXY: "off" },
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: TestRootPrivateValue/);
  assert.match(result.stdout, /PASS: TestVirtualTestPackage/);
});

test("overlay refuses to replace existing service code", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-go-collision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const base of ["services/sample", "tests/integration/go/sample"]) {
    mkdirSync(join(root, base), { recursive: true });
    writeFileSync(join(root, base, "existing_test.go"), "package sample\n");
  }
  assert.throws(
    () =>
      writeGoOverlay({
        root,
        service: "sample",
        output: join(root, "evidence"),
      }),
    /existing service source/,
  );
});
