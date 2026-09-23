import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as development from "../../support/development-configuration.mjs";
import { durablePath } from "../../support/storage.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const agentId = "agent_" + "a".repeat(32);
const sessionId = "11111111-2222-4333-8444-555555555555";

for (const kind of ["ui-alias", "case-alias", "env-alias", "fresh"])
  test(`metadata fixture validates ${kind} output before building`, (t) => {
    const f = fixture(t),
      output = join(f.work, "browser-run"),
      marker = join(f.work, "build");
    if (kind !== "fresh") {
      mkdirSync(output);
      if (kind === "env-alias") mkdirSync(join(output, "success"));
      const leaf =
        kind === "ui-alias"
          ? "ui"
          : kind === "case-alias"
            ? "success"
            : "success/fixture.env";
      symlinkSync(join(f.work, ".cache", "missing"), join(output, leaf));
    }
    const vite = new URL(
      "../../../services/agent-ui/web/node_modules/vite/dist/node/index.js",
      import.meta.url,
    ).href;
    const source = `import fs from 'node:fs';export async function build(){fs.writeFileSync(${JSON.stringify(marker)},'build');throw new Error('fixture blocks build')}`;
    const preload = `import {registerHooks} from 'node:module';registerHooks({load(url,context,next){return url===${JSON.stringify(vite)}?{format:'module',source:${JSON.stringify(source)},shortCircuit:true}:next(url,context)}});`;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "data:text/javascript," + encodeURIComponent(preload),
        join(root, "tests/integration/development/metadata-browser-run.mjs"),
        "--output",
        output,
        "--case",
        "success",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(marker), kind === "fresh", result.stderr);
  });
function fixture(t) {
  const work = mkdtempSync(
    join(durablePath(tmpdir()), "antnest-metadata-contract-"),
  );
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const config = {
    gateway: "http://localhost:19000",
    envFile: join(work, "settings.env"),
    output: join(work, "out with spaces"),
    agentId,
    sessionId,
    workspaceUrl: `http://localhost:19000/workspace/?agent=${agentId}&session=${sessionId}`,
  };
  writeFileSync(
    config.envFile,
    "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
    { mode: 0o600 },
  );
  const file = join(work, "config.json"),
    marker = join(work, "launch");
  const save = () =>
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return {
    work,
    config,
    read() {
      save();
      return development.readDevelopmentConfiguration(file, "metadata-browser");
    },
    run() {
      save();
      const preload = `import {createRequire} from 'node:module';import fs from 'node:fs';const require=createRequire(${JSON.stringify(join(root, "services/agent-ui/web/package.json"))});require('playwright').chromium.launch=async()=>{fs.writeFileSync(${JSON.stringify(marker)},'launch');throw new Error('fixture blocks browser')};`;
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "data:text/javascript," + encodeURIComponent(preload),
          join(root, "tests/e2e/development/metadata-browser.mjs"),
          "--config",
          file,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      return { ...result, launched: existsSync(marker) };
    },
  };
}

test("metadata profile resolves historical fallback even when its Trace check failed", (t) => {
  const f = fixture(t);
  f.config.browserReport = join(f.work, "browser.json");
  writeFileSync(
    f.config.browserReport,
    JSON.stringify({
      status: "failed",
      agent_id: agentId,
      session_id: sessionId,
      workspace_url: f.config.workspaceUrl,
    }),
    { mode: 0o600 },
  );
  delete f.config.agentId;
  delete f.config.sessionId;
  delete f.config.workspaceUrl;
  const { config, settings } = f.read();
  assert.equal(config.agentId, agentId);
  assert.equal(config.sessionId, sessionId);
  assert.equal(settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG, "fixture");
  assert(!existsSync(config.output));
});

test("metadata explicit identities and URL override the previous report together", (t) => {
  const f = fixture(t);
  f.config.browserReport = join(f.work, "browser.json");
  writeFileSync(
    f.config.browserReport,
    JSON.stringify({
      agent_id: "old",
      session_id: "old",
      workspace_url: "https://example.invalid",
    }),
    { mode: 0o600 },
  );
  assert.equal(f.read().config.workspaceUrl, f.config.workspaceUrl);
});

