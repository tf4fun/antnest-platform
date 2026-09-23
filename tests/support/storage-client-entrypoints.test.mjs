import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), "antnest-client-storage-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const marker = join(work, "attempts");
  const poolCode = `import fs from "node:fs"; export class Pool {constructor(){fs.appendFileSync(${JSON.stringify(marker)},"pool\\n");throw new Error("fixture blocks pool")}} export default {Pool};`;
  const preload = `
    import fs from 'node:fs'; import promises from 'node:fs/promises';
    import cp from 'node:child_process'; import {registerHooks,createRequire,syncBuiltinESMExports} from 'node:module';
    import {pathToFileURL} from 'node:url';
    const marker=${JSON.stringify(marker)}, require=createRequire(${JSON.stringify(join(root, "services/agent-acp-service/package.json"))});
    const block=(name)=>{fs.appendFileSync(marker,name+'\\n');throw new Error('fixture blocks '+name)};
    const pool=${JSON.stringify(poolCode)};
    const pkg=require('./package.json'), mappings={};
    for(const specifier of [...Object.keys({...pkg.dependencies,...pkg.devDependencies}),'@agentclientprotocol/sdk/experimental/v2','@agentclientprotocol/sdk/experimental/ws-client']) {
      try { mappings[specifier]=pathToFileURL(require.resolve(specifier)).href; } catch {}
    }
    mappings.ws=new URL("./wrapper.mjs",mappings.ws).href;
    registerHooks({resolve(specifier,context,next){
      if(specifier==='pg')return {url:'data:text/javascript,'+encodeURIComponent(pool),shortCircuit:true};
      if(mappings[specifier])return {url:mappings[specifier],shortCircuit:true};
      return next(specifier,context);
    }});
    cp.spawn=()=>block('docker');cp.execFile=()=>block('docker');cp.execFileSync=()=>block('docker');
    const read=promises.readFile;
    promises.readFile=(path,...args)=>String(path).endsWith('fixture-seed.json')?block('seed'):read(path,...args);
    syncBuiltinESMExports();globalThis.fetch=()=>block('fetch');
  `;
  return {
    work,
    run(args, directory) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "data:text/javascript," + encodeURIComponent(preload),
          ...args,
        ],
        {
          cwd: work,
          env: { ...process.env, ANTNEST_IDENTITY_EVIDENCE_DIR: directory },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.ifError(result.error);
      return {
        ...result,
        calls: existsSync(marker) ? readFileSync(marker, "utf8") : "",
      };
    },
  };
}

const entries = [
  "identity-closeout/access-client.mjs",
  "identity-closeout/agent-access-client.mjs",
  "acp-closeout/access-client.mjs",
];
for (const entry of entries)
  for (const kind of [
    "cached",
    "dangling",
    "durable",
    ...(entry === "identity-closeout/access-client.mjs"
      ? []
      : ["failure-leaf"]),
  ])
    test(`${entry} validates ${kind} evidence before effects`, (t) => {
      const f = fixture(t);
      let directory = join(f.work, "evidence");
      if (kind === "cached") directory = join(f.work, ".cache/evidence");
      if (kind === "dangling")
        symlinkSync(join(f.work, ".cache/missing"), directory);
      if (kind === "failure-leaf") {
        mkdirSync(directory);
        symlinkSync(
          join(f.work, ".cache/missing"),
          join(directory, "failure.private.txt"),
        );
      }
      const result = f.run(
        [
          join(root, "tests/e2e", entry),
          "http://fixture",
          "http://fixture",
          "fixture-seed.json",
        ],
        directory,
      );
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(
        result.stderr,
        /ERR_MODULE_NOT_FOUND|does not provide an export|RangeError|SyntaxError/,
      );
      if (kind === "durable") assert.notEqual(result.calls, "", result.stderr);
      else {
        assert.equal(result.calls, "", result.stderr);
        assert.match(result.stderr, /cache|ENOENT|regular file/);
      }
    });

for (const profile of [
  "foundation",
  "network",
  "shutdown",
  "health",
  "restore",
  "loss",
  "interrupted",
  "crash",
  "workspace",
  "workspace-browser",
])
  test(`Foundation ${profile} rejects evidence alias before Docker discovery`, (t) => {
    const f = fixture(t);
    mkdirSync(join(f.work, "artifacts/verification"), { recursive: true });
    symlinkSync(
      join(f.work, ".cache/missing"),
      join(f.work, "artifacts/verification/lifecycle-" + profile),
    );
    const code = `import {runFoundation} from ${JSON.stringify(new URL("../e2e/lifecycle-closeout/foundation-run.mjs", import.meta.url).href)};await runFoundation(${JSON.stringify(profile)});`;
    const result = f.run(["--input-type=module", "-e", code], undefined);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, "", result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /ERR_MODULE_NOT_FOUND|does not provide an export|RangeError|SyntaxError/,
    );
  });

test("Foundation durable output still reaches Docker discovery", (t) => {
  const f = fixture(t),
    code = `import {runFoundation} from ${JSON.stringify(new URL("../e2e/lifecycle-closeout/foundation-run.mjs", import.meta.url).href)};await runFoundation();`;
  const result = f.run(["--input-type=module", "-e", code], undefined);
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, "docker\n", result.stderr);
});
