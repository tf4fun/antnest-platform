import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = resolve(root, "scripts/dev-service-tokens.mjs");
const contract = JSON.parse(
  readFileSync(
    resolve(
      root,
      "contracts/platform/development-authentication-contract.json",
    ),
    "utf8",
  ),
);

async function helper() {
  assert(
    existsSync(script),
    "missing development credential provisioning helper",
  );
  return import(
    new URL("../../../scripts/dev-service-tokens.mjs", import.meta.url)
  );
}

function fixture(t) {
  const parent = resolve(
    root,
    "artifacts/verification/development-authentication",
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(parent, "case-"));
  t.after(() => {
    // A failed restrictive-umask case can leave a newly created 000 directory.
    const readable = (directory) => {
      if (!lstatSync(directory).isDirectory()) return;
      chmodSync(directory, 0o700);
      for (const name of readdirSync(directory))
        readable(join(directory, name));
    };
    readable(path);
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

function catalogs() {
  return Object.fromEntries(
    Object.entries(contract.static_services).map(([service, file]) => [
      service,
      JSON.parse(readFileSync(resolve(root, file), "utf8")),
    ]),
  );
}

function bytes(output, path) {
  return readFileSync(resolve(output, path));
}

function environment(output) {
  return parseEnv(bytes(output, "deployment.env").toString("utf8"));
}

test("fresh credentials match every static receiver grant without a global Runtime token", async (t) => {
  const { provisionTokens, deriveStaticPairs } = await helper();
  const output = join(fixture(t), "fresh");
  const manifest = provisionTokens({ output });
  const pairs = deriveStaticPairs(catalogs());
  assert.equal(pairs.length, 23);
  assert.deepEqual(manifest.pairs, pairs);
  assert.equal(manifest.version, contract.version);
  assert.equal(manifest.skill_learning, false);
  const tokens = new Set();
  for (const service of Object.keys(contract.static_services)) {
    const outgoing = pairs.filter(({ caller }) => caller === service);
    assert.deepEqual(
      readdirSync(join(output, service, "tokens")).sort(),
      outgoing.map(({ receiver }) => receiver).sort(),
    );
    const raw = bytes(output, `${service}/callers.json`);
    assert(raw.byteLength <= contract.token_provisioning.receiver_max_bytes);
    const receiver = JSON.parse(raw.toString("utf8"));
    assert.deepEqual(
      Object.keys(receiver).sort(),
      pairs
        .filter((pair) => pair.receiver === service)
        .map(({ caller }) => caller)
        .sort(),
    );
    for (const { caller } of pairs.filter(
      (pair) => pair.receiver === service,
    )) {
      const token = bytes(output, `${caller}/tokens/${service}`);
      const encoded = token.toString("ascii");
      assert.equal(token.byteLength, 43);
      assert.match(encoded, /^[A-Za-z0-9_-]{43}$/u);
      const decoded = Buffer.from(encoded, "base64url");
      assert.equal(decoded.byteLength, 32);
      assert(decoded.toString("base64url") === encoded, "noncanonical token");
      const hash = `sha256:${createHash("sha256").update(token).digest("hex")}`;
      assert(receiver[caller]?.length === 1 && receiver[caller][0] === hash);
      assert(!tokens.has(encoded), "duplicate pair credential");
      tokens.add(encoded);
      assert(!bytes(output, "manifest.json").includes(token));
      assert(!bytes(output, "deployment.env").includes(token));
    }
  }
  assert.equal(tokens.size, 23);
  assert(!existsSync(join(output, "antnest-runtime")));
  assert.deepEqual(JSON.parse(bytes(output, "edge-gateway/callers.json")), {});
});

test("generated directories and files retain private modes", async (t) => {
  const { provisionTokens } = await helper();
  const output = join(fixture(t), "private");
  provisionTokens({ output, withSkillLearning: true });
  function inspect(path) {
    const row = statSync(path);
    assert.equal(row.mode & 0o777, row.isDirectory() ? 0o700 : 0o600);
    if (row.isDirectory())
      for (const name of readdirSync(path)) inspect(join(path, name));
    else assert(row.isFile() && row.nlink === 1);
  }
  inspect(output);
});

test("bind-mount UID metadata matches the generating user without relaxing secret modes", async (t) => {
  const { provisionTokens } = await helper();
  const output = join(fixture(t), "ownership");
  provisionTokens({ output });
  const env = environment(output);
  assert.equal(
    env[contract.token_provisioning.container_uid_environment],
    String(process.getuid()),
  );
  assert.equal(
    env[contract.token_provisioning.container_gid_environment],
    String(process.getgid()),
  );
  assert.equal(statSync(join(output, "agent-ui/tokens")).uid, process.getuid());
  assert.equal(statSync(join(output, "agent-ui/tokens")).mode & 0o777, 0o700);
});

test("a restrictive inherited umask does not leave unreadable credential files", async (t) => {
  const { provisionTokens } = await helper();
  const output = join(fixture(t), "new-parent", "umask");
  const previous = process.umask(0o777);
  try {
    provisionTokens({ output });
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(
      statSync(join(output, "runtime-controller/instance-master.key")).mode &
        0o777,
      0o600,
    );
    assert.equal(
      bytes(output, "runtime-controller/instance-master.key").byteLength,
      32,
    );
  } finally {
    process.umask(previous);
  }
});

test("Identity keys sign valid Ed25519 CCTs and RC retains a separate raw master", async (t) => {
  const { provisionTokens } = await helper();
  const output = join(fixture(t), "keys");
  const manifest = provisionTokens({ output });
  const env = environment(output);
  assert.equal(env.ANTNEST_SERVICE_AUTH_DIRECTORY, output);
  const pem = bytes(output, contract.bootstrap_keys.identity_cct.private_file);
  assert(pem.byteLength <= 4096);
  assert.equal(
    (pem.toString("ascii").match(/BEGIN PRIVATE KEY/gu) ?? []).length,
    1,
  );
  const privateKey = createPrivateKey(pem);
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
  const jwks = JSON.parse(
    bytes(output, contract.bootstrap_keys.identity_cct.public_file),
  );
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].kid, env.ANTNEST_IDENTITY_CCT_SIGNING_KID);
  assert.equal(jwks.keys[0].kid, manifest.cct_kid);
  assert.deepEqual(Object.keys(jwks.keys[0]).sort(), [
    "crv",
    "kid",
    "kty",
    "x",
  ]);
  const claims = Buffer.from("independent-deployment-cct-verification");
  assert(
    verify(
      null,
      claims,
      createPublicKey({ key: jwks.keys[0], format: "jwk" }),
      sign(null, claims, privateKey),
    ),
  );
  const master = bytes(
    output,
    contract.bootstrap_keys.runtime_instance_master.file,
  );
  assert.equal(master.byteLength, 32);
  assert(!master.equals(Buffer.alloc(32)));
  assert(!pem.includes(master));
  assert(!bytes(output, "manifest.json").includes(Buffer.from("PRIVATE KEY")));
});

test("every new deployment gets independent tokens and bootstrap keys", async (t) => {
  const { provisionTokens, deriveStaticPairs } = await helper();
  const parent = fixture(t);
  const first = join(parent, "first"),
    second = join(parent, "second");
  provisionTokens({ output: first });
  provisionTokens({ output: second });
  for (const { caller, receiver } of deriveStaticPairs(catalogs()))
    assert(
      !bytes(first, `${caller}/tokens/${receiver}`).equals(
        bytes(second, `${caller}/tokens/${receiver}`),
      ),
    );
  for (const path of [
    contract.bootstrap_keys.identity_cct.private_file,
    contract.bootstrap_keys.runtime_instance_master.file,
  ])
    assert(!bytes(first, path).equals(bytes(second, path)));
  assert.notEqual(
    environment(first).ANTNEST_IDENTITY_CCT_SIGNING_KID,
    environment(second).ANTNEST_IDENTITY_CCT_SIGNING_KID,
  );
});

test("existing credentials and even an empty output directory are never overwritten", async (t) => {
  const { provisionTokens } = await helper();
  const parent = fixture(t),
    output = join(parent, "retained");
  provisionTokens({ output });
  const before = bytes(output, "runtime-controller/instance-master.key");
  assert.throws(() => provisionTokens({ output }), /output_exists/u);
  assert(
    bytes(output, "runtime-controller/instance-master.key").equals(before),
  );
  const empty = join(parent, "empty");
  mkdirSync(empty);
  assert.throws(() => provisionTokens({ output: empty }), /output_exists/u);
  assert.deepEqual(readdirSync(empty), []);
});

test("unapproved, cached and unsafe environment-file output paths fail before effects", async (t) => {
  const { provisionTokens } = await helper();
  const parent = fixture(t);
  for (const output of [
    join(root, "artifacts/unapproved-auth-output"),
    join(parent, ".cache/new"),
    join(parent, "line\nbreak"),
    join(parent, "quote'break"),
    join(parent, "variable$break"),
    "",
  ]) {
    assert.throws(() => provisionTokens({ output }), /output_invalid/u);
    if (output) assert(!existsSync(output));
  }
});

test("existing and dangling output links and linked ancestors are rejected", async (t) => {
  const { provisionTokens } = await helper();
  const parent = fixture(t),
    target = join(parent, "target");
  mkdirSync(target);
  writeFileSync(join(target, "sentinel"), "retained");
  const link = join(parent, "link"),
    dangling = join(parent, "dangling");
  symlinkSync(target, link);
  symlinkSync(join(parent, "missing"), dangling);
  for (const output of [link, dangling, join(link, "new")])
    assert.throws(
      () => provisionTokens({ output }),
      /output_(?:exists|invalid)/u,
    );
  assert.deepEqual(readdirSync(target), ["sentinel"]);
  assert(!existsSync(join(parent, "missing")));
});

test("catalog validation fails on unknown callers, wrong owners and pending adoption", async () => {
  const { deriveStaticPairs } = await helper();
  for (const change of [
    (value) => {
      delete value["runtime-egress"];
    },
    (value) => {
      value["runtime-egress"].service = "agent-controller";
    },
    (value) => {
      value["runtime-egress"].status = "planned";
    },
    (value) => {
      value["runtime-egress"].routes["POST /internal/new"] = {
        authentication: "workload",
        callers: ["unknown-workload"],
      };
    },
    (value) => {
      value["runtime-egress"].routes["POST /internal/new"] = {
        authentication: "workload",
        callers: ["antnest-runtime"],
      };
    },
    (value) => {
      value["runtime-egress"].routes["POST /internal/new"] = {
        authentication: "workload",
        callers: "agent-controller",
      };
    },
    (value) => {
      value["runtime-egress"].routes["POST /internal/new"] = {
        authentication: "unexpected",
        callers: [],
      };
    },
  ]) {
    const value = catalogs();
    change(value);
    assert.throws(() => deriveStaticPairs(value), /catalog_invalid/u);
  }
});

test("only real workload grants create pairs and repeated routes do not duplicate them", async () => {
  const { deriveStaticPairs } = await helper();
  const value = catalogs(),
    original = deriveStaticPairs(value);
  for (const authentication of ["public", "delegate", "health", "deny"])
    value["edge-gateway"].routes[`GET /${authentication}-test`] = {
      authentication,
      callers: ["identity-service"],
    };
  value["runtime-egress"].routes["POST /internal/repeated"] = {
    authentication: "workload",
    callers: ["agent-controller"],
  };
  assert.deepEqual(deriveStaticPairs(value), original);
});

test("learning is disabled by default and opt-in uses a distinct signer and matching verifier", async (t) => {
  const { provisionTokens } = await helper();
  const parent = fixture(t),
    disabled = join(parent, "disabled"),
    enabled = join(parent, "enabled");
  provisionTokens({ output: disabled });
  const absent = environment(disabled);
  for (const name of [
    "ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID",
    "ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY",
    "ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS",
  ])
    assert.equal(absent[name], "");
  const manifest = provisionTokens({
    output: enabled,
    withSkillLearning: true,
  });
  assert.equal(manifest.skill_learning, true);
  const env = environment(enabled);
  const der = Buffer.from(
    env.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY,
    "base64",
  );
  assert(
    der.toString("base64") === env.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY,
  );
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const verifier = JSON.parse(env.ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS);
  assert.equal(verifier.keys.length, 1);
  assert.equal(
    verifier.keys[0].kid,
    env.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID,
  );
  assert.equal(verifier.keys[0].algorithm, "Ed25519");
  const publicKey = createPublicKey(key).export({ format: "jwk" });
  assert(verifier.keys[0].public_key_base64url === publicKey.x);
  const issuer = JSON.parse(
    bytes(enabled, contract.bootstrap_keys.identity_cct.public_file),
  ).keys[0];
  assert(publicKey.x !== issuer.x, "CCT and maintenance must not share a key");
  assert.notEqual(verifier.keys[0].kid, issuer.kid);
  assert(
    !bytes(enabled, "manifest.json").includes(
      Buffer.from(env.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY),
    ),
  );
});

test("CLI works without npm or external binaries and prints only completion metadata", (t) => {
  const output = join(fixture(t), "cli space");
  const result = spawnSync(
    process.execPath,
    [script, "--output", output, "--with-skill-learning"],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: "", HOME: process.env.HOME },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    complete: true,
    services: 9,
    pairs: 23,
    skill_learning: true,
  });
  const manifest = JSON.parse(bytes(output, "manifest.json"));
  for (const { caller, receiver } of manifest.pairs)
    assert(
      !result.stdout.includes(
        bytes(output, `${caller}/tokens/${receiver}`).toString("ascii"),
      ),
    );
  const env = environment(output);
  assert.equal(env.ANTNEST_SERVICE_AUTH_DIRECTORY, output);
  assert(
    !result.stdout.includes(env.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY),
  );
});

