import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileManifest } from "./suite-manifest.mjs";
import { runSuite } from "./run-suite.mjs";

test("suite configuration preserves ordered rows and keeps input text a literal argv value", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-input-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const text = "spaces; $(not-a-command) `not-a-command`";
  const manifest = compileManifest(
    [
      {
        name: "first",
        command: [
          process.execPath,
          "-e",
          "if(process.argv[1]!==process.env.EXPECTED)process.exit(1)",
          { input: "text" },
        ],
        env: { EXPECTED: { input: "text" } },
        accepted_exits: [0, 2],
        timeout_ms: 1000,
        grace_ms: 100,
      },
      {
        name: "second",
        command: [process.execPath, "-e", "process.exit(2)"],
        accepted_exits: [0, 2],
      },
    ],
    { output, inputs: { text } },
  );
  const result = await runSuite({ manifest, output });
  assert.deepEqual(
    result.results.map(({ name, exit_code }) => [name, exit_code]),
    [
      ["first", 0],
      ["second", 2],
    ],
  );
  assert.equal(result.exit_code, 2);
  assert.equal(result.complete, true);
});

test("missing explicit inputs reject the complete manifest before any execution", () => {
  assert.throws(
    () =>
      compileManifest(
        [
          { name: "valid-first", command: ["would-mutate"] },
          {
            name: "missing-later",
            command: ["docker", "build", "-t", { input: "candidate_image" }],
          },
        ],
        { output: "/tmp/antnest-manifest" },
      ),
    /candidate_image/,
  );
});

test("durable paths reject cache aliases and relative path escape", () => {
  const row = (relative) => [
    { name: "path", command: ["tool", { input: "output", relative }] },
  ];
  assert.throws(
    () =>
      compileManifest(row(".cache/result"), {
        output: "/tmp/antnest-manifest",
      }),
    /cache/,
  );
  assert.throws(
    () =>
      compileManifest(row("../outside"), { output: "/tmp/antnest-manifest" }),
    /relative/,
  );
  assert.throws(
    () => compileManifest(row("/outside"), { output: "/tmp/antnest-manifest" }),
    /relative/,
  );
  assert.equal(
    compileManifest(row("dependencies/check"), {
      output: "/tmp/antnest-manifest",
    })[0].command[1],
    "/tmp/antnest-manifest/dependencies/check",
  );
  assert.throws(
    () =>
      compileManifest(row("check"), { output: "/tmp/.cache/antnest-manifest" }),
    /cache/,
  );
});

test("suite inputs cannot shadow output or silently stringify objects", () => {
  const rows = [{ name: "input", command: ["tool", { input: "value" }] }];
  assert.throws(
    () =>
      compileManifest(rows, {
        output: "/tmp/antnest-manifest",
        inputs: { value: {} },
      }),
    /string/,
  );
  assert.throws(
    () =>
      compileManifest(rows, {
        output: "/tmp/antnest-manifest",
        inputs: { value: "ok", output: "/tmp/wrong" },
      }),
    /reserved/,
  );
  assert.throws(
    () =>
      compileManifest(
        [{ name: "bad", command: ["tool", { input: "value", unknown: true }] }],
        { output: "/tmp/antnest-manifest", inputs: { value: "ok" } },
      ),
    /reference/,
  );
});
