import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseEnv } from "node:util";

const root = new URL("../", import.meta.url);

test("deployment example names every service-owned database password and encryption key", async () => {
  const env = parseEnv(await readFile(new URL(".env.example", root), "utf8"));
  for (const key of [
    "ANTNEST_POSTGRES_ADMIN_PASSWORD",
    "ANTNEST_EGRESS_POSTGRES_PASSWORD",
    "ANTNEST_RUNTIME_CONTROLLER_POSTGRES_PASSWORD",
    "ANTNEST_AGENT_ACP_POSTGRES_PASSWORD",
    "ANTNEST_IDENTITY_POSTGRES_PASSWORD",
    "ANTNEST_AGENT_CONTROLLER_POSTGRES_PASSWORD",
    "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD",
    "ANTNEST_IDENTITY_ENCRYPTION_KEY",
    "ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY",
    "ANTNEST_ACP_CLIENT_MCP_KEY",
  ])
    assert(env[key], `missing deployment variable ${key}`);
  for (const key of [
    "ANTNEST_IDENTITY_ENCRYPTION_KEY",
    "ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY",
    "ANTNEST_ACP_CLIENT_MCP_KEY",
  ])
    assert.equal(Buffer.from(env[key], "base64").length, 32);
  assert.equal(
    env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    "antnest/antnest-runtime:local",
  );
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_SCOPE, env.COMPOSE_PROJECT_NAME);
  assert.equal(
    env.ANTNEST_EDGE_PUBLIC_BASE_URL,
    `http://127.0.0.1:${env.ANTNEST_EDGE_HOST_PORT}`,
  );
  assert(env.ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME);
  assert(env.ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT);
  assert.equal(
    env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT,
    "false",
    "production example must not enable body diagnostics by default",
  );
});

test("Docker context excludes local integration credentials, including nested service copies", async () => {
  const patterns = (
    await readFile(new URL(".dockerignore", root), "utf8")
  ).split(/\r?\n/);
  for (const pattern of ["**/.secret", "**/auth.json", "**/.env", "**/.env.*"])
    assert(
      patterns.includes(pattern),
      `missing credential exclusion ${pattern}`,
    );
  assert(patterns.indexOf("!**/.env.example") > patterns.indexOf("**/.env.*"));
});

test("Git excludes credential files while retaining the public configuration example", async () => {
  const patterns = (await readFile(new URL(".gitignore", root), "utf8")).split(
    /\r?\n/,
  );
  for (const pattern of [".secret", "auth.json", ".env", ".env.*"])
    assert(
      patterns.includes(pattern),
      `missing Git credential exclusion ${pattern}`,
    );
  assert(patterns.indexOf("!.env.example") > patterns.indexOf(".env.*"));
});
