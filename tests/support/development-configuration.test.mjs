import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as development from "./development-configuration.mjs";
import {
  readDevelopmentConfiguration,
  writeDevelopmentJSON,
} from "./development-configuration.mjs";

const agentId = "agent_" + "a".repeat(32);
const sessionId = "11111111-2222-4333-8444-555555555555";
function fixture(t, profile = "agent-state") {
  const root = mkdtempSync(join(tmpdir(), "antnest-development-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envFile = join(root, "settings.env"),
    secretFile = join(root, "secret.env");
  writeFileSync(
    envFile,
    "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
  );
  writeFileSync(secretFile, "API_KEY=fixture-secret\n");
  const config = {
    output: join(root, "out"),
    ...(profile === "agent-state"
      ? { gateway: "http://localhost:19000", envFile, agentId }
      : profile === "trace-review"
        ? {
            jaeger: "http://localhost:16686",
            envFile,
            secretFile,
            sessionId,
            expectedTraceCount: 3,
            minRuntimeTraces: 2,
          }
        : { jaeger: "http://localhost:16686", rejectedSessionId: sessionId }),
  };
  const file = join(root, "config.json");
  return {
    root,
    config,
    read() {
      writeFileSync(file, JSON.stringify(config));
      return readDevelopmentConfiguration(file, profile);
    },
  };
}

test("agent settings preserve explicit report basename and browser identity fallback", (t) => {
  const f = fixture(t);
  f.config.browserReport = join(f.root, "browser.json");
  writeFileSync(f.config.browserReport, JSON.stringify({ agent_id: agentId }));
  delete f.config.agentId;
  f.config.reportBasename = "agent-before";
  const loaded = f.read();
  assert.equal(loaded.config.agentId, agentId);
  mkdirSync(f.config.output);
  writeDevelopmentJSON(loaded.config, "agent-before.json", { passed: true });
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.config.output, "agent-before.json"))),
    { passed: true },
  );
  assert.throws(
    () => writeDevelopmentJSON(loaded.config, "agent-before.json", {}),
    /exist/i,
  );
});

for (const profile of ["agent-state", "trace-review", "rejection-trace"]) {
  test(`${profile} requires explicit valid identities and HTTP origin`, (t) => {
    const f = fixture(t, profile),
      key =
        profile === "agent-state"
          ? "agentId"
          : profile === "trace-review"
            ? "sessionId"
            : "rejectedSessionId";
    const original = f.config[key];
    for (const invalid of [undefined, "", "../wrong", 123]) {
      f.config[key] = invalid;
      assert.throws(() => f.read());
    }
    f.config[key] = original;
    const origin = profile === "agent-state" ? "gateway" : "jaeger";
    for (const invalid of [
      "file:///tmp",
      "http://user:pass@localhost",
      "http://localhost/path",
      "http://localhost/?token=value",
    ]) {
      f.config[origin] = invalid;
      assert.throws(() => f.read());
    }
  });
  test(`${profile} rejects cached output leaves before execution`, (t) => {
    const f = fixture(t, profile);
    mkdirSync(f.config.output);
    const cache = join(f.root, ".cache");
    mkdirSync(cache);
    const name =
      profile === "agent-state"
        ? "agent-state.json"
        : profile === "trace-review"
          ? "trace-review-3.json"
          : "rejection-trace-review.json";
    symlinkSync(join(cache, "missing.json"), join(f.config.output, name));
    assert.throws(() => f.read());
  });
  test(`${profile} rejects existing report and unknown configuration fields`, (t) => {
    const f = fixture(t, profile);
    f.config.ignored = true;
    assert.throws(() => f.read(), /unknown/i);
    delete f.config.ignored;
    mkdirSync(f.config.output);
    const name =
      profile === "agent-state"
        ? "agent-state.json"
        : profile === "trace-review"
          ? "traces-3.json"
          : "rejection-trace.json";
    writeFileSync(join(f.config.output, name), "{}");
    assert.throws(() => f.read(), /exist/i);
  });
}

test("trace count respects the query limit and Runtime minimum", (t) => {
  const f = fixture(t, "trace-review");
  for (const [count, minimum] of [
    [21, 2],
    [1, 1],
    [3, 4],
    [3, 1],
    ["3", 2],
  ]) {
    f.config.expectedTraceCount = count;
    f.config.minRuntimeTraces = minimum;
    assert.throws(() => f.read());
  }
});

