import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { provisionPki } from "../../../../scripts/dev-pki.mjs";
import { dockerClient, scopeLabel } from "../../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const project = `antnest-development-pki-${randomUUID()}`;
const evidence = resolve(
  root,
  "artifacts/verification/development-pki",
  project,
);
const credentials = resolve(evidence, "credentials");
const probe = resolve(
  root,
  "tests/e2e/service-authentication/development-pki/probe.mjs",
);
const contract = JSON.parse(
  readFileSync(
    resolve(
      root,
      "contracts/platform/development-authentication-contract.json",
    ),
    "utf8",
  ),
);
const sourceFiles = [
  "scripts/dev-pki.mjs",
  "scripts/dev-pki.sh",
  "scripts/lib/private-output.mjs",
  "contracts/platform/development-authentication-contract.json",
  "tests/e2e/service-authentication/development-pki/probe.mjs",
  "tests/e2e/service-authentication/development-pki/run.mjs",
];
const identity = () =>
  Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(resolve(root, file)))
        .digest("hex"),
    ]),
  );
const sources = identity();
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
const timer = setTimeout(stop, 300000);
const docker = dockerClient(process.env, controller.signal, 300000);
const image = "node:24.21.0-alpine";
let checks = 0,
  complete = false,
  cleaned = false,
  credentialsCleaned = false,
  stage = "provisioning",
  failure;
const record = (name, value) =>
  writeFileSync(resolve(evidence, name), JSON.stringify(value), {
    flag: "wx",
    mode: 0o600,
  });
const assertOwned = (container) => {
  assert.equal(container.Config.Labels[scopeLabel], project);
  assert(!container.Config.Labels["com.docker.compose.project"]);
};
try {
  assert(process.getuid() > 0, "run private PKI probes as a nonroot user");
  record("sources.json", sources);
  const manifest = await provisionPki({
    output: credentials,
    signal: controller.signal,
  });
  const environment = parseEnv(
    readFileSync(resolve(credentials, "pki.env"), "utf8"),
  );
  const uid = environment.ANTNEST_SERVICE_AUTH_UID,
    gid = environment.ANTNEST_SERVICE_AUTH_GID;
  stage = "image";
  try {
    await docker(["image", "inspect", image], true);
  } catch {
    controller.signal.throwIfAborted();
    await docker(["pull", image], true);
  }
  stage = "private-mounts-and-loopback-tls";
  for (const service of manifest.services) {
    const name = `${project}-${service}`;
    const mount = (source, target) => [
      "--mount",
      `type=bind,source=${source},target=${target},readonly`,
    ];
    await docker([
      "create",
      "--name",
      name,
      "--label",
      `${scopeLabel}=${project}`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${uid}:${gid}`,
      ...mount(probe, "/probe.mjs"),
      ...mount(resolve(credentials, "ca.pem"), "/tls/ca.pem"),
      ...mount(resolve(credentials, service, "cert.pem"), "/tls/cert.pem"),
      ...mount(resolve(credentials, service, "key.pem"), "/tls/key.pem"),
      "--env",
      `PROBE_SERVICE=${service}`,
      "--env",
      `PROBE_UID=${uid}`,
      "--env",
      `PROBE_GID=${gid}`,
      "--env",
      `PROBE_DNS_NAMES=${JSON.stringify([service, ...(contract.development_pki.leaf.dns_aliases[service] ?? [])])}`,
      image,
      "node",
      "/probe.mjs",
    ]);
    const [container] = JSON.parse(await docker(["inspect", name]));
    assertOwned(container);
    assert.equal(container.Config.User, `${uid}:${gid}`);
    assert.equal(container.HostConfig.NetworkMode, "none");
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]);
    assert(container.HostConfig.SecurityOpt.includes("no-new-privileges"));
    assert(
      !container.HostConfig.PortBindings ||
        Object.keys(container.HostConfig.PortBindings).length === 0,
    );
    assert.deepEqual(
      container.Mounts.map(({ Destination }) => Destination).sort(),
      ["/probe.mjs", "/tls/ca.pem", "/tls/cert.pem", "/tls/key.pem"],
    );
    assert(container.Mounts.every((mount) => !mount.RW));
    checks++;
    const result = JSON.parse(await docker(["start", "-a", name], true));
    assert.equal(result.complete, true);
    assert.equal(result.service, service);
    assert.equal(result.uid, Number(uid));
    assert.equal(result.gid, Number(gid));
    const [finished] = JSON.parse(await docker(["inspect", name]));
    assertOwned(finished);
    assert.equal(finished.State.Running, false);
    assert.equal(finished.State.ExitCode, 0);
    checks++;
    await docker(["rm", name]);
  }
  stage = "source-integrity";
  assert.deepEqual(identity(), sources);
  complete = true;
} catch (error) {
  failure = error;
} finally {
  clearTimeout(timer);
  const cleanup = dockerClient(process.env, undefined, 120000);
  try {
    const ids = (
      await cleanup(["ps", "-aq", "--filter", `label=${scopeLabel}=${project}`])
    )
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of ids) {
      const [container] = JSON.parse(await cleanup(["inspect", id]));
      assertOwned(container);
      await cleanup(["rm", "-f", id], true);
    }
    assert.equal(
      await cleanup([
        "ps",
        "-aq",
        "--filter",
        `label=${scopeLabel}=${project}`,
      ]),
      "",
    );
    cleaned = true;
  } catch {
    failure ??= new Error("container cleanup failed");
  }
  try {
    rmSync(credentials, { recursive: true, force: true });
    credentialsCleaned = true;
  } catch {
    failure ??= new Error("credential cleanup failed");
  }
  cleaned &&= credentialsCleaned;
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  record("result.json", {
    project,
    stage,
    checks,
    complete,
    cleaned,
    credentials_cleaned: credentialsCleaned,
  });
}
if (failure) {
  console.error(
    `Development PKI Docker verification failed at ${stage}; see private evidence.`,
  );
  process.exitCode = 1;
} else console.log(JSON.stringify({ project, checks, complete, cleaned }));