test("metadata screenshots are exclusive private buffers with leaf checks", (t) => {
  const f = fixture(t);
  f.read();
  mkdirSync(f.config.output);
  const png = Buffer.from([137, 80, 78, 71]);
  development.writeDevelopmentBuffer(f.config, "metadata-desktop.png", png);
  assert.deepEqual(
    readFileSync(join(f.config.output, "metadata-desktop.png")),
    png,
  );
  assert.equal(
    statSync(join(f.config.output, "metadata-desktop.png")).mode & 0o777,
    0o600,
  );
  assert.throws(
    () =>
      development.writeDevelopmentBuffer(f.config, "metadata-desktop.png", png),
    /exist/,
  );
  symlinkSync(
    join(f.work, ".cache", "missing.png"),
    join(f.config.output, "capability-rejection.png"),
  );
  assert.throws(() =>
    development.writeDevelopmentBuffer(
      f.config,
      "capability-rejection.png",
      png,
    ),
  );
  assert.throws(() =>
    development.writeDevelopmentBuffer(f.config, "../escape.png", png),
  );
});

for (const kind of [
  "unknown",
  "credential",
  "agent",
  "session",
  "origin",
  "url-agent",
  "url-session",
  "duplicate",
  "preview",
  "path",
  "fragment",
  "cached-root",
  "env-directory",
  "report-directory",
  "report-existing",
  "screenshot-existing",
  "screenshot-alias",
  "durable",
])
  test(`metadata CLI checks ${kind} before browser launch`, (t) => {
    const f = fixture(t);
    switch (kind) {
      case "unknown":
        f.config.ignored = true;
        break;
      case "credential":
        writeFileSync(
          f.config.envFile,
          "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
        );
        break;
      case "agent":
        f.config.agentId = "invalid";
        break;
      case "session":
        f.config.sessionId = "invalid";
        break;
      case "origin":
        f.config.workspaceUrl = f.config.workspaceUrl.replace(
          "localhost:19000",
          "example.invalid",
        );
        break;
      case "url-agent":
        f.config.workspaceUrl = f.config.workspaceUrl.replace(
          agentId,
          "agent_" + "b".repeat(32),
        );
        break;
      case "url-session":
        f.config.workspaceUrl = f.config.workspaceUrl.replace(
          sessionId,
          "21111111-2222-4333-8444-555555555555",
        );
        break;
      case "duplicate":
        f.config.workspaceUrl += "&session=" + sessionId;
        break;
      case "preview":
        f.config.workspaceUrl += "&preview=1";
        break;
      case "path":
        f.config.workspaceUrl = f.config.workspaceUrl.replace(
          "/workspace/",
          "/admin/",
        );
        break;
      case "fragment":
        f.config.workspaceUrl += "#ignored";
        break;
      case "cached-root":
        f.config.output = join(f.work, ".cache", "missing");
        break;
      case "env-directory":
        f.config.envFile = f.work;
        break;
      case "report-directory":
        f.config.browserReport = f.work;
        break;
      case "report-existing":
      case "screenshot-existing":
      case "screenshot-alias": {
        mkdirSync(f.config.output);
        const name =
          kind === "report-existing"
            ? "metadata-report.json"
            : "metadata-desktop.png";
        if (kind === "screenshot-alias")
          symlinkSync(
            join(f.work, ".cache", "missing.png"),
            join(f.config.output, name),
          );
        else writeFileSync(join(f.config.output, name), "unchanged");
        break;
      }
    }
    const result = f.run();
    assert.equal(
      result.launched,
      kind === "durable",
      result.stdout + result.stderr,
    );
    if (kind.endsWith("-existing"))
      assert.equal(
        readFileSync(
          join(
            f.config.output,
            kind === "report-existing"
              ? "metadata-report.json"
              : "metadata-desktop.png",
          ),
          "utf8",
        ),
        "unchanged",
      );
    else if (!["screenshot-alias", "durable"].includes(kind))
      assert(
        !existsSync(f.config.output),
        "invalid configuration created output",
      );
  });
