// Docker E2E for the default (release) Runtime image: no test features, only
// the signed `install` and `digest` maintenance actions, atomic renames on the
// workspace volume, and dual-key trust with old-key removal.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeReceiver,
  freeLoopbackPort,
  installRuntimeReceiver,
} from "../../support/runtime-receiver-fixture.mjs";

const image =
  process.env.ANTNEST_RUNTIME_TEST_IMAGE ??
  "antnest/antnest-runtime:skill-learning-local";
const buildImage =
  process.env.ANTNEST_RUNTIME_BUILD_IMAGE ??
  "antnest/antnest-runtime:skill-learning-build";
const prefix = `antnest-skill-release-${process.pid}`;
const network = `${prefix}-network`;
const egress = `${prefix}-egress`;
const runtime = `${prefix}-runtime`;
const fixtureSource = `${prefix}-fixture-source`;
const volume = `${prefix}-workspace`;
const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
chmodSync(directory, 0o755);
const authVolume = `${prefix}-receiver`;
const helperImage = `${prefix}:readiness`;
const authDirectory = join(directory, "auth");
const authentication = createRuntimeReceiver(authDirectory);
// The ACP credential is admitted on every Runtime route this runner uses.
const serviceToken = readFileSync(join(authDirectory, "mcp.headers"), "utf8")
  .trim()
  .replace(/^Antnest-Service-Authorization: /, "");
function runtimeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { "Antnest-Service-Authorization": serviceToken, ...init.headers },
  });
}

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function cleanup() {
  for (const name of [runtime, egress, fixtureSource]) {
    try {
      docker("rm", "-f", "--volumes", name);
    } catch {
      /* absent */
    }
  }
  try {
    docker("volume", "rm", volume, authVolume);
  } catch {
    /* absent */
  }
  try {
    docker("network", "rm", network);
  } catch {
    /* absent */
  }
  try {
    docker("image", "rm", helperImage);
  } catch {
    /* helper was not built */
  }
  rmSync(directory, { recursive: true, force: true });
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}
function label(bytes) {
  return `sha256:${sha256(bytes).toString("hex")}`;
}
function targetDigest(path, contents) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(contents.length));
  const pathSize = Buffer.alloc(4);
  pathSize.writeUInt32BE(Buffer.byteLength(path));
  return label(
    Buffer.concat([
      Buffer.from("antnest-skill-manifest-v1\0"),
      pathSize,
      Buffer.from(path),
      size,
      sha256(contents),
      Buffer.from([0]),
    ]),
  );
}
function makeZip(contents) {
  const source = join(directory, "package");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), contents);
  const archive = join(directory, "skill.zip");
  execFileSync("python3", [
    "-c",
    `
import sys, zipfile
item = zipfile.ZipInfo('SKILL.md')
item.create_system = 3
item.external_attr = 0o100644 << 16
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_STORED) as z:
    z.writestr(item, open(sys.argv[2], 'rb').read())
`,
    archive,
    join(source, "SKILL.md"),
  ]);
  return readFileSync(archive);
}
function signed(
  privateKey,
  body,
  executionId,
  action,
  requestId,
  jobId = "job-1",
  generation = 1,
  kid = "key-1",
) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ version: 1, algorithm: "Ed25519", kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      organization_id: "org-1",
      agent_id: "agent-1",
      execution_id: executionId,
      job_id: jobId,
      generation,
      action,
      request_id: requestId,
      body_sha256: label(body),
      issued_at: now,
      expires_at: now + 60,
    }),
  ).toString("base64url");
  const message = Buffer.from(
    `antnest-skill-maintenance-v1\n${header}.${payload}`,
  );
  const signature = sign(null, message, privateKey).toString("base64url");
  return `AntnestMaintenance ${header}.${payload}.${signature}`;
}
function multipart(metadata, artifact) {
  return Buffer.concat([
    Buffer.from(
      '--skill-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n',
    ),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(
      '\r\n--skill-boundary\r\nContent-Disposition: form-data; name="artifact"\r\n\r\n',
    ),
    artifact,
    Buffer.from("\r\n--skill-boundary--\r\n"),
  ]);
}
async function ready(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await runtimeFetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) {
        const status = await response.json();
        if (status.status === "ready") return status;
      }
    } catch {
      /* startup */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Runtime did not become ready: ${docker("logs", runtime)}`);
}

try {
  const [releaseImage] = JSON.parse(docker("image", "inspect", image));
  assert.equal(
    releaseImage.Config.Labels["dev.antnest.runtime.test-features"],
    "",
  );
  assert(
    !releaseImage.Config.Env.some((value) =>
      value.startsWith("ANTNEST_RUNTIME_ALLOW_TEST_FEATURES="),
    ),
    "release images must not opt in to test features",
  );
  docker("create", "--name", fixtureSource, buildImage, "/bin/true");
  const managedFixture = join(directory, "managed-mcp-fixture");
  docker("cp", `${fixtureSource}:/tmp/managed-mcp-fixture`, managedFixture);
  chmodSync(managedFixture, 0o755);
  docker("rm", "-f", "--volumes", fixtureSource);
  docker("network", "create", network);
  docker("volume", "create", volume);
  docker(
    "build",
    "-f",
    "tests/support/runtime-tunnel/Dockerfile",
    "-t",
    helperImage,
    ".",
  );
  await installRuntimeReceiver(
    (args) => docker(...args),
    image,
    authVolume,
    authDirectory,
  );
  docker(
    "run",
    "-d",
    "--name",
    egress,
    "--network",
    network,
    "--mount",
    `type=bind,src=${authDirectory}/egress-tunnel.json,dst=/fixture/keys.json,readonly`,
    helperImage,
    "/fixture/keys.json",
  );
  const egressIp = JSON.parse(docker("inspect", egress))[0].NetworkSettings
    .Networks[network].IPAddress;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { publicKey: nextPublicKey, privateKey: nextPrivateKey } =
    generateKeyPairSync("ed25519");
  const publicBytes = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const nextPublicBytes = nextPublicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const listenPort = await freeLoopbackPort();
  const spec = {
    authentication,
    agent_id: "agent-1",
    generation: 1,
    listen: { host: "0.0.0.0", port: listenPort },
    network: {
      packet_contract_revision: 2,
      egress_endpoint: { ipv4: egressIp, port: 8092 },
      tunnel_ipv4: "100.64.0.2",
      resolver_ipv4: "100.64.0.1",
    },
    filesystem: { workspace: "/workspace", system_skills: "/skills" },
    mcp_servers: [{ id: "learning", command: "/opt/managed-mcp-fixture" }],
    skill_maintenance_verifiers: {
      keys: [
        {
          kid: "key-1",
          algorithm: "Ed25519",
          public_key_base64url: publicBytes.toString("base64url"),
        },
        {
          kid: "key-2",
          algorithm: "Ed25519",
          public_key_base64url: nextPublicBytes.toString("base64url"),
        },
      ],
    },
  };
  const startRuntime = (runtimeSpec) => {
    docker(
      "run",
      "-d",
      "--name",
      runtime,
      "--network",
      network,
      "--cap-drop",
      "ALL",
      "--device",
      "/dev/net/tun",
      "--dns",
      "100.64.0.1",
      "--dns-option",
      "use-vc",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--mount",
      `type=bind,src=${managedFixture},dst=/opt/managed-mcp-fixture,readonly`,
      // Mirrors the private managed MCP HOME tmpfs Runtime Controller creates.
      "--tmpfs",
      "/run/antnest-mcp-home:rw,exec,nosuid,nodev,size=67108864,mode=0711,uid=0,gid=0",
      "-p",
      `127.0.0.1:${listenPort}:${listenPort}`,
      "--mount",
      `type=volume,src=${authVolume},dst=/run/antnest-auth,readonly`,
      "-e",
      `ANTNEST_RUNTIME_SPEC=${JSON.stringify(runtimeSpec)}`,
      "-e",
      "ANTNEST_SERVICE_AUTH_MODE=token",
      "-e",
      "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true",
      "-e",
      `ANTNEST_SERVICE_AUTH_CALLERS_FILE=${authentication.callers_file}`,
      "-e",
      "OTEL_SDK_DISABLED=true",
      ...[
        "CHOWN",
        "DAC_OVERRIDE",
        "KILL",
        "NET_ADMIN",
        "SETGID",
        "SETPCAP",
        "SETUID",
      ].flatMap((capability) => ["--cap-add", capability]),
      image,
    );
    return JSON.parse(docker("inspect", runtime))[0].NetworkSettings.Ports[
      `${listenPort}/tcp`
    ][0].HostPort;
  };
  let port = startRuntime(spec);
  const status = await ready(port);
  assert.deepEqual(status.test_features, []);
  const removedRevert = await runtimeFetch(
    `http://127.0.0.1:${port}/internal/skill-maintenance/revert`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(removedRevert.status, 404);
  const atomicFlags = `
import ctypes, os, pathlib, shutil
root = pathlib.Path('/workspace/.antnest/skill-learning/atomic-volume-probe')
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True)
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
def rename(source, target, flag):
    result = renameat2(-100, os.fsencode(source), -100, os.fsencode(target), flag)
    if result != 0:
        raise OSError(ctypes.get_errno(), 'renameat2 failed')
try:
    first, second = root / 'first', root / 'second'
    first.mkdir(); (first / 'version').write_text('first')
    rename(first, second, 1)
    assert not first.exists() and (second / 'version').read_text() == 'first'
    first.mkdir(); (first / 'version').write_text('second')
    try:
        rename(first, second, 1)
        raise AssertionError('RENAME_NOREPLACE overwrote an existing directory')
    except FileExistsError:
        pass
    rename(first, second, 2)
    assert (first / 'version').read_text() == 'first'
    assert (second / 'version').read_text() == 'second'
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
finally:
    shutil.rmtree(root)
`;
  docker("exec", "--user", "1000:1000", runtime, "python3", "-c", atomicFlags);
  const contents = Buffer.from(
    "---\nname: retry-timeouts\ndescription: Retry safely\n---\n",
  );
  const artifact = makeZip(contents);
  const packagePath = ".antnest/skills/retry-timeouts";
  const target = targetDigest("SKILL.md", contents);
  const post = (
    executionId,
    action,
    request,
    { signingKey = privateKey, kid = "key-1", upload } = {},
  ) => {
    const body = upload
      ? multipart(request, upload)
      : Buffer.from(JSON.stringify(request));
    return runtimeFetch(
      `http://127.0.0.1:${port}/internal/skill-maintenance/${action}`,
      {
        method: "POST",
        headers: {
          Authorization: signed(
            signingKey,
            body,
            executionId,
            action,
            request.request_id,
            request.job_id,
            request.generation,
            kid,
          ),
          "Content-Type": upload
            ? "multipart/form-data; boundary=skill-boundary"
            : "application/json",
          "X-Antnest-Expected-Execution-ID": executionId,
        },
        body,
      },
    );
  };
  const request = (action, requestId, fields = {}) => ({
    action,
    request_id: requestId,
    job_id: "job-1",
    generation: 1,
    ...fields,
  });

  // The transaction actions are gone from the release image: a correctly
  // signed request for any of them is an unknown action, not a parse error.
  for (const action of [
    "prepare",
    "check",
    "commit",
    "observe",
    "cancel",
    "release",
  ]) {
    const response = await post(
      status.execution_id,
      action,
      request(action, `retired-${action}`),
    );
    const text = await response.text();
    assert.equal(response.status, 404, `${action}: ${text}`);
    assert.equal(JSON.parse(text).error.code, "unknown_action", action);
  }

  const install = request("install", "install-1", {
    package_path: packagePath,
    expected_base_digest: null,
    target_digest: target,
    artifact_digest: label(artifact),
    package_rules_version: 1,
  });
  const unknownKid = await post(status.execution_id, "install", install, {
    signingKey: nextPrivateKey,
    kid: "unknown-key",
    upload: artifact,
  });
  assert.equal(unknownKid.status, 401, await unknownKid.clone().text());
  const applied = await post(status.execution_id, "install", install, {
    signingKey: nextPrivateKey,
    kid: "key-2",
    upload: artifact,
  });
  const appliedReceipt = await applied.json();
  assert.equal(applied.status, 200, JSON.stringify(appliedReceipt));
  assert.equal(appliedReceipt.outcome, "applied");
  assert.equal(appliedReceipt.observed_digest, target);
  assert.equal(
    docker(
      "exec",
      runtime,
      "stat",
      "-c",
      "%u:%g",
      `/workspace/${packagePath}/SKILL.md`,
    ),
    "1000:1000",
  );
  const digestRequest = (requestId) =>
    request("digest", requestId, { package_path: packagePath });
  const observed = await post(
    status.execution_id,
    "digest",
    digestRequest("digest-1"),
  );
  const observedReceipt = await observed.json();
  assert.equal(observed.status, 200, JSON.stringify(observedReceipt));
  assert.equal(observedReceipt.outcome, "observed");
  assert.equal(observedReceipt.observed_digest, target);

  docker("rm", "-f", "--volumes", runtime);
  port = startRuntime({
    ...spec,
    skill_maintenance_verifiers: {
      keys: [spec.skill_maintenance_verifiers.keys[1]],
    },
  });
  const reducedTrust = await ready(port);
  assert.notEqual(reducedTrust.execution_id, status.execution_id);
  const removedKey = await post(
    reducedTrust.execution_id,
    "digest",
    digestRequest("digest-after-removal-1"),
  );
  assert.equal(removedKey.status, 401, await removedKey.clone().text());
  const retainedKey = await post(
    reducedTrust.execution_id,
    "digest",
    digestRequest("digest-after-removal-2"),
    { signingKey: nextPrivateKey, kid: "key-2" },
  );
  const retainedReceipt = await retainedKey.json();
  assert.equal(retainedKey.status, 200, JSON.stringify(retainedReceipt));
  assert.equal(retainedReceipt.outcome, "observed");
  assert.equal(
    retainedReceipt.observed_digest,
    target,
    "the installed Skill must survive a Runtime replacement",
  );
  console.log(
    "Release Runtime image: no test features, retired transaction actions unknown, atomic volume renames, install/digest over dual-key trust and old-key removal: passed",
  );
} finally {
  cleanup();
}
