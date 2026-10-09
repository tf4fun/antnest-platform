import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const children = [
  ["managed-mcp", "managed-mcp"],
  ["rpc-response-loss", "rpc-response-loss"],
  ["stage3-base", "stage3-base"],
  ["acp-persistence", "acp-persistence"],
  ["acp-restart", "acp-restart"],
  ["acp-session", "identity-session"],
  ["identity-http", "identity-http"],
  ["agent-access", "identity-agent"],
  ["acp-closeout", "acp-closeout-normal"],
];
function launch(t, entry, evidenceRoot, cached, extra = {}, setup = () => {}) {
  const work = mkdtempSync(join(tmpdir(), "antnest-shell-storage-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  for (const file of [
    "tests/e2e/e2e-" + entry + ".sh",
    "tests/support/storage.mjs",
    "tests/support/public-development-secrets.sh",
    "tests/support/service-hosts.sh",
    ...(existsSync(join(root, "tests/support/verification/stage3-storage.mjs"))
      ? ["tests/support/verification/stage3-storage.mjs"]
      : []),
  ]) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    copyFileSync(join(root, file), join(work, file));
  }
  const bin = join(work, "bin");
  mkdirSync(bin);
  for (const command of ["docker", "mktemp", "curl", "openssl"])
    writeFileSync(
      join(bin, command),
      '#!/bin/sh\nprintf "%s\\n" "' +
        command +
        '" >> "$ENTRY_CALLS"\nexit 73\n',
      { mode: 0o700 },
    );
  writeFileSync(
    join(bin, "node"),
    '#!/bin/sh\ncase "$1" in -e|*tests/support/storage.mjs|*tests/support/verification/stage3-storage.mjs) exec "$ENTRY_NODE" "$@";; esac\nprintf "%s\\n" "node:$1" >> "$ENTRY_CALLS"\nexit 73\n',
    { mode: 0o700 },
  );
  mkdirSync(join(work, "artifacts/verification"), { recursive: true });
  if (cached) {
    mkdirSync(join(work, ".cache"));
    symlinkSync(
      join(work, ".cache"),
      join(work, "artifacts/verification", evidenceRoot),
    );
  }
  const marker = join(work, "calls");
  const env = {
    PATH: bin + ":/usr/bin:/bin",
    ENTRY_NODE: process.execPath,
    ENTRY_CALLS: marker,
    ANTNEST_E2E_DISPOSABLE: "true",
    ANTNEST_E2E_KEEP_STACK: "false",
    COMPOSE_PROJECT_NAME: "antnest-stage3-e2e-1234",
    ANTNEST_E2E_RUN_ID: "fixture-run",
    ANTNEST_IDENTITY_SUITE: "core",
    ...extra,
  };
  setup(work, env);
  const result = spawnSync(
    "/bin/sh",
    [join(work, "tests/e2e/e2e-" + entry + ".sh")],
    { cwd: work, env, encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(result.error);
  return {
    ...result,
    calls: existsSync(marker) ? readFileSync(marker, "utf8") : "",
  };
}

for (const [entry, directory] of children) {
  test(`${entry} rejects cached evidence before Docker or temporary setup`, (t) => {
    const result = launch(t, entry, directory, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable.*cache/i);
    assert.equal(result.calls, "");
  });
  test(`${entry} durable output still reaches its first dependency`, (t) => {
    const result = launch(t, entry, directory, false);
    assert.notEqual(result.calls, "");
    assert.doesNotMatch(result.stderr, /durable.*cache/i);
  });
  for (const alias of [false, true])
    test(`${entry} rejects cached temporary storage (alias=${alias}) before dependencies`, (t) => {
      const result = launch(t, entry, directory, false, {}, (work, env) => {
        mkdirSync(join(work, ".cache"));
        symlinkSync(join(work, ".cache"), join(work, "cache-alias"));
        env.TMPDIR = join(work, alias ? "cache-alias" : ".cache");
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /durable.*cache/i);
      assert.equal(result.calls, "");
    });
  test(`${entry} rejects an existing cached leaf before dependencies`, (t) => {
    const result = launch(t, entry, directory, false, {}, (work) => {
      const output = join(
        work,
        "artifacts/verification",
        directory,
        "antnest-stage3-e2e-1234",
      );
      mkdirSync(output, { recursive: true });
      mkdirSync(join(work, ".cache"));
      writeFileSync(join(work, ".cache/report.json"), "preserved");
      symlinkSync(
        join(work, ".cache/report.json"),
        join(output, "deployment.private.json"),
      );
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable.*cache/i);
    assert.equal(result.calls, "");
  });
}

for (const entry of ["stage1", "stage3a"])
  test(`${entry} rejects cached temporary storage before setup`, (t) => {
    const result = launch(t, entry, "unused", false, {}, (work, env) => {
      mkdirSync(join(work, ".cache"));
      env.TMPDIR = join(work, ".cache");
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable.*cache/i);
    assert.equal(result.calls, "");
  });

for (const directory of ["go-integration", "stage2-boundary"])
  test(`Stage 2 rejects ${directory} cache aliases before Docker`, (t) => {
    const result = launch(t, "stage2", directory, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable.*cache/i);
    assert.equal(result.calls, "");
  });

for (const [flag, directory] of [
  ["", "stage3-base"],
  ["MANAGED_MCP", "managed-mcp"],
  ["RPC_RESPONSE_LOSS", "rpc-response-loss"],
  ["ACP_PERSISTENCE", "acp-persistence"],
  ["ACP_RESTART", "acp-restart"],
  ["ACP_SESSION", "identity-session"],
  ["IDENTITY_CORE", "identity-http"],
  ["IDENTITY_ACCESS", "identity-http"],
  ["AGENT_ACCESS", "identity-agent"],
  ["ACP_CLOSEOUT", "acp-closeout-normal"],
])
  test(`Stage 3 rejects selected ${directory} evidence before network discovery (${flag || "default"})`, (t) => {
    const result = launch(
      t,
      "stage3a",
      directory,
      true,
      flag ? { ["ANTNEST_E2E_" + flag]: "true" } : {},
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable.*cache/i);
    assert.equal(result.calls, "");
  });

test("Stage 3 durable output still reaches network discovery", (t) => {
  const result = launch(t, "stage3a", "stage3-base", false);
  assert.match(result.calls, /network\.mjs/);
  assert.doesNotMatch(result.stderr, /durable.*cache/i);
});

// Evidence directories are created with umask 077 by the invoking user, so a
// container writing into one must run as that user. The service-auth UID is
// generated from the same invoking user (scripts/dev-service-tokens.mjs).
test("containers writing private evidence run as the evidence owner", () => {
  const directory = join(root, "tests/e2e");
  const commands = [];
  for (const name of readdirSync(directory).filter((n) => n.endsWith(".sh"))) {
    const lines = readFileSync(join(directory, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/docker(?:_cmd)? (?:create|run) /u.test(lines[i])) continue;
      let command = lines[i];
      while (command.endsWith("\\") && i + 1 < lines.length)
        command = command.slice(0, -1) + lines[++i];
      if (command.includes('-v "$evidence:/evidence"'))
        commands.push([name, command]);
    }
  }
  assert(commands.length >= 3, "evidence-writing clients not found");
  for (const [name, command] of commands)
    assert(
      command.includes('--user "$(id -u):$(id -g)"') ||
        command.includes(
          '--user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID"',
        ),
      name,
    );
});

const dependencyEntries = [
  [
    "scripts/postgres-entrypoint.sh",
    "POSTGRES_PASSWORD",
    "ANTNEST_POSTGRES_ADMIN_PASSWORD",
  ],
  [
    "scripts/temporal/init-databases.sh",
    "PGPASSWORD",
    "ANTNEST_POSTGRES_ADMIN_PASSWORD",
  ],
  [
    "scripts/temporal/init-databases.sh",
    "ANTNEST_TEMPORAL_POSTGRES_PASSWORD",
    "ANTNEST_TEMPORAL_POSTGRES_PASSWORD",
  ],
  [
    "scripts/temporal/setup-schema.sh",
    "SQL_PASSWORD",
    "ANTNEST_TEMPORAL_POSTGRES_PASSWORD",
  ],
  [
    "scripts/temporal/entrypoint.sh",
    "POSTGRES_PWD",
    "ANTNEST_TEMPORAL_POSTGRES_PASSWORD",
  ],
  [
    "scripts/skill-registry/init-database.sh",
    "PGPASSWORD",
    "ANTNEST_POSTGRES_ADMIN_PASSWORD",
  ],
];
function launchDependency(t, entry, extra) {
  const work = mkdtempSync(join(tmpdir(), "antnest-dependency-admission-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  copyFileSync(
    join(root, "scripts/development-secret-admission.sh"),
    join(work, "development-secret-admission.sh"),
  );
  writeFileSync(
    join(work, "entry.sh"),
    readFileSync(join(root, entry), "utf8")
      .replaceAll("/scripts/", work + "/")
      .replaceAll("/etc/temporal/", work + "/"),
  );
  const bin = join(work, "bin");
  mkdirSync(bin);
  const stub =
    '#!/bin/sh\nprintf "%s\\n" "$0" "$@" >> "$ENTRY_CALLS"\ncat >/dev/null\n';
  for (const command of ["docker-entrypoint.sh", "psql", "temporal-sql-tool"])
    writeFileSync(join(bin, command), stub, { mode: 0o700 });
  writeFileSync(join(work, "entrypoint-upstream.sh"), stub, { mode: 0o700 });
  const marker = join(work, "calls");
  const env = {
    PATH: bin + ":/usr/bin:/bin",
    ENTRY_CALLS: marker,
    POSTGRES_PASSWORD: "private-admin",
    PGPASSWORD: "private-admin",
    ANTNEST_POSTGRES_ADMIN_PASSWORD: "unused-private-admin",
    ANTNEST_TEMPORAL_POSTGRES_PASSWORD: "private-temporal",
    SQL_PASSWORD: "private-temporal",
    POSTGRES_PWD: "private-temporal",
    ANTNEST_SKILL_REGISTRY_POSTGRES_PASSWORD: "private-registry",
    ...extra,
  };
  const result = spawnSync(
    "sh",
    [join(work, "entry.sh"), "postgres", "-c", "test=1"],
    {
      cwd: work,
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(result.error);
  return {
    ...result,
    calls: existsSync(marker) ? readFileSync(marker, "utf8") : "",
  };
}

for (const [entry, consumed, variable] of dependencyEntries) {
  test(`${entry} rejects published ${consumed} before clients, credentials or listeners`, (t) => {
    const value = "antnest-postgres-dev";
    const result = launchDependency(t, entry, { [consumed]: value });
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes(variable));
    assert(!(result.stdout + result.stderr).includes(value));
    assert.equal(result.calls, "");
  });
  test(`${entry} admits private ${consumed} silently and forwards server arguments`, (t) => {
    const result = launchDependency(t, entry, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    assert.notEqual(result.calls, "");
    if (entry.endsWith("entrypoint.sh"))
      assert(result.calls.endsWith("\npostgres\n-c\ntest=1\n"));
  });
  test(`${entry} explicitly admits published ${consumed} with one sanitized WARN`, (t) => {
    const value = "antnest-temporal-dev";
    const result = launchDependency(t, entry, {
      [consumed]: value,
      ANTNEST_ALLOW_PUBLIC_DEV_SECRETS: "true",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.calls, "");
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^WARN /u);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert(result.stderr.includes(variable));
    assert(!result.stderr.includes(value));
  });
}
