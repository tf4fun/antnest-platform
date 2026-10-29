import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectSuites, shards, suites } from "../../support/ci-changes.mjs";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("repeated readiness rounds and deletion reuse authenticated browser sessions", async () => {
  const client = await source("./client.mjs");
  const repeatedCommands = client.slice(
    client.indexOf("async function round("),
  );
  assert.doesNotMatch(
    repeatedCommands,
    /\/api\/session\/login/,
    "100 rounds must not exhaust the real password-login allowance",
  );
});

function serviceBlock(compose, name) {
  const match = compose.match(
    new RegExp(`^  ${name}:\\r?\\n((?:[ \\t]{4}[^\\n]*\\n|[ \\t]*\\n)*)`, "m"),
  );
  assert(match, `missing ${name} service`);
  return match[1];
}

test("readiness publication delay proxy uses the private ACP control upstream", async () => {
  const compose = await source("./compose.yaml");
  const proxy = serviceBlock(compose, "publication-delay-proxy");
  assert.match(proxy, /\bagent-acp-control:8081\b/);
  assert.match(proxy, /\bcontroller-acp\b/);
  assert.doesNotMatch(proxy, /^\s+ports\s*:/m);
});

test("readiness routes Controller publication through the proxy without extending its request budget", async () => {
  const compose = await source("./compose.yaml");
  const controller = serviceBlock(compose, "agent-controller");
  assert.match(
    controller,
    /ANTNEST_AGENT_ACP_CONTROL_URL:\s*["']?http:\/\/publication-delay-proxy:8080["']?\s*$/m,
  );
  assert.doesNotMatch(
    controller,
    /ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT\s*:/,
  );
  const base = await source("../../../compose.yaml");
  assert.match(
    base,
    /ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT:\s*\$\{ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT:-15s\}/,
  );
});

test("readiness shell entry invokes the owned profile runner", async () => {
  const shell = await source("../e2e-agent-readiness.sh");
  assert.match(shell, /\bnode\b[^\n]*agent-readiness\/run\.mjs/);
});

test("Stage 3 selects readiness as a separate disposable profile with its overlay", async () => {
  const shell = await source("../e2e-stage3a.sh");
  const flag = shell.match(
    /^([A-Za-z_][A-Za-z0-9_]*)=\$\{ANTNEST_E2E_AGENT_READINESS:-false\}/m,
  );
  assert(flag, "readiness flag must default to false");
  assert.match(shell, /tool_profile=["']?agent-readiness["']?(?:\s|$)/);
  assert.match(shell, /-f\s+tests\/e2e\/agent-readiness\/compose\.yaml/);
  const exclusive = shell.match(
    new RegExp(`if \\[ "\\$${flag[1]}" = true \\]; then([\\s\\S]*?)\\nfi`),
  );
  assert(exclusive, "readiness must have a dedicated admission guard");
  assert.match(exclusive[1], /for incompatible in/);
  assert.match(exclusive[1], /\bexit 1\b/);
  assert.match(shell, /sh "tests\/e2e\/e2e-\$\{tool_profile\}\.sh"/);
});

test("readiness has a 45 minute business deadline while other profiles retain 15 minutes", async () => {
  const shell = await source("../e2e-stage3a.sh");
  assert.match(shell, /ANTNEST_E2E_DEADLINE_MS/);
  assert.match(shell, /\b2700000\b/);
  assert.match(shell, /\b900000\b/);
});

test("Makefile exposes the opt-in readiness acceptance target", async () => {
  const makefile = await source("../../../Makefile");
  const target = makefile.match(
    /^e2e-agent-readiness:[^\n]*\n((?:\t[^\n]*(?:\n|$))+)/m,
  );
  assert(target, "missing e2e-agent-readiness target");
  assert.match(
    target[1],
    /ANTNEST_E2E_AGENT_READINESS=true[^\n]*\bsh tests\/e2e\/e2e-stage3a\.sh/,
  );
});

test("CI selects readiness sources into independent system and stress shards", () => {
  const suite = suites.find(
    (candidate) => candidate.id === "c-agent-readiness",
  );
  assert(suite, "missing readiness CI suite");
  assert.equal(suite.kind, "system");
  assert(
    suite.run.some(
      (command) =>
        command === "make e2e-agent-readiness" ||
        /ANTNEST_E2E_AGENT_READINESS=true[^\n]*\bsh tests\/e2e\/e2e-stage3a\.sh/.test(
          command,
        ),
    ),
    "CI must run the readiness acceptance entry",
  );
  for (const path of [
    "tests/e2e/agent-readiness/run.mjs",
    "tests/e2e/agent-readiness/compose.yaml",
    "tests/e2e/e2e-agent-readiness.sh",
  ]) {
    assert(
      selectSuites([path]).some((candidate) => candidate.id === suite.id),
      `${path} must select readiness acceptance`,
    );
  }
  const owners = shards.filter((shard) => shard.suites.includes(suite.id));
  assert.equal(owners.length, 1);
  assert.equal(owners[0].id, "c-agent-readiness");
  assert.deepEqual(owners[0].suites, [suite.id]);
  // Main runs three functional rounds; only nightly stress runs a hundred.
  const stress = suites.find(
    (candidate) => candidate.id === "stress-agent-readiness",
  );
  assert.equal(stress.kind, "stress");
  assert.deepEqual(stress.paths, suite.paths);
  assert.match(suite.run.at(-1), /ANTNEST_E2E_READINESS_ROUNDS=3 /u);
  assert.match(stress.run.at(-1), /ANTNEST_E2E_READINESS_ROUNDS=100 /u);
  assert.deepEqual(
    shards.find((shard) => shard.id === "stress-agent-readiness").suites,
    [stress.id],
  );
});

test("readiness round asserts the consumed publication is wire version 2", async () => {
  const runner = await source("run.mjs");
  assert.match(
    runner,
    /round\.publication\.schemaVersion[\s\S]{0,80}2/,
    "run.mjs must assert round.publication.schemaVersion === 2",
  );
});
