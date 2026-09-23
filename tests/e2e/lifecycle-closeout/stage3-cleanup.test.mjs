import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  stat,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const [name, initial, residual, expected, diagnostics, logFailure] of [
  ["success", 0, false, 0],
  ["strict failure", 2, false, 2],
  ["residual resources", 0, true, 1],
  ["identity diagnostics on success", 0, false, 0, true],
  ["identity diagnostics on failure", 1, false, 1, true],
  ["identity diagnostics on strict failure", 2, false, 2, true],
  ["identity diagnostics after SIGINT", 130, false, 130, true],
  ["identity diagnostics after SIGTERM", 143, false, 143, true],
  ["failed diagnostic collection", 2, false, 2, true, true],
  ["identity diagnostics with residual resources", 0, true, 1, true],
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
    const anonymousVolume = join(directory, "anonymous-volume");
    try {
      await mkdir(temporary);
      await writeFile(anonymousVolume, "attached only to owned-container");
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
          if [ "$1" = logs ]; then
            printf '%s' '${secret}'
            printf '%s' 'private-stderr' >&2
            [ "$LOG_FAILURE" != true ] || return 7
          fi
        }
        docker() {
          printf 'docker %s\\n' "$*" >> "$CALLS"
          case "$*" in
            'rm -f -v owned-container') rm "$ANONYMOUS_VOLUME" ;;
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
            ANONYMOUS_VOLUME: anonymousVolume,
            INITIAL: String(initial),
            RESIDUAL: String(residual),
            LOG_FAILURE: String(Boolean(logFailure)),
            identity_diagnostic_log: diagnostics
              ? join(directory, "identity.private.log")
              : "",
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
      const capture = commands.indexOf(
        "compose logs --no-color identity-service admin-console edge-gateway",
      );
      if (diagnostics) {
        assert(capture >= 0 && capture < stop);
        assert.equal(
          commands.filter((line) => line === commands[capture]).length,
          1,
        );
        const evidence = join(directory, "identity.private.log");
        assert.equal(
          await readFile(evidence, "utf8"),
          secret + "private-stderr",
        );
        assert.equal((await stat(evidence)).mode & 0o777, 0o600);
      } else assert.equal(capture, -1);
      await assert.rejects(access(anonymousVolume), { code: "ENOENT" });
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

test("Identity diagnostic output is rejected before any Docker access", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "antnest-identity-log-preflight-"),
  );
  const script = new URL("../e2e-stage3a.sh", import.meta.url);
  const repository = new URL("../../../", import.meta.url);
  try {
    const binary = join(directory, "bin");
    await mkdir(binary);
    const calls = join(directory, "docker-called");
    await writeFile(
      join(binary, "docker"),
      '#!/bin/sh\ntouch "$CALLS"\nexit 9\n',
      { mode: 0o700 },
    );
    const alias = join(directory, "alias");
    await symlink(new URL(".cache", repository), alias);
    for (const output of [
      new URL(".cache/forbidden.log", repository).pathname,
      join(alias, "forbidden.log"),
      directory,
    ]) {
      const result = spawnSync("/bin/sh", [script.pathname], {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          PATH: binary + ":" + process.env.PATH,
          CALLS: calls,
          ANTNEST_E2E_IDENTITY_DIAGNOSTIC_LOG: output,
        },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0);
      await assert.rejects(access(calls), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Identity diagnostics reject a FIFO before opening it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antnest-identity-log-fifo-"));
  const script = new URL("../e2e-stage3a.sh", import.meta.url);
  try {
    const fifo = join(directory, "diagnostic.fifo");
    const made = spawnSync("mkfifo", [fifo], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(made.error);
    assert.equal(made.status, 0, made.stderr);
    // Turn an attempted blocking open into an immediate observable failure.
    const preload = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const open=fs.openSync;fs.openSync=(path,...args)=>{if(String(path)===process.env.ANTNEST_E2E_IDENTITY_DIAGNOSTIC_LOG)throw Error('FIFO_OPEN_ATTEMPTED');return open(path,...args);};syncBuiltinESMExports();`;
    const result = spawnSync("/bin/sh", [script.pathname], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        ANTNEST_E2E_IDENTITY_DIAGNOSTIC_LOG: fifo,
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FIFO_OPEN_ATTEMPTED/);
    assert.match(result.stderr, /regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
