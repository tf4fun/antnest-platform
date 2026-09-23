import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const mask of ["077", "022"])
  test(`OIDC fixture public trust anchor is readable with umask ${mask}; key stays private`, async () => {
    const source = await readFile(
      new URL("../e2e-stage3a.sh", import.meta.url),
      "utf8",
    );
    const prepare = source.match(/^prepare_oidc\(\) \{[\s\S]+?\n\}/m)?.[0];
    assert(prepare);
    const directory = await mkdtemp(join(tmpdir(), "antnest-oidc-trust-"));
    try {
      const result = spawnSync(
        "/bin/sh",
        [
          "-c",
          `
        set -eu
        umask ${mask}
        compose() { :; }
        docker() { :; }
        ${prepare}
        prepare_oidc
      `,
        ],
        {
          env: {
            PATH: process.env.PATH,
            temporary_root: directory,
            COMPOSE_PROJECT_NAME: "fixture",
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        (await stat(join(directory, "certs/tls.crt"))).mode & 0o777,
        0o644,
      );
      assert.equal(
        (await stat(join(directory, "certs/tls.key"))).mode & 0o777,
        0o600,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
