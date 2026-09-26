import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSuite } from "./run-suite.mjs";

test("serial suites preserve accepted diagnostic exits and stop on a business failure", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const manifest = [0, 2, 1, 0].map((code, index) => ({
    name: `step-${index}`,
    command: [process.execPath, "-e", `process.exit(${code})`],
    accepted_exits: [0, 2],
  }));
  const result = await runSuite({ manifest, output });
  assert.equal(result.exit_code, 1);
  assert.deepEqual(
    result.results.map((row) => row.exit_code),
    [0, 2, 1],
  );
  assert.equal(result.complete, false);
  assert.deepEqual(
    JSON.parse(readFileSync(join(output, "suite.result.json"), "utf8")),
    result,
  );
});
test("serial suites reject duplicate evidence names before executing any command", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  await assert.rejects(
    runSuite({
      output,
      manifest: [
        { name: "same", command: ["invalid"] },
        { name: "same", command: ["invalid"] },
      ],
    }),
  );
});

test("an accepted Make exit cannot hide a multiline business failure", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const result = await runSuite({
    output,
    manifest: [
      {
        name: "business",
        command: [
          process.execPath,
          "-e",
          'console.log(JSON.stringify({status:"failed",error_type:"AssertionError",stage:"prompt"},null,2));process.exit(2)',
        ],
        accepted_exits: [0, 2],
      },
      {
        name: "must-not-run",
        command: [process.execPath, "-e", "process.exit()"],
      },
    ],
  });
  assert.equal(result.exit_code, 2);
  assert.equal(result.complete, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.reason, "business-failure");
});

test("an accepted strict exit cannot hide a Foundation browser failure", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-foundation-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const result = await runSuite({
    output,
    manifest: [
      {
        name: "foundation",
        command: [
          process.execPath,
          "-e",
          'console.error("Foundation business/topology failed; diagnostics retained privately");process.exit(2)',
        ],
        accepted_exits: [0, 2],
      },
      {
        name: "must-not-run",
        command: [process.execPath, "-e", "process.exit()"],
      },
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, "business-failure");
  assert.equal(result.results.length, 1);
});

test("a business failure still records the required environment cleanup check", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-failed-cleanup-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const baseline = {
    resources: { containers: [], volumes: [], networks: [] },
    retained: [],
    images: {},
  };
  let checked = 0;
  const result = await runSuite({
    output,
    baseline,
    snapshot: async () => {
      checked++;
      return baseline;
    },
    manifest: [
      {
        name: "failed",
        command: [
          process.execPath,
          "-e",
          'console.log(JSON.stringify({status:"failed",error_type:"AssertionError"}));process.exit(2)',
        ],
        accepted_exits: [0, 2],
        check_resources: true,
      },
    ],
  });
  assert.equal(result.reason, "business-failure");
  assert.equal(checked, 1);
  assert.equal(
    JSON.parse(readFileSync(join(output, "failed.environment.json"))).unchanged,
    true,
  );
});

test("suite entries forward explicit environment overrides", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-environment-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const result = await runSuite({
    output,
    manifest: [
      {
        name: "environment",
        env: { ANTNEST_SUITE_PROBE: "explicit" },
        command: [
          process.execPath,
          "-e",
          "if(process.env.ANTNEST_SUITE_PROBE!=='explicit')process.exit(1)",
        ],
      },
    ],
  });
  assert.equal(result.exit_code, 0);
});

test("a passing test title is not a business failure report", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-suite-passing-title-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const result = await runSuite({
    output,
    manifest: [
      {
        name: "test-titles",
        command: [
          process.execPath,
          "-e",
          'console.log("✔ accepted exits cannot hide ACP access business/topology failed; private diagnostics retained (1ms)")',
        ],
      },
    ],
  });
  assert.equal(result.complete, true);
  assert.equal(result.exit_code, 0);
});

for (const report of [
  JSON.stringify({ status: "failed", error: "trace search failed" }, null, 2),
  "ACP access business/topology failed; private diagnostics retained",
  "Agent access business/topology failed; diagnostics retained privately",
]) {
  test(`accepted exits cannot hide ${report.split("\n")[0]}`, async (t) => {
    const output = mkdtempSync(
      join(tmpdir(), "antnest-suite-reported-failure-"),
    );
    t.after(() => rmSync(output, { recursive: true, force: true }));
    const result = await runSuite({
      output,
      manifest: [
        {
          name: "failed",
          command: [
            process.execPath,
            "-e",
            `console.error(${JSON.stringify(report)});process.exit(2)`,
          ],
          accepted_exits: [0, 2],
        },
        {
          name: "must-not-run",
          command: [process.execPath, "-e", "process.exit()"],
        },
      ],
    });
    assert.equal(result.complete, false);
    assert.equal(result.reason, "business-failure");
    assert.equal(result.results.length, 1);
    assert.equal(result.exit_code, 2);
  });
}
