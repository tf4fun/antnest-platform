import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withGoTestSources } from "./go-lint.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "antnest-go-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const scope of ["integration", "e2e"]) {
    const directory = join(
      root,
      "tests",
      scope,
      "go/sample/internal/component",
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${scope}_test.go`),
      `package component // ${scope}\n`,
    );
  }
  return { root, services: ["sample"], output: join(root, "evidence") };
}

test("lint preserves a concurrently replaced file and still removes its other links", async (t) => {
  const options = fixture(t);
  const directory = join(options.root, "services/sample/internal/component");
  await withGoTestSources(options, async () => {
    const replaced = join(directory, "e2e_test.go");
    unlinkSync(replaced);
    writeFileSync(replaced, "user edit\n");
  });
  assert.equal(
    readFileSync(join(directory, "e2e_test.go"), "utf8"),
    "user edit\n",
  );
  assert.throws(() => lstatSync(join(directory, "integration_test.go")), {
    code: "ENOENT",
  });
});

test("lint discovers root integration and E2E sources and removes temporary package links", async (t) => {
  const options = fixture(t);
  const result = await withGoTestSources(options, async () => {
    for (const scope of ["integration", "e2e"]) {
      const path = join(
        options.root,
        `services/sample/internal/component/${scope}_test.go`,
      );
      assert(lstatSync(path).isSymbolicLink());
      assert.match(readFileSync(path, "utf8"), new RegExp(scope));
    }
    return { exit_code: 7 };
  });
  assert.equal(result.exit_code, 7);
  for (const scope of ["integration", "e2e"])
    assert.throws(
      () =>
        lstatSync(
          join(
            options.root,
            `services/sample/internal/component/${scope}_test.go`,
          ),
        ),
      { code: "ENOENT" },
    );
});

test("lint failure cleans package links without deleting root test sources", async (t) => {
  const options = fixture(t);
  const failure = new Error("lint interrupted");
  await assert.rejects(
    withGoTestSources(options, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.throws(
    () =>
      lstatSync(
        join(
          options.root,
          "services/sample/internal/component/integration_test.go",
        ),
      ),
    { code: "ENOENT" },
  );
  assert.match(
    readFileSync(
      join(options.root, "tests/e2e/go/sample/internal/component/e2e_test.go"),
      "utf8",
    ),
    /e2e/,
  );
});

test("partial lint setup cleans its links and preserves an existing dangling link", async (t) => {
  const options = fixture(t);
  const directory = join(options.root, "services/sample/internal/component");
  mkdirSync(directory, { recursive: true });
  const existing = join(directory, "e2e_test.go");
  symlinkSync("missing-user-source", existing);
  await assert.rejects(
    withGoTestSources(options, async () => assert.fail("must not lint")),
    { code: "EEXIST" },
  );
  assert.equal(readlinkSync(existing), "missing-user-source");
  assert.throws(() => lstatSync(join(directory, "integration_test.go")), {
    code: "ENOENT",
  });
});
