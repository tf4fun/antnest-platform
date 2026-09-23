import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileManifest } from "./suite-manifest.mjs";

const root = new URL("../../", import.meta.url).pathname;
const record = JSON.parse(
  readFileSync(new URL("./migrations/suite-manifests.json", import.meta.url)),
);
const read = (path) => JSON.parse(readFileSync(resolve(root, path)));

function inputsFor(value, inputs = {}) {
  if (Array.isArray(value)) for (const item of value) inputsFor(item, inputs);
  else if (value && typeof value === "object") {
    if (value.input && value.input !== "output")
      inputs[value.input] = `explicit-${value.input}`;
    else for (const item of Object.values(value)) inputsFor(item, inputs);
  }
  return inputs;
}

test("all migrated queue templates compile without machine-specific commands or cache evidence paths", () => {
  assert.equal(record.entries.length, 23);
  assert.equal(
    record.entries.reduce((sum, item) => sum + item.rows, 0),
    273,
  );
  for (const entry of record.entries) {
    const template = read(entry.destination);
    const compiled = compileManifest(template, {
      output: "/tmp/antnest-catalog",
      inputs: inputsFor(template),
    });
    assert.equal(compiled.length, entry.rows, entry.destination);
    assert.equal(
      new Set(compiled.map((row) => row.name)).size,
      compiled.length,
    );
    for (const row of compiled) {
      assert(row.command.every((arg) => typeof arg === "string"));
      for (const arg of row.command) {
        assert(!arg.includes("/Users/"), entry.destination);
        assert(!/\.cache\/(?!go-build|go-mod)/.test(arg), entry.destination);
        if (
          /^(tests|services|runtimes|scripts)\//.test(arg) &&
          !/[ *]/.test(arg)
        )
          assert(existsSync(resolve(root, arg)), arg);
      }
    }
  }
});

test("migrated local checks still include Go overlays, ACP integration and real dependency profiles", () => {
  const service = read(
    "tests/suites/final-regression/service-queue-fixed.json",
  );
  assert.match(
    service.find((row) => row.name === "go-race").command.join(" "),
    /tests\/integration\/go\/run.mjs.*--profile all/,
  );
  assert.match(
    service.find((row) => row.name === "acp-tests").command.join(" "),
    /test:integration/,
  );
  assert(
    service
      .find((row) => row.name === "acp-sdk-audit")
      .command.includes("tests/support/dependencies.mjs"),
  );
  const database = read("tests/suites/final-regression/database-queue.json");
  assert(
    database
      .find((row) => row.name === "persistence-opt-in")
      .command.includes("tests/support/dependencies.mjs"),
  );
  assert(
    database
      .find((row) => row.name === "runtime-image-contract")
      .command.includes("tests/support/docker-test-images.mjs"),
  );
});

test("historical integration continuation preserves failure exits, image pinning, resource checks and pause", () => {
  const suite = read("tests/suites/final-regression/integration-queue.json");
  assert.equal(suite.length, 32);
  const stage2 = suite.find((row) => row.name === "stage2");
  assert.deepEqual(stage2.accepted_exits, [0, 2]);
  assert.equal(stage2.pin_images, true);
  assert.equal(stage2.check_resources, true);
  assert.deepEqual(stage2.pause_file, {
    input: "output",
    relative: "pause-before-next",
  });
  assert.deepEqual(stage2.env, {
    COMPOSE_PARALLEL_LIMIT: "1",
    COMPOSE_ENV_FILES: ".env.example",
  });
  assert.equal(stage2.timeout_ms, 1200000);
  assert.equal(stage2.grace_ms, 180000);
});
