import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../../support/run-command.mjs";

for (const kind of ["cached", "existing"])
  test(`Development browser rejects ${kind} evidence before launch`, async (t) => {
    const root = mkdtempSync(
      join(tmpdir(), "antnest-development-browser-entry-"),
    );
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = join(root, kind === "cached" ? ".cache/output" : "existing");
    if (kind === "existing") {
      mkdirSync(output);
      writeFileSync(join(output, "report.json"), "retained evidence\n");
    }
    const env = join(root, "settings.env"),
      secret = join(root, "secret.env");
    writeFileSync(
      env,
      "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
    );
    writeFileSync(secret, "DEEPSEEK_API_KEY=fixture-key\n");
    const result = await runCommand({
      command: [
        process.execPath,
        "tests/e2e/workspace-closeout/development-browser.mjs",
        "--confirm-development",
        "--env-file",
        env,
        "--secret-file",
        secret,
        "--output",
        output,
      ],
      output: join(root, "logs"),
      name: "entry",
      timeoutMs: 10000,
      graceMs: 1000,
    });
    assert.equal(result.complete, true);
    assert.equal(result.exit_code, 1);
    const log = readFileSync(join(root, "logs/entry.log"), "utf8");
    assert.match(
      log,
      kind === "cached"
        ? /durable files must not use \.cache/
        : /fresh Development output directory/,
    );
    if (kind === "existing")
      assert.equal(
        readFileSync(join(output, "report.json"), "utf8"),
        "retained evidence\n",
      );
  });
