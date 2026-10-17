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
  const work = mkdtempSync(join(tmpdir(), "antnest-permission-shell-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  for (const file of [
    "tests/e2e/e2e-tool-permissions.sh",
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
    join(
      work,
      "artifacts/verification/acp-permissions/antnest-stage3-e2e-1234",
    ),
    { recursive: true },
  );
  writeFileSync(
    join(work, "bin", "node"),
    '#!/bin/sh\nexec "$PERMISSION_NODE" "$PERMISSION_DISPATCH" "$@"\n',
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
appendFileSync(process.env.PERMISSION_CALLS,JSON.stringify({file,args,deadline_ms:Number(process.env.ANTNEST_E2E_DEADLINE_MS),observed_at:Date.now()})+"\\n");
if (file.endsWith("/deployment.mjs")) process.exit(args[0] === process.env.PERMISSION_FAIL_STAGE || (args[0] === "cleanup-harness" && process.env.PERMISSION_CLEANUP_FAIL === "true") ? 1 : 0);
if (!file.endsWith("/docker.mjs")) process.exit(72);
if(args[0] === "inspect") {
 const format=args[args.indexOf("--format")+1];
 console.log(format === "{{.State.Running}}" ? "false" : format === "{{.State.ExitCode}}" ? process.env.PERMISSION_EXIT : format === "{{.State.Status}}:{{.State.ExitCode}}" ? "exited:"+process.env.PERMISSION_EXIT : "healthy");
} else if(args[0] === "logs") console.log('{"status":"fixture-client-log"}');
else if(args[0] === "rm" && process.env.PERMISSION_CLEANUP_FAIL === "true") process.exit(1);
else console.log("a".repeat(64));
`,
  );
  const result = spawnSync(
    "/bin/sh",
    [join(work, "tests/e2e/e2e-tool-permissions.sh")],
    {
      cwd: work,
      timeout: 10000,
      encoding: "utf8",
      env: {
        PATH: join(work, "bin") + ":/usr/bin:/bin",
        PERMISSION_NODE: process.execPath,
        PERMISSION_DISPATCH: dispatch,
        PERMISSION_CALLS: log,
        PERMISSION_EXIT: String(exitCode),
        PERMISSION_FAIL_STAGE: failStage,
        PERMISSION_CLEANUP_FAIL: String(cleanupFails),
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
for (const code of [0, 2, 137])
  test(`Permission child shell preserves exit ${code} only after the host Runtime inspection or verified crash control`, (t) => {
    const result = launch(t, code);
    assert.equal(result.status, code, result.stderr);
    assert.deepEqual(
      result.calls
        .filter((c) => c.file.endsWith("/deployment.mjs"))
        .map((c) => c.args[0]),
      [
        "inspect-stack",
        "create-harness",
        "inspect-runtimes",
        "cleanup-harness",
      ],
    );
    assert(
      result.calls.findIndex((c) => c.args[0] === "start") <
        result.calls.findIndex((c) => c.args[0] === "inspect-runtimes"),
    );
    assert.match(
      readFileSync(
        join(
          result.work,
          "artifacts/verification/acp-permissions/antnest-stage3-e2e-1234/client.json",
        ),
        "utf8",
      ),
      /fixture-client-log/u,
    );
  });
for (const stage of ["inspect-stack", "create-harness", "inspect-runtimes"])
  test(`Permission child shell rejects ${stage} failure even when client would exit 2`, (t) => {
    const result = launch(t, 2, stage);
    assert.equal(result.status, 1);
    const stages = result.calls
      .filter((c) => c.file.endsWith("/deployment.mjs"))
      .map((c) => c.args[0]);
    assert.equal(stages.at(-1), "cleanup-harness");
    assert(stages.includes(stage));
    assert(!result.calls.some((c) => c.args[0] === "rm"));
  });
test("Permission child shell keeps a cleanup failure fatal after successful business", (t) => {
  assert.equal(launch(t, 0, "", true).status, 1);
});

test("Stage 3 Permission builds, selects and cleans this run's candidates with a fixed Compose overlay", () => {
  const shell = readFileSync(join(root, "tests/e2e/e2e-stage3a.sh"), "utf8");
  assert.match(
    shell,
    /elif \[ "\$tool_profile" = tool-permissions \]; then\n {2}export ANTNEST_ADMISSION_TAG="permission-\$ANTNEST_E2E_RUN_ID"\n {2}runtime_image="antnest\/antnest-runtime:\$ANTNEST_ADMISSION_TAG"/u,
  );
  for (const action of ["build", "cleanup"])
    assert(
      shell.includes(`node tests/e2e/acp-permissions/deployment.mjs ${action}`),
    );
  const compose = shell.slice(
    shell.indexOf(
      '  if [ "$tool_permissions" = true ]; then',
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
  assert(line.includes('"$tool_profile" = tool-permissions'));
  assert.match(shell, /compose up -d --wait --no-build --pull never/u);
});

test("Permission cleanup gets a separate bounded budget for both Agent deletion operations", (t) => {
  const result = launch(t, 0);
  const cleanup = result.calls.find((c) => c.args[0] === "cleanup-harness");
  assert(cleanup.deadline_ms - cleanup.observed_at >= 590000);
  assert(cleanup.deadline_ms - cleanup.observed_at <= 600000);
});
test("Permission host failure enters cleanup immediately without polling a still-running client", (t) => {
  const result = launch(t, 2, "inspect-runtimes");
  assert.equal(result.status, 1);
  const after = result.calls.slice(
    result.calls.findIndex((c) => c.args[0] === "inspect-runtimes") + 1,
  );
  assert.deepEqual(
    after.map((c) => c.args[0]),
    ["cleanup-harness"],
  );
});
