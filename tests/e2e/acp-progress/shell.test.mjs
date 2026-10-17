import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
function launch(t, exitCode, failStage = "", cleanupFails = false) {
  const work = mkdtempSync(join(tmpdir(), "antnest-progress-shell-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  for (const file of [
    "tests/e2e/e2e-tool-progress.sh",
    "tests/e2e/acp-closeout/container-state.sh",
    "tests/support/storage.mjs",
    "tests/support/service-hosts.sh",
  ]) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    copyFileSync(join(root, file), join(work, file));
  }
  mkdirSync(join(work, "bin"));
  // The real parent build creates this run's evidence root before the child.
  mkdirSync(
    join(work, "artifacts/verification/acp-progress/antnest-stage3-e2e-1234"),
    { recursive: true },
  );
  writeFileSync(
    join(work, "bin", "node"),
    '#!/bin/sh\nexec "$PROGRESS_NODE" "$PROGRESS_DISPATCH" "$@"\n',
    { mode: 0o700 },
  );
  const dispatch = join(work, "dispatch.mjs"),
    log = join(work, "calls.jsonl");
  writeFileSync(
    dispatch,
    `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [file,...args] = process.argv.slice(2);
if (file === "-e" || file.endsWith("/storage.mjs")) {
 const result=spawnSync(process.execPath,[file,...args],{stdio:"inherit"});process.exit(result.status ?? 1);
}
appendFileSync(process.env.PROGRESS_CALLS,JSON.stringify({file,args,deadline_ms:Number(process.env.ANTNEST_E2E_DEADLINE_MS)})+"\\n");
if (file.endsWith("/deployment.mjs")) process.exit(args[0] === process.env.PROGRESS_FAIL_STAGE || (args[0] === "cleanup-harness" && process.env.PROGRESS_CLEANUP_FAIL === "true") ? 1 : 0);
if (!file.endsWith("/docker.mjs")) process.exit(72);
if(args[0] === "inspect") {
 const format=args[args.indexOf("--format")+1];
 console.log(format === "{{.State.Running}}" ? "false" : format === "{{.State.ExitCode}}" ? process.env.PROGRESS_EXIT : format === "{{.State.Status}}:{{.State.ExitCode}}" ? "exited:"+process.env.PROGRESS_EXIT : "healthy");
} else if(args[0] === "logs") console.log('{"status":"fixture-client-log"}');
else if(args[0] === "rm" && process.env.PROGRESS_CLEANUP_FAIL === "true") process.exit(1);
else console.log("a".repeat(64));
`,
  );
  const result = spawnSync(
    "/bin/sh",
    [join(work, "tests/e2e/e2e-tool-progress.sh")],
    {
      cwd: work,
      timeout: 10000,
      encoding: "utf8",
      env: {
        PATH: join(work, "bin") + ":/usr/bin:/bin",
        PROGRESS_NODE: process.execPath,
        PROGRESS_DISPATCH: dispatch,
        PROGRESS_CALLS: log,
        PROGRESS_EXIT: String(exitCode),
        PROGRESS_FAIL_STAGE: failStage,
        PROGRESS_CLEANUP_FAIL: String(cleanupFails),
        ANTNEST_E2E_DISPOSABLE: "true",
        COMPOSE_PROJECT_NAME: "antnest-stage3-e2e-1234",
        ANTNEST_SERVICE_NETWORK_PREFIX: "10.242.187",
      },
    },
  );
  assert.ifError(result.error);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  return { ...result, calls, work };
}
for (const code of [0, 2])
  test(`Progress child shell preserves exit ${code} only after the host gate and final Runtime ACK`, (t) => {
    const result = launch(t, code);
    assert.equal(result.status, code, result.stderr);
    assert.deepEqual(
      result.calls
        .filter((c) => c.file.endsWith("/deployment.mjs"))
        .map((c) => c.args[0]),
      ["inspect-stack", "create-harness", "serve-gates", "cleanup-harness"],
    );
    assert(
      result.calls.findIndex((c) => c.args[0] === "start") <
        result.calls.findIndex((c) => c.args[0] === "serve-gates"),
    );
    assert.match(
      readFileSync(
        join(
          result.work,
          "artifacts/verification/acp-progress/antnest-stage3-e2e-1234/client.json",
        ),
        "utf8",
      ),
      /fixture-client-log/u,
    );
  });
for (const stage of ["inspect-stack", "create-harness", "serve-gates"])
  test(`Progress child shell rejects ${stage} failure even when client would exit 2`, (t) => {
    const result = launch(t, 2, stage);
    assert.equal(result.status, 1);
    const stages = result.calls
      .filter((c) => c.file.endsWith("/deployment.mjs"))
      .map((c) => c.args[0]);
    assert.equal(stages.at(-1), "cleanup-harness");
    assert(stages.includes(stage));
    assert(!result.calls.some((c) => c.args[0] === "rm"));
  });
test("Progress child shell keeps a cleanup failure fatal after successful business", (t) => {
  assert.equal(launch(t, 0, "", true).status, 1);
});

test("Stage 3 Progress builds, selects and cleans this run's candidates with a fixed Compose overlay", () => {
  const shell = readFileSync(join(root, "tests/e2e/e2e-stage3a.sh"), "utf8");
  assert.match(
    shell,
    /elif \[ "\$tool_profile" = tool-progress \]; then\n {2}export ANTNEST_ADMISSION_TAG="progress-\$ANTNEST_E2E_RUN_ID"\n {2}runtime_image="antnest\/antnest-runtime:\$ANTNEST_ADMISSION_TAG"/u,
  );
  for (const action of ["build", "cleanup"])
    assert(
      shell.includes(`node tests/e2e/acp-progress/deployment.mjs ${action}`),
    );
  const compose = shell.slice(
    shell.indexOf(
      '  if [ "$tool_progress" = true ]; then',
      shell.indexOf("compose()"),
    ),
  );
  assert.match(compose.split("    return")[0], /compose\.admission\.yaml/u);
  const line = shell
    .split("\n")
    .find(
      (line) =>
        line.includes('"$tool_profile" = acp-session') &&
        line.includes('"$tool_profile" = file-observations'),
    );
  assert(line.includes('"$tool_profile" = tool-progress'));
  assert.match(shell, /compose up -d --wait --no-build --pull never/u);
});