test("CLI errors never include rejected option values or output paths", (t) => {
  const output = join(fixture(t), "not-created");
  for (const args of [
    ["--unknown-secret-option", "private-value"],
    ["--output", output, "--with-skill-learning=false"],
    ["--output", "private-value"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Development credential provisioning failed.\n",
    );
    assert(!existsSync(output));
  }
});

test("a partial write failure removes only newly generated output and keeps the parent", (t) => {
  const parent = fixture(t),
    output = join(parent, "failed");
  writeFileSync(join(parent, "sentinel"), "retained");
  const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original = fs.writeFileSync; let count = 0;
    fs.writeFileSync = (...args) => { if (++count === 4) throw new Error('private-failure-value'); return original(...args); };
    syncBuiltinESMExports();
    const {provisionTokens} = await import(${JSON.stringify(new URL("../../../scripts/dev-service-tokens.mjs", import.meta.url).href)});
    try { provisionTokens({output:process.argv[1]}); process.exitCode = 2; } catch { process.exitCode = 0; }`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, output],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, "");
  assert(!existsSync(output));
  assert.deepEqual(readdirSync(parent), ["sentinel"]);
});

test("a denied output parent is not altered or removed", async (t) => {
  const { provisionTokens } = await helper();
  const parent = fixture(t);
  writeFileSync(join(parent, "sentinel"), "retained");
  chmodSync(parent, 0o500);
  try {
    assert.throws(
      () => provisionTokens({ output: join(parent, "denied") }),
      /provisioning_failed/u,
    );
    assert.deepEqual(readdirSync(parent), ["sentinel"]);
  } finally {
    chmodSync(parent, 0o700);
  }
});

test("Docker CLI failure still removes private probe credentials", (t) => {
  const directory = resolve(
    root,
    "artifacts/verification/development-credentials",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const previous = new Set(readdirSync(directory));
  const result = spawnSync(
    process.execPath,
    [
      resolve(
        root,
        "tests/e2e/service-authentication/deployment-credentials/run.mjs",
      ),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, PATH: "" },
    },
  );
  const added = readdirSync(directory).filter((name) => !previous.has(name));
  t.after(() => {
    for (const name of added)
      rmSync(join(directory, name), { recursive: true, force: true });
  });
  assert.equal(result.status, 1);
  assert.equal(added.length, 1);
  const output = join(directory, added[0]);
  const report = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
  assert.equal(report.stage, "image");
  assert.equal(report.complete, false);
  assert.equal(report.credentials_cleaned, true);
  assert(!existsSync(join(output, "credentials")));
  assert(!result.stderr.includes("PRIVATE KEY"));
});
