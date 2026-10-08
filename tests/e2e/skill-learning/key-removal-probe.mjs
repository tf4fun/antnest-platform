import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// An unmatched glob leaves the pattern itself in $f; `if` keeps that case from
// becoming the script's exit status, so "no credential yet" is empty output.
const credentialFiles =
  'for f in /tmp/antnest-acp-runtime-*/*/antnest-runtime; do if [ -f "$f" ]; then cat "$f"; echo; fi; done';
const flags = new Set([
  "ANTNEST_E2E_EXPECT_OLD_TRUSTED",
  "ANTNEST_E2E_EXPECT_RUNTIME_OFFLINE",
]);

// The Runtime admits Skill maintenance only from the ACP workload, so the
// probe presents the per-connection credentials ACP holds. A recreated ACP
// regains them once Agent Controller applies its execution configuration.
export async function acpRuntimeCredentials(
  docker,
  acpContainer,
  { timeoutMs = 60_000, pollMs = 1000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tokens = (
      await docker(["exec", acpContainer, "sh", "-c", credentialFiles])
    )
      .split(/\s+/u)
      .filter(Boolean);
    if (tokens.length) return tokens;
    assert(Date.now() < deadline, "ACP holds no Runtime credential");
    await delay(pollMs);
  }
}

// The Runtime accepts only its own alias as Host; the pin keeps the probe on
// the exact container that was inspected.
export function keyRemovalArgs({
  name,
  project,
  network,
  agentId,
  runtimeIp,
  oldKey,
  nextKey,
  image,
  credentials,
  flag,
  remove = false,
}) {
  assert.match(agentId, /^agent_[a-z0-9]+$/u);
  assert(runtimeIp && oldKey && nextKey && credentials);
  if (flag !== undefined) assert(flags.has(flag), `unknown probe flag ${flag}`);
  return [
    "run",
    ...(remove ? ["--rm"] : []),
    "--name",
    name,
    "--label",
    `com.docker.compose.project=${project}`,
    "--network",
    network,
    "--add-host",
    `antnest-runtime-${agentId}:${runtimeIp}`,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--mount",
    `type=bind,src=${credentials},dst=/proof/runtime-tokens,readonly`,
    "-e",
    `ANTNEST_E2E_AGENT_ID=${agentId}`,
    "-e",
    `ANTNEST_E2E_OLD_SIGNING_KEY=${oldKey}`,
    "-e",
    `ANTNEST_E2E_NEXT_SIGNING_KEY=${nextKey}`,
    ...(flag ? ["-e", `${flag}=true`] : []),
    "-v",
    `${root}tests:/app/tests:ro`,
    image,
    "node",
    "/app/tests/e2e/skill-learning/key-removal-client.mjs",
  ];
}

export async function runKeyRemovalProbe({ docker, acpContainer, ...probe }) {
  const offline = probe.flag === "ANTNEST_E2E_EXPECT_RUNTIME_OFFLINE";
  const directory = await mkdtemp(join(tmpdir(), "antnest-key-probe-"));
  try {
    const credentials = join(directory, "runtime-tokens");
    const tokens = offline
      ? []
      : await acpRuntimeCredentials(docker, acpContainer);
    await writeFile(credentials, tokens.map((token) => `${token}\n`).join(""), {
      mode: 0o600,
      flag: "wx",
    });
    const output = await docker(
      keyRemovalArgs({ ...probe, credentials }),
      true,
    );
    return JSON.parse(output.trim().split("\n").at(-1));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
