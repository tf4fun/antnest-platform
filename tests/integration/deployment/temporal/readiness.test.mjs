import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL(
  "../../../../scripts/temporal/readiness.sh",
  import.meta.url,
);
async function probe(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "temporal-readiness-"));
  try {
    await writeFile(
      join(dir, "wget"),
      `#!/bin/sh
printf 'http %s\\n' "$*" >> "$PROBE_LOG"
exit "\${FRONTEND_EXIT:-0}"
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(dir, "tdbg"),
      `#!/bin/sh
printf 'gossip %s\\n' "$*" >> "$PROBE_LOG"
for role; do :; done
test "$role" != "\${FAILED_ROLE:-}" || exit 1
count=1
test "$role" != "\${EMPTY_ROLE:-}" || count=0
test "$role" != "\${MALFORMED_ROLE:-}" || count='"1"'
test "$role" != "\${MISSING_ROLE:-}" || exit 0
printf '[\\n  {\\n    "role": "%s",\\n    "member_count": %s,\\n    "members": []\\n  }\\n]\\n' "$role" "$count"
`,
      { mode: 0o700 },
    );
    const log = join(dir, "calls");
    await writeFile(log, "");
    const result = spawnSync("sh", [script.pathname], {
      env: {
        ...process.env,
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        PROBE_LOG: log,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: (await readFile(log, "utf8")).trim().split("\n").filter(Boolean),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("ready requires initialized frontend and all three live service rings", async () => {
  const result = await probe();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.length, 4);
  assert.match(
    result.calls[0],
    /-T 2.*127\.0\.0\.1:7243\/api\/v1\/system-info/,
  );
  for (const [i, role] of ["frontend", "history", "matching"].entries())
    assert.match(
      result.calls[i + 1],
      new RegExp(
        `--address 127.0.0.1:7233 --context-timeout 2 membership list-gossip --role ${role}$`,
      ),
    );
});
test("open port with uninitialized frontend cannot pass readiness", async () => {
  const result = await probe({ FRONTEND_EXIT: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 1);
});
for (const role of ["frontend", "history", "matching"])
  for (const fault of [
    "FAILED_ROLE",
    "EMPTY_ROLE",
    "MISSING_ROLE",
    "MALFORMED_ROLE",
  ])
    test(`readiness rejects ${role} ${fault}`, async () => {
      const result = await probe({ [fault]: role });
      assert.notEqual(result.status, 0);
      assert(result.calls.length >= 2, result.output);
    });
