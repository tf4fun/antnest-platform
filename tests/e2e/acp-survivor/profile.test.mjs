import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
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
import { prepareSurvivorProfile } from "./profile.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function withFixture(work) {
  const parent = resolve(root, "artifacts/verification/authenticated-e2e");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const project = `antnest-lifecycle-${randomBytes(4).toString("hex")}`;
  const directory = join(parent, project);
  // An exclusive mkdir limits finally cleanup to this test's own project.
  mkdirSync(directory, { mode: 0o700 });
  try {
    const credentials = join(directory, "credentials");
    mkdirSync(credentials, { mode: 0o700 });
    const config = {
      project,
      credentials,
      env: {
        ANTNEST_SERVICE_NETWORK_PREFIX: "10.244.73",
        ANTNEST_SERVICE_AUTH_UID: String(process.getuid()),
        ANTNEST_SERVICE_AUTH_GID: String(process.getgid()),
        RETAINED_FIXTURE_VALUE: "unchanged",
      },
    };
    await work({ config, credentials, directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertPrivateDirectory(path) {
  const row = lstatSync(path);
  assert.equal(row.isDirectory() && !row.isSymbolicLink(), true);
  assert.equal(row.mode & 0o777, 0o700);
  assert.equal(row.uid, process.getuid());
}

function assertPrivateFile(path) {
  const row = lstatSync(path);
  assert.equal(row.isFile() && !row.isSymbolicLink(), true);
  assert.equal(row.mode & 0o777, 0o600);
  assert.equal(row.uid, process.getuid());
}

for (const octet of [1, 200]) {
  test(`survivor profile writes exact private A/B catalogs and directional credentials at octet ${octet}`, async () => {
    await withFixture(async ({ config, credentials }) => {
      const prefix = `10.244.${octet}`;
      config.env.ANTNEST_SERVICE_NETWORK_PREFIX = prefix;
      const originalEnvironment = structuredClone(config.env);
      await prepareSurvivorProfile(config);
      const membersFile = join(credentials, "acp-members.json");
      const a = join(credentials, "peer-a");
      const b = join(credentials, "peer-b");
      assert.equal(config.env.ANTNEST_E2E_ACP_MEMBERS_FILE, membersFile);
      assert.equal(config.env.ANTNEST_E2E_ACP_PEER_A_DIRECTORY, a);
      assert.equal(config.env.ANTNEST_E2E_ACP_PEER_B_DIRECTORY, b);
      assert.equal(
        config.env.ANTNEST_E2E_ACP_PEER_B_MANAGEMENT_IPV4,
        `10.243.${octet}.7`,
      );
      for (const [key, value] of Object.entries(originalEnvironment))
        assert.equal(config.env[key], value);

      assert.deepEqual(JSON.parse(readFileSync(membersFile, "utf8")), {
        version: 1,
        members: [
          {
            member_id: "acp-a",
            container_selector: `${config.project}-agent-acp-service-1`,
            network: `${config.project}_controller-runtime`,
            probe_origin: "http://agent-acp-service:8085",
          },
          {
            member_id: "acp-b",
            container_selector: `${config.project}-agent-acp-peer-b-1`,
            network: `${config.project}_controller-runtime`,
            probe_origin: "http://agent-acp-peer-b:8085",
          },
        ],
      });
      const aMembership = readFileSync(join(a, "membership.json"));
      const bMembership = readFileSync(join(b, "membership.json"));
      assert.deepEqual(aMembership, bMembership);
      const membership = JSON.parse(aMembership.toString("utf8"));
      assert.match(
        membership.cluster_id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      assert.deepEqual(membership, {
        version: 1,
        cluster_id: membership.cluster_id,
        members: [
          { member_id: "acp-a", origin: `http://${prefix}.53:8083` },
          { member_id: "acp-b", origin: `http://${prefix}.54:8083` },
        ],
      });

      const aToB = readFileSync(join(a, "tokens", "acp-b"), "ascii");
      const bToA = readFileSync(join(b, "tokens", "acp-a"), "ascii");
      for (const token of [aToB, bToA]) {
        assert.equal(
          /^[A-Za-z0-9_-]{43}$/u.test(token),
          true,
          "Member token must be newline-free base64url",
        );
        assert.equal(Buffer.from(token, "base64url").byteLength, 32);
        assert.equal(
          Buffer.from(token, "base64url").toString("base64url") === token,
          true,
        );
      }
      assert.equal(
        aToB === bToA,
        false,
        "Opposite member directions need independent tokens",
      );
      const digest = (token) =>
        `sha256:${createHash("sha256").update(token, "ascii").digest("hex")}`;
      assert.deepEqual(
        JSON.parse(readFileSync(join(a, "callers.json"), "utf8")),
        {
          "acp-b": [digest(bToA)],
        },
      );
      assert.deepEqual(
        JSON.parse(readFileSync(join(b, "callers.json"), "utf8")),
        {
          "acp-a": [digest(aToB)],
        },
      );
      assert.deepEqual(readdirSync(join(a, "tokens")), ["acp-b"]);
      assert.deepEqual(readdirSync(join(b, "tokens")), ["acp-a"]);
      assert.deepEqual(readdirSync(credentials).sort(), [
        "acp-members.json",
        "peer-a",
        "peer-b",
      ]);
      assert.equal(existsSync(join(credentials, "agent-acp-service")), false);
      for (const peer of [a, b])
        assert.deepEqual(readdirSync(peer).sort(), [
          "callers.json",
          "membership.json",
          "tokens",
        ]);

      for (const directory of [
        credentials,
        a,
        b,
        join(a, "tokens"),
        join(b, "tokens"),
      ])
        assertPrivateDirectory(directory);
      for (const file of [
        membersFile,
        join(a, "membership.json"),
        join(b, "membership.json"),
        join(a, "callers.json"),
        join(b, "callers.json"),
        join(a, "tokens", "acp-b"),
        join(b, "tokens", "acp-a"),
      ])
        assertPrivateFile(file);
    });
  });
}

for (const [name, change] of [
  [
    "foreign project",
    ({ config }) => {
      config.project = "foreign-project";
    },
  ],
  [
    "mismatched valid project",
    ({ config }) => {
      config.project = `antnest-lifecycle-${config.project.endsWith("00000000") ? "11111111" : "00000000"}`;
    },
  ],
  [
    "different UID",
    ({ config }) => {
      config.env.ANTNEST_SERVICE_AUTH_UID = String(process.getuid() + 1);
    },
  ],
  [
    "missing UID",
    ({ config }) => {
      delete config.env.ANTNEST_SERVICE_AUTH_UID;
    },
  ],
]) {
  test(`survivor profile rejects ${name} before creating files or publishing environment`, async () => {
    await withFixture(async (fixture) => {
      change(fixture);
      const { config, directory } = fixture;
      const original = structuredClone(config);
      const files = readdirSync(directory, { recursive: true }).sort();
      await assert.rejects(
        Promise.resolve().then(() => prepareSurvivorProfile(config)),
      );
      assert.deepEqual(config, original);
      assert.deepEqual(
        readdirSync(directory, { recursive: true }).sort(),
        files,
      );
    });
  });
}

test("survivor profile rejects a symlink credentials directory without touching its target", async () => {
  await withFixture(async ({ config, credentials, directory }) => {
    const target = join(directory, "retained-credentials");
    mkdirSync(target, { mode: 0o700 });
    const retainedFile = join(target, "retained.json");
    const retained = '{"retained":"fixture"}\n';
    writeFileSync(retainedFile, retained, { flag: "wx", mode: 0o600 });
    rmSync(credentials, { recursive: true });
    symlinkSync(target, credentials, "dir");
    const original = structuredClone(config);
    const metadata = statSync(retainedFile, { bigint: true });
    const files = readdirSync(directory, { recursive: true }).sort();
    await assert.rejects(
      Promise.resolve().then(() => prepareSurvivorProfile(config)),
    );
    assert.deepEqual(config, original);
    assert.equal(lstatSync(credentials).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(directory, { recursive: true }).sort(), files);
    assert.deepEqual(readdirSync(target), ["retained.json"]);
    assert.equal(readFileSync(retainedFile, "utf8"), retained);
    const after = statSync(retainedFile, { bigint: true });
    assert.equal(after.ino, metadata.ino);
    assert.equal(after.mtimeNs, metadata.mtimeNs);
    assert.equal(after.mode & 0o777n, 0o600n);
  });
});
