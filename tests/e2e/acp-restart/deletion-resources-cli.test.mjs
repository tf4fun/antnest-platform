import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../support/run-command.mjs";

const project = "antnest-stage3-e2e-123";
const filter = `label=io.antnest.runtime-controller-scope=${project}`;
const containerQuery = ["ps", "-aq", "--filter", filter];
const volumeQuery = ["volume", "ls", "-q", "--filter", filter];
const cli = fileURLToPath(
  new URL("./deletion-resources-cli.mjs", import.meta.url),
);

async function run(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "antnest-deletion-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const directory = join(root, "private-evidence");
  const commandsFile = join(root, "docker-commands.jsonl");
  const output = join(root, "command");
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\n` +
      String.raw`
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const path = process.env.ANTNEST_TEST_DOCKER_COMMANDS;
const previous = existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];
const filter = "label=io.antnest.runtime-controller-scope=antnest-stage3-e2e-123";
const containers = JSON.stringify(args) === JSON.stringify(["ps", "-aq", "--filter", filter]);
const volumes = JSON.stringify(args) === JSON.stringify(["volume", "ls", "-q", "--filter", filter]);
const record = { args, at_ms: Date.now(), stdout: "", stderr: "", exit_code: 0 };
if (!containers && !volumes) {
  record.stderr = "Fixture refused an unexpected Docker command";
  record.exit_code = 91;
} else if (volumes && process.env.ANTNEST_TEST_DOCKER_MODE === "read-failure") {
  record.stderr = "fixture Docker volume read failed";
  record.exit_code = 23;
} else if (volumes && process.env.ANTNEST_TEST_DOCKER_MODE === "volume-disappears" &&
  !previous.some((row) => row.args[0] === "volume")) {
  record.stdout = "prepared-volume-1\n";
}
appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
process.stdout.write(record.stdout);
if (record.stderr) process.stderr.write(record.stderr + "\n");
process.exitCode = record.exit_code;
`,
    { flag: "wx", mode: 0o700 },
  );
  const deadline = Date.now() + 6000;
  const result = await runCommand({
    command: [process.execPath, cli, project, directory],
    output,
    name: "deletion-cli",
    timeoutMs: 10_000,
    graceMs: 1000,
    env: {
      ...process.env,
      PATH: bin,
      ANTNEST_E2E_DEADLINE_MS: String(deadline),
      ANTNEST_TEST_DOCKER_COMMANDS: commandsFile,
      ANTNEST_TEST_DOCKER_MODE: mode,
    },
  });
  assert.equal(
    result.complete,
    true,
    "The original CLI must exit and join within its timeout",
  );
  const evidencePath = join(directory, "deletion-resources.private.json");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const commands = readFileSync(commandsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(evidence.project, project);
  assert.equal(evidence.deadline, deadline);
  assert.deepEqual(
    evidence.commands.map((command) => command.args),
    commands.map((command) => command.args),
  );
  return {
    result,
    directory,
    evidencePath,
    evidence,
    commands,
    log: readFileSync(join(output, "deletion-cli.log"), "utf8"),
  };
}

test(
  "deletion CLI accepts empty scoped inventories and preserves private original evidence",
  { timeout: 15_000 },
  async (t) => {
    const f = await run(t, "empty");
    assert.equal(f.result.exit_code, 0, f.log);
    assert.match(f.log, /"status":"deletion_resources_passed"/u);
    assert.deepEqual(
      f.commands.map((command) => command.args),
      [containerQuery, volumeQuery],
    );
    assert(f.commands.every((command) => command.exit_code === 0));
    assert.equal(f.evidence.observations.length, 1);
    assert.deepEqual(f.evidence.observations[0].containers, []);
    assert.deepEqual(f.evidence.observations[0].volumes, []);
    assert(Number.isFinite(f.evidence.observations[0].observed_at_ms));
    assert(
      f.evidence.commands.every(
        (command) =>
          command.output === "" &&
          Number.isFinite(command.started_at_ms) &&
          Number.isFinite(command.completed_at_ms),
      ),
    );
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(statSync(f.evidencePath).mode & 0o777, 0o600);
  },
);

test(
  "deletion CLI polls a disappearing volume without deleting resources or discarding observations",
  { timeout: 15_000 },
  async (t) => {
    const f = await run(t, "volume-disappears");
    assert.equal(f.result.exit_code, 0, f.log);
    assert.match(f.log, /"status":"deletion_resources_passed"/u);
    assert.deepEqual(
      f.commands.map((command) => command.args),
      [containerQuery, volumeQuery, containerQuery, volumeQuery],
    );
    assert(f.commands.every((command) => command.exit_code === 0));
    assert.equal(f.evidence.observations.length, 2);
    assert.deepEqual(
      f.evidence.observations.map((row) => ({
        containers: row.containers,
        volumes: row.volumes,
      })),
      [
        { containers: [], volumes: ["prepared-volume-1"] },
        { containers: [], volumes: [] },
      ],
    );
    assert(
      f.evidence.observations.every((row) =>
        Number.isFinite(row.observed_at_ms),
      ),
    );
    assert(
      f.evidence.observations[1].observed_at_ms >
        f.evidence.observations[0].observed_at_ms,
    );
    assert.deepEqual(
      f.commands.map((command) => command.stdout),
      ["", "prepared-volume-1\n", "", ""],
    );
    assert.deepEqual(
      f.evidence.commands.map((command) => command.output),
      ["", "prepared-volume-1", "", ""],
    );
  },
);

test(
  "deletion CLI fails a Docker read and archives its original error and partial commands",
  { timeout: 15_000 },
  async (t) => {
    const f = await run(t, "read-failure");
    assert.notEqual(f.result.exit_code, 0);
    assert.doesNotMatch(f.log, /deletion_resources_passed/u);
    assert.match(f.log, /"status":"deletion_resources_failed"/u);
    assert.deepEqual(
      f.commands.map((command) => command.args),
      [containerQuery, volumeQuery],
    );
    assert.deepEqual(
      f.commands.map((command) => command.exit_code),
      [0, 23],
    );
    assert.equal(f.evidence.commands[0].output, "");
    assert(Number.isFinite(f.evidence.commands[0].completed_at_ms));
    assert.equal(f.evidence.commands[1].output, null);
    assert.equal(
      Object.hasOwn(f.evidence.commands[1], "completed_at_ms"),
      false,
    );
    const failurePath = join(
      f.directory,
      "deletion-resources-failure.private.txt",
    );
    const failure = readFileSync(failurePath, "utf8");
    assert.match(failure, /Docker volume failed \(23\)/u);
    assert.match(failure, /fixture Docker volume read failed/u);
    assert.equal(statSync(failurePath).mode & 0o777, 0o600);
  },
);
