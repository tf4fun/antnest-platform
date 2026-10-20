import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = await readFile(
  new URL("../e2e-stage3a.sh", import.meta.url),
  "utf8",
);
const start = source.indexOf("\ncleanup() {");
const end = source.indexOf("\ntrap cleanup EXIT", start);
assert(start > 0 && end > start);
const cleanup = source.slice(start, end);

for (const [entryStatus, failure, expectedStatus, finalized] of [
  [0, "", 0, true],
  [2, "", 2, true],
  [1, "", 1, false],
  [2, "down", 1, false],
  [2, "ps", 1, false],
  [2, "volume", 1, false],
  [2, "network", 1, false],
  [2, "completion", 1, true],
]) {
  test(`actual outer cleanup preserves ${entryStatus}, failure ${failure || "none"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "stage3-completion-"));
    try {
      const calls = join(directory, "calls");
      await mkdir(join(directory, "temporary"));
      await mkdir(join(directory, "auth/credentials"), { recursive: true });
      const script = `
set -eu
tool_profile=stage3-base
compose() {
  printf 'compose %s\\n' "$*" >> "$CALLS"
  [ "$1" != "$FAILURE" ]
}
docker() {
  printf 'docker %s\\n' "$*" >> "$CALLS"
  if [ "$1" = "$FAILURE" ]; then printf 'retained-resource\\n'; fi
}
node() {
  case "$1" in
    -e) printf 9999999999999 ;;
    tests/support/startup-failure-summary.mjs) return 0 ;;
    tests/e2e/stage3-base/completion.mjs)
      printf 'completion %s\\n' "$*" >> "$CALLS"
      [ ! -d "$credentials_root/credentials" ] || return 95
      [ ! -d "$temporary_root" ] || return 96
      [ "$FAILURE" != completion ] ;;
    *) printf 'unexpected node %s\\n' "$*" >&2; return 97 ;;
  esac
}
${cleanup}
trap cleanup EXIT
exit "$ENTRY_STATUS"
`;
      const result = spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: "/usr/bin:/bin",
          CALLS: calls,
          FAILURE: failure,
          ENTRY_STATUS: String(entryStatus),
          COMPOSE_PROJECT_NAME: "antnest-stage3-e2e-1",
          repository_root: directory,
          temporary_root: join(directory, "temporary"),
          credentials_root: join(directory, "auth"),
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      const rows = (await readFile(calls, "utf8")).trim().split("\n");
      const completions = rows.filter((line) => line.startsWith("completion "));
      assert.equal(completions.length, finalized ? 1 : 0, rows.join("\n"));
      if (finalized) {
        const position = rows.findIndex((line) =>
          line.startsWith("completion "),
        );
        const inspections = rows
          .map((line, index) => [line, index])
          .filter(([line]) =>
            /docker (ps|volume ls|network ls).*--filter label=/u.test(line),
          );
        assert(inspections.length >= 6);
        assert(inspections.every(([, index]) => index < position));
        assert.equal(rows.at(-1), completions[0]);
        assert.match(
          completions[0],
          new RegExp(`antnest-stage3-e2e-1 ${entryStatus}$`, "u"),
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
