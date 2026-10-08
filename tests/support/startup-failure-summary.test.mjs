import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  credentialCanaries,
  failedContainers,
  summarizeStartupFailure,
} from "./startup-failure-summary.mjs";

const container = (service, state, extra = {}) => ({
  Id: `${service}-id`,
  Config: { Labels: { "com.docker.compose.service": service } },
  State: {
    Status: "exited",
    ExitCode: 0,
    OOMKilled: false,
    ...state,
  },
  ...extra,
});

test("only failed, OOM-killed and unhealthy containers are summarized", () => {
  const selected = failedContainers([
    container("postgres-init", { ExitCode: 0 }),
    container("agent-controller", { ExitCode: 1 }),
    container("identity-service", { Status: "running" }),
    container("runtime-controller", {
      Status: "running",
      Health: { Status: "unhealthy" },
    }),
    container("runtime-egress", { Status: "restarting", ExitCode: 2 }),
    container("stage3-model", { ExitCode: 0, OOMKilled: true }),
  ]).map((entry) => entry.Config.Labels["com.docker.compose.service"]);
  assert.deepEqual(selected, [
    "agent-controller",
    "runtime-controller",
    "runtime-egress",
    "stage3-model",
  ]);
});

test("a failed service reports its state and ERROR records only", () => {
  const logs = [
    '{"level":"INFO","msg":"starting"}',
    '{"level":"ERROR","msg":"load configuration","error":{"code":"config_invalid"}}',
    '{"level":"error","message":"database unavailable","error_code":"db_unreachable"}',
    '{"level":50,"msg":"listener closed"}',
    '{"level":"WARN","msg":"slow"}',
    "plain progress text",
  ].join("\n");
  assert.deepEqual(
    summarizeStartupFailure(
      container("agent-controller", { ExitCode: 1, OOMKilled: false }),
      logs,
      [],
    ),
    {
      service: "agent-controller",
      status: "exited",
      exit_code: 1,
      oom_killed: false,
      health: null,
      errors: [
        { msg: "load configuration", code: "config_invalid" },
        { msg: "database unavailable", code: "db_unreachable" },
        { msg: "listener closed", code: null },
      ],
      crash: [],
    },
  );
});

test("a crash before structured logging reports its first line", () => {
  const summary = summarizeStartupFailure(
    container("runtime-controller", { ExitCode: 2 }),
    [
      "panic: runtime error: invalid memory address",
      "goroutine 1 [running]:",
      "main.main()",
      "TypeError: Cannot read properties of undefined (reading 'port')",
      "    at file:///app/dist/main.js:1:1",
    ].join("\n"),
    [],
  );
  assert.deepEqual(summary.crash, [
    "panic: runtime error: invalid memory address",
    "TypeError: Cannot read properties of undefined (reading 'port')",
  ]);
  assert.deepEqual(summary.errors, []);
});

test("fields carrying a credential are withheld rather than printed", () => {
  const secret = "placeholder-credential-xxxxxxxx";
  const summary = summarizeStartupFailure(
    container("identity-service", { ExitCode: 1 }),
    [
      JSON.stringify({
        level: "ERROR",
        msg: `bad token ${secret}`,
        error: { code: "x" },
      }),
      JSON.stringify({
        level: "ERROR",
        msg: "rejected",
        error: { code: encodeURIComponent(`${secret}/`) },
      }),
      JSON.stringify({ level: "ERROR", msg: "leaked ant_api_abcdef" }),
      `Error: connect with ${secret}`,
    ].join("\n"),
    [secret],
  );
  assert.deepEqual(summary.errors, [
    { msg: "[withheld: credential]", code: "x" },
    { msg: "rejected", code: "[withheld: credential]" },
    { msg: "[withheld: credential]", code: null },
  ]);
  assert.deepEqual(summary.crash, ["[withheld: credential]"]);
  assert(!JSON.stringify(summary).includes(secret));
});

test("long fields and long record lists are bounded", () => {
  const logs = Array.from({ length: 40 }, (_, index) =>
    JSON.stringify({ level: "ERROR", msg: `${index}-${"x".repeat(500)}` }),
  ).join("\n");
  const summary = summarizeStartupFailure(
    container("agent-acp-service", { ExitCode: 1 }),
    logs,
    [],
  );
  assert.equal(summary.errors.length, 20);
  assert.equal(summary.errors_omitted, 20);
  assert(summary.errors.every(({ msg }) => msg.length <= 200));
  assert(summary.errors.at(-1).msg.startsWith("39-"));
});

test("credential canaries cover provisioned files, env values and secret env", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "startup-canaries-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "nested"));
  writeFileSync(
    join(directory, "deployment.env"),
    "ANTNEST_A_TOKEN=placeholder-env-value-xxxxxxxx\nANTNEST_FLAG=true\n",
  );
  writeFileSync(
    join(directory, "nested", "service.key"),
    "-----BEGIN PLACEHOLDER KEY-----\nplaceholderKeyMaterialLine0123456789xxxx\n-----END PLACEHOLDER KEY-----\n",
  );
  const canaries = credentialCanaries(directory, {
    ANTNEST_BOOTSTRAP_ADMIN_PASSWORD: "stage3-admin-password",
    ANTNEST_EDGE_HOST_PORT: "42001",
    HOME: "/home/runner",
  });
  assert(canaries.includes("placeholder-env-value-xxxxxxxx"));
  assert(canaries.includes("placeholderKeyMaterialLine0123456789xxxx"));
  assert(canaries.includes("stage3-admin-password"));
  assert(!canaries.includes("true"));
  assert(!canaries.includes("42001"));
  assert(!canaries.includes("/home/runner"));
  assert(!canaries.includes("-----BEGIN PLACEHOLDER KEY-----"));
});
