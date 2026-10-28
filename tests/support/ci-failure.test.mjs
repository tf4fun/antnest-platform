import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FailureObserver,
  failureMarkdown,
  reportedFailures,
} from "./ci-failure.mjs";
import { runCommand } from "./run-command.mjs";

const entry = {
  name: "TestCommitOrder",
  file: "tests/integration/runtime-controller/order_test.go",
  line: 12,
};
const catalog = () => [entry];
const secret = "Bearer secret-canary-123456";

test("Go failures publish only source-known test identities, never subtest inputs or errors", () => {
  const reports = [];
  const observer = new FailureObserver({
    catalog,
    report: (row) => reports.push(row),
    now: () => 123,
  });
  observer.write(
    JSON.stringify({
      Action: "fail",
      Test: `${entry.name}/${secret}`,
      Package: secret,
      Output: secret,
    }) + "\n",
  );
  observer.write(
    JSON.stringify({ Action: "fail", Test: secret, Output: secret }) + "\n",
  );
  assert.deepEqual(reports, [
    { version: 1, ...entry, category: "test_failure", reportedAt: 123 },
  ]);
  assert(!JSON.stringify(reports).includes(secret));
});

test("Vitest failure headlines resolve source literals and omit dynamic titles", () => {
  const reports = [];
  const row = {
    name: "rejects stale writes",
    file: "tests/integration/agent-acp-service/store.postgres.test.ts",
    line: 42,
  };
  const observer = new FailureObserver({
    catalog: () => [row],
    report: (value) => reports.push(value),
    now: () => 2,
  });
  const output = `\u001b[31m FAIL \u001b[0m ${row.file} > storage > ${row.name}\nError: ${secret}\n FAIL ${row.file} > ${secret}\n`;
  for (const byte of Buffer.from(output)) observer.write(Buffer.from([byte]));
  observer.end();
  assert.deepEqual(
    reports.map(({ name, file, line }) => ({ name, file, line })),
    [row, { name: "[dynamic test name omitted]", file: row.file, line: 1 }],
  );
  assert(!JSON.stringify(reports).includes(secret));
});

test("untrusted paths, oversized lines and workflow commands cannot escape the allowlist", () => {
  const reports = [];
  const observer = new FailureObserver({
    catalog,
    report: (row) => reports.push(row),
  });
  observer.write(` FAIL ../../${secret} > TestCommitOrder\n`);
  observer.write("x".repeat(100000));
  observer.write(` FAIL ${entry.file} > TestCommitOrder\n`);
  observer.write(`::error::${secret}\n`);
  observer.end();
  assert.deepEqual(reports, []);
  const markdown = failureMarkdown({
    ...entry,
    name: "a | b <script>\n::error::x",
    category: "test_failure",
  });
  assert(!markdown.includes("<script>"));
  assert(!markdown.includes("\n::error"));
});

test("a deliberately failing component exposes a sanitized summary while retaining private output", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ci-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reports = [];
  const observer = new FailureObserver({
    catalog,
    report: (row) => reports.push(row),
  });
  const result = await runCommand({
    command: [
      process.execPath,
      "-e",
      `console.log(JSON.stringify({Action:'fail',Test:'TestCommitOrder',Output:${JSON.stringify(secret)}}));process.exitCode=1`,
    ],
    output: directory,
    name: "deliberate-component-failure",
    failureObserver: observer,
  });
  assert.equal(result.exit_code, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].file, entry.file);
  assert(!JSON.stringify(reports).includes(secret));
  assert(
    readFileSync(
      join(directory, "deliberate-component-failure.log"),
      "utf8",
    ).includes(secret),
  );
});

test("nested command runners forward only revalidated fields and timestamp observation locally", () => {
  const reports = [];
  const row = {
    version: 1,
    ...entry,
    category: "test_failure",
    reportedAt: 123,
    error: secret,
  };
  const observer = new FailureObserver({
    catalog,
    report: (value) => reports.push(value),
    now: () => 456,
  });
  observer.write(JSON.stringify({ ci_failure: row }) + "\n");
  observer.write(
    JSON.stringify({ ci_failure: { ...row, name: secret } }) + "\n",
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reportedAt, 456);
  assert(!JSON.stringify(reports).includes(secret));
  assert.deepEqual(
    reportedFailures(JSON.stringify({ ci_failure: reports[0] }), catalog),
    reports,
  );
});

test("the real Vitest reporter yields a source-known failure without publishing its assertion values", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ci-vitest-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const reports = [];
  const result = await runCommand({
    command: [
      process.execPath,
      "services/agent-acp-service/node_modules/vitest/vitest.mjs",
      "run",
      "--root",
      "tests/support/fixtures",
      "--config",
      "ci-feedback.config.mjs",
    ],
    cwd: root,
    env: { ...process.env, ANTNEST_FEEDBACK_CANARY: secret },
    output: directory,
    name: "real-vitest-failure",
    failureObserver: new FailureObserver({
      report: (row) => reports.push(row),
    }),
  });
  assert.equal(result.exit_code, 1);
  assert.equal(
    reports.length,
    1,
    readFileSync(join(directory, "real-vitest-failure.log"), "utf8").replaceAll(
      secret,
      "[withheld]",
    ),
  );
  assert.equal(reports[0].name, "component failure feedback probe");
  assert.equal(reports[0].file, "tests/support/fixtures/ci-feedback.test.mjs");
  assert(!JSON.stringify(reports).includes(secret));
  assert(
    readFileSync(join(directory, "real-vitest-failure.log"), "utf8").includes(
      secret,
    ),
  );
});