test("credentials and report inputs are read and validated in preflight", (t) => {
  const f = fixture(t);
  writeFileSync(
    f.config.envFile,
    "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
  );
  assert.throws(() => f.read(), /BOOTSTRAP/);
  f.config.reportBasename = "../escape";
  assert.throws(() => f.read());
});

test("writer rechecks output leaf aliases introduced after preflight", (t) => {
  const f = fixture(t);
  const loaded = f.read();
  mkdirSync(f.config.output);
  mkdirSync(join(f.root, ".cache"));
  symlinkSync(
    join(f.root, ".cache/missing.json"),
    join(f.config.output, "agent-state.json"),
  );
  assert.throws(() =>
    writeDevelopmentJSON(loaded.config, "agent-state.json", {}),
  );
});

test("explicit identity takes precedence over a report fallback", (t) => {
  const f = fixture(t);
  f.config.browserReport = join(f.root, "browser.json");
  writeFileSync(
    f.config.browserReport,
    JSON.stringify({ agent_id: "agent_" + "b".repeat(32) }),
  );
  assert.equal(f.read().config.agentId, agentId);
});

test("FIFO configuration rejects before a blocking read", (t) => {
  const f = fixture(t),
    fifo = join(f.root, "config.fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const source = `import { readDevelopmentConfiguration } from ${JSON.stringify(new URL("./development-configuration.mjs", import.meta.url).href)}; readDevelopmentConfiguration(process.argv[1], 'agent-state');`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, fifo],
    { encoding: "utf8", timeout: 1000 },
  );
  assert.equal(result.status, 1, "must reject, not time out");
  assert.match(result.stderr, /regular file/);
});

function replayFixture(t) {
  const f = fixture(t);
  f.config.jaeger = "http://localhost:16686";
  f.config.sessionId = sessionId;
  f.config.database = {
    container: "fixture-postgres",
    user: "fixture_admin",
    name: "fixture_acp",
  };
  const file = join(f.root, "replay-config.json");
  f.read = () => {
    writeFileSync(file, JSON.stringify(f.config));
    return readDevelopmentConfiguration(file, "replay");
  };
  return f;
}

test("replay validates both identities, database and all fixed output leaves", (t) => {
  const f = replayFixture(t);
  assert.equal(f.read().config.sessionId, sessionId);
  for (const key of ["container", "user", "name"]) {
    const saved = f.config.database[key];
    f.config.database[key] = "../bad";
    assert.throws(() => f.read());
    f.config.database[key] = saved;
  }
  mkdirSync(f.config.output);
  for (const name of [
    "replay-updates.private.json",
    "replay-trace.private.json",
    "replay-report.json",
  ]) {
    writeFileSync(join(f.config.output, name), "{}");
    assert.throws(() => f.read());
    rmSync(join(f.config.output, name));
  }
});

test("replay requires login fields and falls back to a browser report", (t) => {
  const f = replayFixture(t);
  f.config.browserReport = join(f.root, "browser.json");
  writeFileSync(
    f.config.browserReport,
    JSON.stringify({ agent_id: agentId, session_id: sessionId }),
  );
  delete f.config.agentId;
  delete f.config.sessionId;
  assert.equal(f.read().config.agentId, agentId);
  writeFileSync(f.config.envFile, "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture\n");
  assert.throws(() => f.read(), /BOOTSTRAP/);
});

test("polling writer updates its own raw Trace without replacing other evidence", (t) => {
  const f = fixture(t);
  mkdirSync(f.config.output);
  const write = development.createDevelopmentWriter(f.config, ["trace.json"]);
  write("trace.json", { spans: [1] });
  write("trace.json", { spans: [1, 2] });
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.config.output, "trace.json"))),
    { spans: [1, 2] },
  );
  assert.equal(
    readFileSync(join(f.config.output, "trace.json"), "utf8").includes("1"),
    true,
  );
  write("final.json", { passed: true });
  assert.throws(() => write("final.json", {}));
  const other = development.createDevelopmentWriter(f.config, ["trace.json"]);
  assert.throws(() => other("trace.json", {}));
});

test("polling writer rejects a raw Trace replaced by a cache alias", (t) => {
  const f = fixture(t);
  mkdirSync(f.config.output);
  mkdirSync(join(f.root, ".cache"));
  const write = development.createDevelopmentWriter(f.config, ["trace.json"]);
  write("trace.json", {});
  rmSync(join(f.config.output, "trace.json"));
  symlinkSync(
    join(f.root, ".cache", "missing.json"),
    join(f.config.output, "trace.json"),
  );
  assert.throws(() => write("trace.json", { spans: [] }));
});
