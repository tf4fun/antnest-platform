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
  const work = mkdtempSync(join(tmpdir(), "antnest-cost-shell-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  for (const file of [
    "tests/e2e/e2e-session-cost.sh",
    "tests/e2e/acp-closeout/container-state.sh",
    "tests/support/storage.mjs",
    "tests/support/service-hosts.sh",
  ]) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    copyFileSync(join(root, file), join(work, file));
  }
  mkdirSync(join(work, "bin"));
  writeFileSync(
    join(work, "bin", "node"),
    '#!/bin/sh\nexec "$COST_NODE" "$COST_DISPATCH" "$@"\n',
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
appendFileSync(process.env.COST_CALLS,JSON.stringify({file,args,deadline_ms:Number(process.env.ANTNEST_E2E_DEADLINE_MS)})+"\\n");
if (file.endsWith("/deployment.mjs")) process.exit(args[0] === process.env.COST_FAIL_STAGE ? 1 : 0);
if (!file.endsWith("/docker.mjs")) process.exit(72);
if(args[0] === "inspect") {
 const format=args[args.indexOf("--format")+1];
 console.log(format === "{{.State.Running}}" ? "false" : format === "{{.State.ExitCode}}" ? process.env.COST_EXIT : format === "{{.State.Status}}:{{.State.ExitCode}}" ? "exited:"+process.env.COST_EXIT : "healthy");
} else if(args[0] === "logs") console.log('{"status":"fixture-client-log"}');
else if(args[0] === "rm" && process.env.COST_CLEANUP_FAIL === "true") process.exit(1);
else console.log("a".repeat(64));
`,
  );
  const result = spawnSync(
    "/bin/sh",
    [join(work, "tests/e2e/e2e-session-cost.sh")],
    {
      cwd: work,
      timeout: 10000,
      encoding: "utf8",
      env: {
        PATH: join(work, "bin") + ":/usr/bin:/bin",
        COST_NODE: process.execPath,
        COST_DISPATCH: dispatch,
        COST_CALLS: log,
        COST_EXIT: String(exitCode),
        COST_FAIL_STAGE: failStage,
        COST_CLEANUP_FAIL: String(cleanupFails),
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
  test(`Cost child shell preserves exit ${code} only after actual restart and four Runtime inspection`, (t) => {
    const result = launch(t, code);
    assert(
      result.calls[0].deadline_ms - Date.now() > (151 + 19) * 8000 + 300000,
      "Cost needs three samples per Trace plus business/cleanup budget",
    );
    assert.equal(result.status, code, result.stderr);
    assert.deepEqual(
      result.calls
        .filter((c) => c.file.endsWith("/deployment.mjs"))
        .map((c) => c.args[0]),
      ["inspect-stack", "create-harness", "restart-acp", "inspect-runtimes"],
    );
    assert(
      result.calls.findIndex((c) => c.args[0] === "start") <
        result.calls.findIndex((c) => c.args[0] === "restart-acp"),
    );
    assert.match(
      readFileSync(
        join(
          result.work,
          "artifacts/verification/acp-cost/antnest-stage3-e2e-1234/client.json",
        ),
        "utf8",
      ),
      /fixture-client-log/u,
    );
  });
for (const stage of ["restart-acp", "inspect-runtimes"])
  test(`Cost child shell rejects ${stage} failure even when client would exit 2`, (t) => {
    const result = launch(t, 2, stage);
    assert.equal(result.status, 1);
    const stages = result.calls
      .filter((c) => c.file.endsWith("/deployment.mjs"))
      .map((c) => c.args[0]);
    assert.equal(stages.at(-1), stage);
    assert(result.calls.some((c) => c.args[0] === "rm"));
  });
test("Cost child shell keeps a cleanup failure fatal after successful business", (t) => {
  assert.equal(launch(t, 0, "", true).status, 1);
});
