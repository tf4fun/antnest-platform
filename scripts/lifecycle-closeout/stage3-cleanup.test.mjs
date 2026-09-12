import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const keep of [true, false])
  test(`successful Stage 3 cleanup emits compact trace evidence (keep stack: ${keep})`, async () => {
    const source = await readFile(
      new URL("../e2e-stage3a.sh", import.meta.url),
      "utf8",
    );
    const cleanup = source.match(/^cleanup\(\) \{[\s\S]+?\n\}/m)?.[0];
    assert(cleanup);
    const directory = await mkdtemp(join(tmpdir(), "antnest-stage3-summary-"));
    const evidence = {
      request_id: "synthetic-request",
      admission_trace: "a".repeat(32),
    };
    try {
      await writeFile(
        join(directory, "lifecycle-trace-evidence.json"),
        JSON.stringify(evidence),
      );
      await writeFile(
        join(directory, "cookies.txt"),
        "synthetic-cookie-not-for-output",
      );
      const output = execFileSync(
        "sh",
        [
          "-c",
          `
        tool_profile=""
        compose() { :; }
        docker() { :; }
        ${cleanup}
        true
        cleanup
      `,
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            temporary_root: directory,
            keep_stack: String(keep),
            COMPOSE_PROJECT_NAME: "antnest-stage3-fixture",
          },
        },
      );
      assert.deepEqual(JSON.parse(output), evidence);
      await assert.rejects(access(directory), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
