import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { provisionTokens } from "../../../../scripts/dev-service-tokens.mjs";
import { dockerClient, scopeLabel } from "../../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const project = `antnest-deployment-credentials-${randomUUID()}`;
const evidence = resolve(
  root,
  "artifacts/verification/development-credentials",
  project,
);
const credentials = resolve(evidence, "credentials");
const probe = resolve(
  root,
  "tests/e2e/service-authentication/deployment-credentials/probe.mjs",
);
const sourceFiles = [
  "scripts/dev-service-tokens.mjs",
  "scripts/lib/private-output.mjs",
  "contracts/platform/development-authentication-contract.json",
  "tests/e2e/service-authentication/deployment-credentials/probe.mjs",
  "tests/e2e/service-authentication/deployment-credentials/run.mjs",
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
  const labels = container.Config.Labels;
  assert.equal(labels[scopeLabel], project);
  assert(
    !labels["com.docker.compose.project"] ||
      labels["com.docker.compose.project"] === project,
  );
};
try {
  assert(process.getuid() > 0, "run the private-bind probe as a nonroot user");
  const manifest = provisionTokens({
    output: credentials,
    withSkillLearning: true,
  });
  const env = parseEnv(
    readFileSync(resolve(credentials, "deployment.env"), "utf8"),
  );
  const uid = env.ANTNEST_SERVICE_AUTH_UID,
    gid = env.ANTNEST_SERVICE_AUTH_GID;
  record("sources.json", sources);
  stage = "image";
  try {
    await docker(["image", "inspect", image], true);
  } catch {
    controller.signal.throwIfAborted();
    await docker(["pull", image], true);
  }
  const args = (service, name) => {
    const mount = (source, target) => [
      "--mount",
      `type=bind,source=${source},target=${target},readonly`,
    ];
    const command = [
      "run",
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
      ...mount(
        resolve(credentials, service, "callers.json"),
        "/auth/callers.json",
      ),
      ...mount(resolve(credentials, service, "tokens"), "/auth/tokens"),
      "--env",
      `PROBE_SERVICE=${service}`,
      "--env",
      `PROBE_UID=${uid}`,
      "--env",
      `PROBE_GID=${gid}`,
      "--env",
      `PROBE_OUTGOING=${JSON.stringify(manifest.pairs.filter(({ caller }) => caller === service).map(({ receiver }) => receiver))}`,
      "--env",
      `PROBE_INCOMING=${JSON.stringify(manifest.pairs.filter(({ receiver }) => receiver === service).map(({ caller }) => caller))}`,
    ];
    if (service === "identity-service")
      command.push(
        ...mount(
          resolve(credentials, service, "cct-signing.pem"),
          "/auth/cct.pem",
        ),
        ...mount(
          resolve(credentials, service, "cct-jwks.json"),
          "/auth/jwks.json",
        ),
      );
    if (service === "runtime-controller")
      command.push(
        ...mount(
          resolve(credentials, service, "instance-master.key"),
          "/auth/master.key",
        ),
      );
    return command;
  };
  stage = "private-readonly-mounts";
  for (const service of manifest.services) {
    const output = JSON.parse(
      await docker([
        ...args(service, `${project}-${service}`),
        "--rm",
        image,
        "node",
        "/probe.mjs",
      ]),
    );
    assert.equal(output.complete, true);
    assert.equal(output.service, service);
    assert.equal(output.uid, Number(uid));
    assert.equal(output.gid, Number(gid));
    checks++;
  }
  stage = "atomic-sender-replacement";
  const tokenFile = resolve(credentials, "agent-ui/tokens/agent-controller");
  const old = readFileSync(tokenFile),
    next = randomBytes(32).toString("base64url");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const name = `${project}-rotation`;
  await docker([
    ...args("agent-ui", name),
    "-d",
    "--env",
    "PROBE_ROTATION=true",
    "--env",
    `PROBE_CURRENT_HASH=${hash(old)}`,
    "--env",
    `PROBE_NEXT_HASH=${hash(next)}`,
    image,
    "node",
    "/probe.mjs",
  ]);
  const deadline = Date.now() + 20000;
  while ((await docker(["logs", name])).split("\n")[0] !== "ready") {
    assert(Date.now() < deadline, "probe readiness timeout");
    await delay(100);
  }
  writeFileSync(`${tokenFile}.next`, next, { flag: "wx", mode: 0o600 });
  renameSync(`${tokenFile}.next`, tokenFile);
  assert.equal((await docker(["wait", name])).trim(), "0");
  const output = JSON.parse(
    (await docker(["logs", name])).trim().split("\n").at(-1),
  );
  assert.equal(output.complete, true);
  assert.equal(output.rotation_visible, true);
  const [container] = JSON.parse(await docker(["inspect", name]));
  assertOwned(container);
  assert(container.Mounts.every((mount) => !mount.RW));
  assert.equal(container.HostConfig.NetworkMode, "none");
  checks += 4;
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
    failure ??= new Error("cleanup failed");
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
    `Deployment credential Docker verification failed at ${stage}; see private evidence.`,
  );
  process.exitCode = 1;
} else console.log(JSON.stringify({ project, checks, complete, cleaned }));
