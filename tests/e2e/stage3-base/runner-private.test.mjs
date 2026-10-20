import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const entry = fileURLToPath(new URL("../e2e-stage3-base.sh", import.meta.url));
const source = await readFile(entry, "utf8");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const boundary = source.indexOf('docker_cmd start "$client"');
assert(boundary > 0);
for (const [entryStatus, failedOperation, expectedStatus] of [
  [73, "", 73],
  [2, "", 2],
  [2, "logs", 1],
  [2, "rm", 1],
])
  test(`actual Stage3 runner preserves ${entryStatus}, archive/cleanup ${failedOperation || "ok"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "stage3-private-runner-"));
    const project = "stage3-fixture-" + process.pid;
    const evidence = join(root, "artifacts/verification/stage3-base", project);
    const calls = join(directory, "calls.jsonl");
    const image = "sha256:" + "a".repeat(64);
    try {
      await writeFile(
        join(directory, "node"),
        `#!${process.execPath}\n` +
          `
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2), entry=args.shift();
if(entry.endsWith('/docker.mjs')) {
 appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
 if (args[0] === process.env.FAIL_OPERATION) process.exit(1);
 if(args[0]==='ps') process.stdout.write('deployed-acp');
 else if(args[0]==='inspect' && args.includes('--format')) process.stdout.write(process.env.IMAGE_ID);
 else if(args[0]==='inspect') process.stdout.write('[]');
 else if(args[0]==='logs') process.stdout.write('original diagnostic');
 else if(['create','run'].includes(args[0])) process.stdout.write('helper');
} else if(entry==='-e') process.stdout.write('9999999999999');
else if(!entry.endsWith('/storage.mjs')&&!entry.endsWith('/deployment.mjs')) throw new Error('unexpected entry '+entry);
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        "/bin/sh",
        ["-c", source.slice(0, boundary) + `\nexit ${entryStatus}\n`, entry],
        {
          env: {
            PATH: directory + ":/usr/bin:/bin",
            CALLS: calls,
            IMAGE_ID: image,
            FAIL_OPERATION: failedOperation,
            COMPOSE_PROJECT_NAME: project,
            ANTNEST_E2E_DISPOSABLE: "true",
            ANTNEST_SERVICE_AUTH_DIRECTORY: "/auth",
            ANTNEST_SERVICE_AUTH_UID: String(process.getuid()),
            ANTNEST_SERVICE_AUTH_GID: String(process.getgid()),
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      const rows = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      const client = rows.find(
        (r) => r[0] === "create" && r.includes(project + "-base-client"),
      );
      assert(client);
      assert(client.includes(image), "must use deployed ACP image identity");
      for (const value of [
        project + "_edge",
        "/auth/agent-ui/tokens/agent-acp-service:/run/auth/agent-ui-acp:ro",
        root.replace(/\/$/, "") +
          "/contracts/agent-acp/agent-execution-state.schema.json:/app/contracts/agent-acp/agent-execution-state.schema.json:ro",
        evidence + ":/evidence",
      ])
        assert(client.includes(value), value);
      assert(!client.some((v) => v.includes(":/var/run/docker.sock")));
      assert.equal(
        await readFile(join(evidence, "client.log"), "utf8"),
        failedOperation === "logs" ? "" : "original diagnostic",
      );
      const logs = rows.findIndex(
        (r) => r[0] === "logs" && r.includes(project + "-base-client"),
      );
      const removal = rows.findIndex(
        (r) => r[0] === "rm" && r.includes(project + "-base-client"),
      );
      assert(logs >= 0 && removal > logs, "archive must precede deletion");
      const receipt = JSON.parse(
        await readFile(join(evidence, "cleanup.json"), "utf8"),
      );
      assert.equal(receipt.entry_status, entryStatus);
      assert.equal(receipt.archive_status, failedOperation === "logs" ? 1 : 0);
      assert.equal(receipt.cleanup_status, failedOperation === "rm" ? 1 : 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(evidence, { recursive: true, force: true });
    }
  });
