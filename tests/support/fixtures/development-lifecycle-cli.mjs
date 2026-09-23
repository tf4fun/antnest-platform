import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../run-command.mjs";
import { lifecycleServer } from "./development-lifecycle-server.mjs";
import { recoveryInspection } from "./development-recovery.mjs";

export async function lifecycleCliFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "antnest-lifecycle-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = await lifecycleServer();
  t.after(() => f.close());
  f.root = root;
  f.scope = "fixture-lifecycle";
  f.inspection = recoveryInspection();
  f.inspection.Name = "/antnest-runtime-" + f.temporaryId;
  f.inspection.Config.Labels["io.antnest.agent-id"] = f.temporaryId;
  f.inspection.Config.Labels["io.antnest.runtime-controller-scope"] = f.scope;
  f.inspection.Mounts[0].Name = "antnest-workspace-" + f.temporaryId;
  f.marker = "lifecycle fixture marker";
  const state = join(root, "docker.json"),
    calls = join(root, "calls.jsonl"),
    bin = join(root, "bin");
  mkdirSync(bin);
  f.save = () =>
    writeFileSync(
      state,
      JSON.stringify({
        inspection: f.inspection,
        marker: f.marker,
        residue: f.residue ?? "",
      }),
    );
  f.transition = (kind) => {
    if (kind === "rebuild") f.inspection.Id = "2".repeat(64);
    f.save();
  };
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nimport {readFileSync,appendFileSync} from 'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');const s=JSON.parse(readFileSync(${JSON.stringify(state)}));if(args[0]==='inspect')process.stdout.write(JSON.stringify([s.inspection]));else if(args[0]==='exec'){if(args.includes('cat') || args.some(x=>x.includes('cat --')))process.stdout.write(s.marker);}else if(args[0]==='ps'||args[0]==='volume')process.stdout.write(s.residue);else process.exitCode=79;\n`,
    { mode: 0o700 },
  );
  const envFile = join(root, "settings.env"),
    secretFile = join(root, "secret.env");
  writeFileSync(
    envFile,
    "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
  );
  writeFileSync(secretFile, "API_KEY=fixture-secret\n");
  f.config = {
    gateway: f.origin,
    jaeger: f.origin,
    envFile,
    secretFile,
    output: join(root, "out"),
    retainedAgentId: f.retainedId,
    fixtureName: "lifecycle-fixture",
    workspaceFile: "/workspace/marker.txt",
    workspaceMarker: f.marker,
    runtimeControllerScope: f.scope,
  };
  f.read = (name) => JSON.parse(readFileSync(join(f.config.output, name)));
  f.dockerCalls = () =>
    existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  f.run = async () => {
    f.save();
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify(f.config));
    // Contract fixture shortens only polling waits; all attempts, samples and real HTTP remain.
    const preload =
      "import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';const delay=timers.setTimeout;timers.setTimeout=(ms,...args)=>delay(Math.min(ms,1),...args);syncBuiltinESMExports();";
    const result = await runCommand({
      output: join(root, "runner"),
      name: "lifecycle",
      timeoutMs: 15000,
      graceMs: 1000,
      command: [
        process.execPath,
        "--import",
        "data:text/javascript," + encodeURIComponent(f.preload ?? preload),
        f.entry ?? "tests/e2e/development/lifecycle.mjs",
        "--config",
        file,
      ],
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    });
    return {
      ...result,
      log: readFileSync(join(root, "runner/lifecycle.log"), "utf8"),
    };
  };
  return f;
}
