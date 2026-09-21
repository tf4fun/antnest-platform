import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const [name, initial, residual, expected] of [
  ["success", 0, false, 0],
  ["strict failure", 2, false, 2],
  ["residual resources", 0, true, 1],
])
  test(`Stage 3 owned cleanup preserves ${name} and keeps raw evidence private`, async () => {
    const source = await readFile(
      new URL("../e2e-stage3a.sh", import.meta.url),
      "utf8",
    );
    const cleanup = source.match(/^cleanup\(\) \{[\s\S]+?\n\}/m)?.[0];
    assert(cleanup);
    const directory = await mkdtemp(join(tmpdir(), "antnest-stage3-cleanup-"));
    const temporary = join(directory, "work");
    const calls = join(directory, "calls");
    try {
      await mkdir(temporary);
      // Obsolete evidence must not be printed even if a stale file is present.
      const secret = "synthetic-private-evidence";
      await writeFile(join(temporary, "lifecycle-trace-evidence.json"), secret);
      const result = spawnSync(
        "/bin/sh",
        [
          "-c",
          `
        node() { :; }
        compose() {
          printf 'compose %s\\n' "$*" >> "$CALLS"
          if [ "$1" = logs ]; then printf '%s' '${secret}'; fi
        }
        docker() {
          printf 'docker %s\\n' "$*" >> "$CALLS"
          case "$*" in
            'ps -aq --filter label=com.docker.compose.project='*)
              if [ ! -f "$CALLS.seen" ]; then touch "$CALLS.seen"; echo owned-container;
              elif [ "$RESIDUAL" = true ]; then echo leftover; fi ;;
          esac
        }
        ${cleanup}
        (exit "$INITIAL")
        cleanup
      `,
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            CALLS: calls,
            INITIAL: String(initial),
            RESIDUAL: String(residual),
            temporary_root: temporary,
            tool_profile: "stage3-base",
            keep_stack: "false",
            COMPOSE_PROJECT_NAME: "antnest-stage3-fixture",
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, expected);
      assert(!`${result.stdout}${result.stderr}`.includes(secret));
      const commands = (await readFile(calls, "utf8")).trim().split("\n");
      const stop = commands.indexOf(
        "compose stop agent-controller runtime-controller",
      );
      const enumerate = commands.indexOf(
        "docker ps -aq --filter label=com.docker.compose.project=antnest-stage3-fixture",
      );
      assert(stop >= 0 && enumerate > stop);
      assert(commands.includes("docker rm -f owned-container"));
      assert(commands.includes("compose down --volumes --remove-orphans"));
      for (const label of [
        "com.docker.compose.project",
        "io.antnest.runtime-controller-scope",
      ])
        for (const command of ["ps -aq", "volume ls -q", "network ls -q"])
          assert(
            commands.includes(
              `docker ${command} --filter label=${label}=antnest-stage3-fixture`,
            ),
          );
      await assert.rejects(access(temporary), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
